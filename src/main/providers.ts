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
        const [cpu, memory] = await Promise.all([query('sum by (node) (rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m]))'), query('sum by (node) (container_memory_working_set_bytes{container!="",container!="POD"})')]);
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
    const settings = this.clusters.settings(id), config = this.clusters.get(id).config;
    const empty = { currency: 'USD', total: 0, window: '24h', allocations: [] };
    if (settings.costSource === 'off') return { ...empty, source: 'off', warning: 'Cost monitoring is disabled.' };
    if (settings.costSource === 'estimate') {
      if (!settings.estimatedNodeHourlyCost) return { ...empty, source: 'estimate', warning: 'Set a per-node hourly USD rate to calculate an estimate.' };
      const nodes = await kubeJson<{ items: Resource[] }>(config, '/api/v1/nodes');
      const allocations = nodes.items.map(n => ({ name: n.metadata.name!, cost: settings.estimatedNodeHourlyCost * 24 }));
      return { ...empty, allocations, total: allocations.reduce((sum, row) => sum + row.cost, 0), source: 'estimate', warning: 'Projection using your uniform per-node rate and current node count; excludes storage/network and is not a billing figure.' };
    }
    const candidates = settings.costEndpoint.service ? [settings.costEndpoint] : await this.discover(id, settings.costSource === 'automatic' ? /opencost|kubecost|cost-analyzer/i : settings.costSource === 'kubecost' ? /kubecost|cost-analyzer/i : /opencost/i);
    for (const endpoint of candidates.slice(0, 8)) {
      try {
        const response = await kubeJson<any>(config, `${serviceProxy(endpoint)}/allocation?window=24h&aggregate=namespace&accumulate=true`);
        if (!Array.isArray(response.data)) continue;
        const totals = new Map<string, number>();
        for (const set of response.data) for (const [name, row] of Object.entries(set ?? {})) {
          const cost = Number((row as any).totalCost); if (Number.isFinite(cost)) totals.set(name, (totals.get(name) ?? 0) + cost);
        }
        const allocations = [...totals].map(([name, cost]) => ({ name, cost }));
        return { ...empty, source: `${endpoint.namespace}/${endpoint.service}`, allocations, total: allocations.reduce((sum, row) => sum + row.cost, 0) };
      } catch {}
    }
    return { ...empty, source: settings.costSource, warning: 'No readable OpenCost-compatible allocation API found. Configure a service, check services/proxy access, or select Estimate.' };
  }
}
