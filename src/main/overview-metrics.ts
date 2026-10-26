import type { ClusterManager } from './clusters';
import type { Resource } from '../shared/protocol';
import type { OverviewHistory } from '../shared/metrics';
import type { ServiceEndpoint } from '../shared/cluster-settings';
import { Providers, serviceProxy } from './providers';
import { kubeJson } from './kube-http';
import { AppError } from './errors';

export const overviewQueries = {
  cpu: 'sum by (node, instance) (max by (node, instance, namespace, pod, container) (rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m])))',
  memory: 'sum by (node, instance) (max by (node, instance, namespace, pod, container) (container_memory_working_set_bytes{container!="",container!="POD"}))'
};

export function overviewSamples(responses: { key: 'cpu' | 'memory'; response: any }[], start: number, end: number) {
  const times = new Map<number, Map<string, Resource>>();
  for (const { key, response } of responses) {
    if (response?.status !== 'success' || response.data?.resultType !== 'matrix' || !Array.isArray(response.data.result)) throw new AppError('METRICS_RESPONSE', 'Prometheus returned an invalid history response.');
    if (response.data.result.length > 500) throw new AppError('METRICS_LIMIT', 'Overview history supports up to 500 node series per metric.');
    for (const row of response.data.result) {
      const name = row.metric?.node || row.metric?.instance;
      if (typeof name !== 'string' || !name || !Array.isArray(row.values)) continue;
      if (row.values.length > 300) throw new AppError('METRICS_LIMIT', 'Prometheus returned too many history points.');
      for (const pair of row.values) {
        if (!Array.isArray(pair) || pair.length !== 2 || pair[1] === '' || pair[1] === null) continue;
        const time = Number(pair[0]) * 1000, value = Number(pair[1]);
        if (!Number.isFinite(time) || time < start || time > end || !Number.isFinite(value) || value < 0) continue;
        const nodes = times.get(time) ?? new Map<string, Resource>();
        const node = nodes.get(name) ?? { metadata: { name }, usage: {} };
        // Repeated scrape targets carrying the same node identity must not double usage.
        node.usage[key] = String(Math.max(Number(node.usage[key] ?? 0), value));
        nodes.set(name, node); times.set(time, nodes);
      }
    }
  }
  return [...times].sort(([a], [b]) => a - b).map(([time, nodes]) => ({ time, nodes: [...nodes.values()] }));
}

export class OverviewMetrics {
  private endpoints = new Map<string, { endpoint: ServiceEndpoint; expires: number }>();
  constructor(private clusters: ClusterManager) {}
  async read(clusterId: string, minutes: number): Promise<OverviewHistory> {
    const settings = this.clusters.settings(clusterId);
    const step = Math.max(15, Math.ceil(minutes * 60 / 240));
    const end = Math.floor(Date.now() / 1000 / step) * step * 1000, start = end - minutes * 60000;
    const empty: OverviewHistory = { history: false, source: 'none', start, end, step: step * 1000, samples: [] };
    if (settings.metricsSource === 'none' || settings.hiddenMetrics.includes('Cluster')) return { ...empty, warning: 'Cluster metrics are hidden or disabled.' };
    if (settings.metricsSource === 'metrics-server') return { ...empty, source: 'metrics-server', warning: 'Metrics Server has no historical data. Showing samples collected while this overview is open.' };
    const config = this.clusters.get(clusterId).config;
    const key = JSON.stringify([clusterId, settings.prometheus]);
    const cached = this.endpoints.get(key);
    let endpoints: ServiceEndpoint[];
    try {
      endpoints = settings.prometheus.service ? [settings.prometheus] : cached && cached.expires > Date.now() ? [cached.endpoint] : (await new Providers(this.clusters).discover(clusterId, /prometheus/i)).slice(0, 3);
    } catch { return { ...empty, warning: 'Prometheus history discovery failed. Check cluster connectivity and services RBAC. Showing locally observed samples.' }; }
    for (const endpoint of endpoints) {
      const rows = await Promise.allSettled((['cpu', 'memory'] as const).map(async metric => {
        const params = new URLSearchParams({ query: overviewQueries[metric], start: String(start / 1000), end: String(end / 1000), step: String(step), timeout: '10s' });
        const response = await kubeJson(config, `${serviceProxy(endpoint)}/api/v1/query_range?${params}`);
        return { metric, samples: overviewSamples([{ key: metric, response }], start, end), warned: Array.isArray(response.warnings) && response.warnings.length > 0 };
      }));
      const successful = rows.flatMap(row => row.status === 'fulfilled' ? [row.value] : []);
      if (!successful.some(row => row.samples.length)) continue;
      const combined = new Map<number, Map<string, Resource>>();
      for (const row of successful) for (const sample of row.samples) {
        const nodes = combined.get(sample.time) ?? new Map<string, Resource>();
        for (const node of sample.nodes) { const old = nodes.get(node.metadata.name!) ?? { metadata: node.metadata, usage: {} }; old.usage = { ...old.usage, ...node.usage }; nodes.set(node.metadata.name!, old); }
        combined.set(sample.time, nodes);
      }
      this.endpoints.set(key, { endpoint, expires: Date.now() + 300000 });
      if (this.endpoints.size > 50) this.endpoints.delete(this.endpoints.keys().next().value!);
      const missing = (['cpu', 'memory'] as const).filter(metric => !successful.some(row => row.metric === metric && row.samples.length));
      return { ...empty, history: true, source: `Prometheus (${endpoint.namespace}/${endpoint.service})`, samples: [...combined].sort(([a], [b]) => a - b).map(([time, nodes]) => ({ time, nodes: [...nodes.values()] })), warning: missing.length ? `Historical ${missing.join(' and ')} data is unavailable. Check scrape targets and services/proxy permissions.` : successful.some(row => row.warned) ? 'Prometheus reported partial query results; some samples may be missing.' : undefined };
    }
    this.endpoints.delete(key);
    return { ...empty, warning: 'No readable Prometheus history for this time range. Check retention, cAdvisor scraping and services/proxy permissions. Showing locally observed samples.' };
  }
}
