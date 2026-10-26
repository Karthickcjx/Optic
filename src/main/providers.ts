import { CostReports } from './cost-report';
import type { ClusterManager } from './clusters';
import { kubeJson } from './kube-http';
import { AppError } from './errors';
import type { ServiceEndpoint, CostResult } from '../shared/cluster-settings';
import type { Resource } from '../shared/protocol';

export function serviceProxy(endpoint: ServiceEndpoint) {
  return `/api/v1/namespaces/${encodeURIComponent(endpoint.namespace)}/services/${encodeURIComponent(`${endpoint.service}:${endpoint.port}`)}/proxy`;
}
export class Providers {
  constructor(private clusters: ClusterManager) {}
  async discover(id: string, pattern: RegExp): Promise<ServiceEndpoint[]> {
    const response = await kubeJson<{ items: Resource[] }>(this.clusters.get(id).config, '/api/v1/services');
    return response.items.filter(s => pattern.test(`${s.metadata.name} ${Object.values(s.metadata.labels ?? {}).join(' ')}`)).flatMap(s => (s.spec?.ports ?? []).filter((p: any) => p.protocol !== 'UDP').map((p: any) => ({ namespace: s.metadata.namespace!, service: s.metadata.name!, port: p.port })));
  }
  async prometheus(id: string) {
    const settings = this.clusters.settings(id), config = this.clusters.get(id).config;
    const candidates = settings.prometheus.service ? [settings.prometheus] : await this.discover(id, /prometheus/i);
    for (const endpoint of candidates.slice(0, 8)) {
      try {
        const query = async (expression: string) => {
          const response = await kubeJson<any>(config, `${serviceProxy(endpoint)}/api/v1/query?${new URLSearchParams({ query: expression })}`);
          if (response.status !== 'success' || !Array.isArray(response.data?.result)) throw new Error('Invalid Prometheus response');
          return response.data.result as { metric: Record<string, string>; value: [number, string] }[];
        };
        const [cpu, memory] = await Promise.all([query('sum by (node, instance) (rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m]))'), query('sum by (node, instance) (container_memory_working_set_bytes{container!="",container!="POD"})')]);
        if (!cpu.length || !memory.length) continue;
        const nodes = new Map<string, Resource>();
        for (const [key, series] of [['cpu', cpu], ['memory', memory]] as const) for (const sample of series) {
          const name = sample.metric.node || sample.metric.instance || 'cluster'; const value = Number(sample.value[1]);
          if (!Number.isFinite(value) || value < 0) continue;
          const item = nodes.get(name) ?? { metadata: { name }, usage: {} }; item.usage[key] = String(value); nodes.set(name, item);
        }
        if (!nodes.size) continue;
        return { nodes: [...nodes.values()], pods: [] as Resource[], source: `Prometheus (${endpoint.namespace}/${endpoint.service})` };
      } catch { /* Try the next discovered service; raw upstream responses may contain credentials. */ }
    }
    throw new AppError('METRICS_UNAVAILABLE', 'No readable Prometheus service with container CPU/memory series was found. Configure the service and check services/proxy RBAC and scrape targets.');
  }
  async cost(id: string): Promise<CostResult> {
    const end = Date.now();
    const report = await new CostReports(this.clusters).read({ clusterId: id, start: end - 86400000, end, group: 'namespace', includeIdle: true });
    return { source: report.source, currency: report.currency, total: report.total, window: '24h', allocations: report.allocations.map(a => ({ name: a.name, cost: a.total })), warning: [...(report.notes ?? []), ...report.warnings].join(' ') };
  }
}
