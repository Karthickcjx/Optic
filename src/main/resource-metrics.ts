import type { ClusterManager } from './clusters';
import type { ResourceService } from './resources';
import type { Resource } from '../shared/protocol';
import { relatedPods } from '../shared/relationships';
import { emptyMetricSeries, metricWorkloads, type MetricKey, type ResourceMetricRequest, type ResourceMetricResult } from '../shared/resource-metrics';
import { quantity } from '../shared/quantities';
import { Providers, serviceProxy } from './providers';
import { kubeJson } from './kube-http';
import { AppError } from './errors';

export function metricQueries(namespace: string, names: string[], container?: string): Record<MetricKey, string> {
  const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const labels = `namespace=${JSON.stringify(namespace)},pod=~${JSON.stringify(`^(${names.map(escape).join('|')})$`)}`;
  const selected = `${labels},${container ? `container=${JSON.stringify(container)}` : 'container!="",container!="POD"'}`;
  // Deduplicate repeated scrape targets before summing across containers / interfaces.
  return {
    cpu: `sum(max by (namespace,pod,container) (rate(container_cpu_usage_seconds_total{${selected}}[5m])))`,
    memory: `sum(max by (namespace,pod,container) (container_memory_working_set_bytes{${selected}}))`,
    networkRx: `sum(max by (namespace,pod,interface) (rate(container_network_receive_bytes_total{${labels},interface!="lo"}[5m])))`,
    networkTx: `sum(max by (namespace,pod,interface) (rate(container_network_transmit_bytes_total{${labels},interface!="lo"}[5m])))`,
    filesystem: `sum(max by (namespace,pod,container,device) (container_fs_usage_bytes{${selected}}))`
  };
}
export function rangePoints(response: any): [number, number][] {
  if (response?.status !== 'success' || response.data?.resultType !== 'matrix' || !Array.isArray(response.data.result)) throw new Error('Invalid metrics response');
  return (response.data.result[0]?.values ?? []).filter((v: any) => Array.isArray(v) && Number.isFinite(Number(v[0])) && Number.isFinite(Number(v[1])) && Number(v[1]) >= 0).map((v: any) => [Number(v[0]) * 1000, Number(v[1])]).slice(-300);
}
export class ResourceMetrics {
  private endpoints = new Map<string, { expires: number; endpoint: { namespace: string; service: string; port: number } }>();
  constructor(private clusters: ClusterManager, private resources: ResourceService) {}
  async read(input: ResourceMetricRequest): Promise<ResourceMetricResult> {
    if (!(metricWorkloads as readonly string[]).includes(input.kind) || !input.namespace) throw new AppError('UNSUPPORTED', 'Select a Pod or workload in a namespace.');
    const settings = this.clusters.settings(input.clusterId);
    const result: ResourceMetricResult = { source: 'none', podCount: 0, containers: [], history: false, series: emptyMetricSeries(), unavailable: {} };
    if (settings.metricsSource === 'none') return { ...result, warning: 'Metrics are disabled in cluster settings.' };
    let resource: Resource;
    try { resource = await this.resources.get(input); }
    catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) throw new AppError('RESOURCE_NOT_FOUND', 'This resource no longer exists. Refresh the resource list and reopen its details.');
      throw error;
    }
    if (resource.metadata.uid !== input.uid) throw new AppError('RESOURCE_CHANGED', 'This resource was replaced. Reopen its details.');
    if (settings.hiddenMetrics.includes(resource.kind ?? '') || (input.container && settings.hiddenMetrics.includes('Container'))) return { ...result, warning: 'These metrics are hidden in cluster settings.' };
    let pods: Resource[];
    if (input.kind === 'pods') pods = [resource];
    else {
      const scope = { clusterId: input.clusterId, namespace: input.namespace };
      const [allPods, children] = await Promise.all([this.resources.list({ ...scope, kind: 'pods' }), input.kind === 'deployments' || input.kind === 'cronjobs' ? this.resources.list({ ...scope, kind: input.kind === 'deployments' ? 'replicasets' : 'jobs' }) : Promise.resolve([])]);
      pods = relatedPods(resource, allPods, children);
    }
    result.podCount = pods.length;
    result.containers = [...new Set(pods.flatMap(p => [...(p.spec?.containers ?? []), ...(p.spec?.initContainers ?? []), ...(p.spec?.ephemeralContainers ?? [])].map((c: any) => String(c.name))))].sort();
    if (!pods.length) return { ...result, warning: 'No currently owned Pods. Historical deleted Pods are not included.' };
    if (pods.length > 200) throw new AppError('METRICS_LIMIT', 'This workload has over 200 Pods. Open an individual Pod for metrics.');
    if (input.container && !result.containers.includes(input.container)) throw new AppError('CONTAINER_NOT_FOUND', 'The selected container is no longer present.');
    const config = this.clusters.get(input.clusterId).config;
    if (settings.metricsSource !== 'metrics-server') {
      const key = JSON.stringify([input.clusterId, settings.prometheus]);
      const cached = this.endpoints.get(key);
      let endpoints: { namespace: string; service: string; port: number }[] = [];
      try { endpoints = settings.prometheus.service ? [settings.prometheus] : cached && cached.expires > Date.now() ? [cached.endpoint] : (await new Providers(this.clusters).discover(input.clusterId, /prometheus/i)).slice(0, 3); } catch {}
      const queries = metricQueries(input.namespace, pods.map(p => p.metadata.name!), input.container);
      const end = Math.floor(Date.now() / 1000), start = end - input.minutes * 60;
      for (const endpoint of endpoints) {
        const keys = Object.keys(queries) as MetricKey[];
        const rows = await Promise.allSettled(keys.map(async key => {
          if (input.container && key.startsWith('network')) return [];
          const query = new URLSearchParams({ query: queries[key], start: String(start), end: String(end), step: String(Math.max(15, Math.ceil(input.minutes * 60 / 240))), timeout: '10s' });
          return rangePoints(await kubeJson(config, `${serviceProxy(endpoint)}/api/v1/query_range?${query}`));
        }));
        const series = emptyMetricSeries();
        rows.forEach((r, i) => { if (r.status === 'fulfilled') series[keys[i]] = r.value; });
        if (Object.values(series).some(points => points.length)) {
          this.endpoints.set(key, { endpoint, expires: Date.now() + 300000 });
          if (this.endpoints.size > 50) this.endpoints.delete(this.endpoints.keys().next().value!);
          for (const k of keys) if (!series[k].length) result.unavailable[k] = input.container && k.startsWith('network') ? 'Network traffic is shared by the Pod; choose All containers.' : 'No readable series. Check cAdvisor scrape targets and metric availability.';
          return { ...result, source: `Prometheus (${endpoint.namespace}/${endpoint.service})`, history: true, series, warning: 'History includes currently owned Pod names only. Filesystem is container filesystem usage, not PVC capacity.' };
        }
      }
      this.endpoints.delete(key);
      if (settings.metricsSource === 'prometheus') return { ...result, source: 'Prometheus', warning: 'No readable container series. Check the configured service, services/proxy permissions and cAdvisor scraping.' };
    }
    // Metrics Server supplies CPU/memory snapshots, never invented network or disk values.
    let data: { items: Resource[] };
    try { data = await kubeJson<{ items: Resource[] }>(config, `/apis/metrics.k8s.io/v1beta1/namespaces/${encodeURIComponent(input.namespace)}/pods`); }
    catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404) throw new AppError('METRICS_UNAVAILABLE', `${settings.metricsSource === 'automatic' ? 'No usable Prometheus container metrics were found, and the' : 'The'} Metrics Server API is not available. Install Metrics Server for CPU/memory, or configure Prometheus in Cluster Settings > Metrics. Network and filesystem charts require Prometheus with cAdvisor scraping.`);
      if (status === 401 || status === 403) throw new AppError('METRICS_FORBIDDEN', 'Your cluster credentials cannot read Pod metrics. Check access to pods in the metrics.k8s.io API group for this namespace.');
      if (status === 503) throw new AppError('METRICS_UNAVAILABLE', 'The Metrics Server API is registered but unavailable. Check metrics-server health and the metrics.k8s.io APIService.');
      throw new AppError('METRICS_UNAVAILABLE', 'Could not read Pod metrics. Check the cluster connection and Metrics Server health, then refresh metrics.');
    }
    const names = new Set(pods.map(p => p.metadata.name));
    const samples = data.items.filter(p => names.has(p.metadata.name) && p.metadata.namespace === input.namespace);
    const containers = samples.flatMap(p => (p.containers ?? []).filter((c: any) => !input.container || c.name === input.container));
    const now = Date.now();
    for (const key of ['cpu', 'memory'] as const) {
      const found = containers.filter((c: any) => c.usage?.[key] !== undefined);
      if (found.length) result.series[key] = [[now, found.reduce((sum: number, c: any) => sum + quantity(c.usage[key]), 0)]];
    }
    for (const key of ['networkRx', 'networkTx', 'filesystem'] as const) result.unavailable[key] = 'Requires Prometheus with cAdvisor metrics; Metrics Server exposes only CPU and memory.';
    return { ...result, source: 'metrics-server', warning: `Live samples collected while this drawer is open. Metrics returned for ${samples.length}/${pods.length} Pods. Network and filesystem require Prometheus.` };
  }
}
