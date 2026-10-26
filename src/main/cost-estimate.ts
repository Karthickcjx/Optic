import type { ClusterManager } from './clusters';
import { Providers, serviceProxy } from './providers';
import { kubeJson } from './kube-http';
import { AppError } from './errors';
import { priceNode } from './node-pricing';
import type { CostAllocation, CostBucket, CostQuery, CostReport, NodePrice } from '../shared/cost';

type Series = { metric: Record<string, string>; values: [number, string][] };
type Point = { labels: Record<string, string>; points: Map<number, number> };
type Metric = 'cpuRequests' | 'memoryRequests' | 'cpuUsage' | 'memoryUsage' | 'cpuCapacity' | 'memoryCapacity' | 'owners' | 'replicaOwners';
type Observations = Partial<Record<Metric, Point[]>>;
const GiB = 1024 ** 3;
export function estimateQueries(step: number, workloads: boolean): Partial<Record<Metric, string>> {
  const podNodes = 'max by (namespace,pod,node) (kube_pod_info)';
  const running = 'max by (namespace,pod,container) (kube_pod_container_status_running)';
  // Integrate only observed minutes. Short-lived Pods/nodes must not be billed for a whole bucket.
  const average = (expression: string) => `avg_over_time((${expression})[${step}s:60s]) * clamp_max(count_over_time((${expression})[${step}s:60s]) / ${step / 60}, 1)`;
  const requests = (resource: string) => {
    const selector = `kube_pod_container_resource_requests{resource="${resource}"}`;
    // KSM omits unset requests. Zero-fill only known containers while the resource-request family exists.
    const values = `(max by (namespace,pod,container,node) (${selector}) or on(namespace,pod,container) ((0 * ${running}) * on(namespace,pod) group_left(node) ${podNodes})) and on() count(${selector})`;
    return average(`sum by (namespace,pod,node) ((${values}) * on(namespace,pod,container) group_left() ${running})`);
  };
  const usage = (expression: string) => average(`sum by (namespace,pod) (max by (namespace,pod,container) (${expression})) * on(namespace,pod) group_left(node) ${podNodes}`);
  return {
    cpuRequests: requests('cpu'), memoryRequests: requests('memory'),
    cpuUsage: usage('rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m])'),
    memoryUsage: usage('container_memory_working_set_bytes{container!="",container!="POD"}'),
    cpuCapacity: average('max by (node) (kube_node_status_capacity{resource="cpu"})'),
    memoryCapacity: average('max by (node) (kube_node_status_capacity{resource="memory"})'),
    ...(workloads ? { owners: `max by(namespace,pod,owner_kind,owner_name) (last_over_time(kube_pod_owner{owner_is_controller="true"}[${step}s]))`, replicaOwners: `max by(namespace,replicaset,owner_kind,owner_name) (last_over_time(kube_replicaset_owner{owner_is_controller="true"}[${step}s]))` } : {})
  };
}
export function estimatePoints(response: any, start: number, end: number): Point[] {
  if (response?.status !== 'success' || response.data?.resultType !== 'matrix' || !Array.isArray(response.data.result)) throw new AppError('COST_METRICS', 'Prometheus returned an invalid cost history response.');
  if (response.data.result.length > 1000) throw new AppError('COST_LIMIT', 'Cost estimates support up to 1,000 series per metric. Reduce the cluster scope.');
  return response.data.result.map((series: Series) => {
    if (!Array.isArray(series.values) || series.values.length > 300) throw new AppError('COST_LIMIT', 'Prometheus returned too many cost samples.');
    const points = new Map<number, number>();
    for (const pair of series.values) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[1] !== 'string' || !pair[1].trim()) continue;
      const t = Number(pair[0]), value = Number(pair[1]);
      if (Number.isFinite(t) && t >= start && t <= end && Number.isFinite(value) && value >= 0) points.set(t, value);
    }
    return { labels: series.metric ?? {}, points };
  });
}
function index(rows: Point[] | undefined, keys: string[]) {
  const map = new Map<string, Map<number, number>>();
  for (const row of rows ?? []) {
    if (keys.some(k => !row.labels[k])) continue;
    const key = JSON.stringify(keys.map(k => row.labels[k])), points = map.get(key) ?? new Map();
    for (const [time, value] of row.points) points.set(time, Math.max(points.get(time) ?? 0, value));
    map.set(key, points);
  }
  return map;
}
function add(rows: Map<string, CostAllocation>, name: string, cpu: number, memory: number) {
  const old = rows.get(name) ?? { name, total: 0, components: { cpu: 0, memory: 0 } };
  old.components.cpu! += cpu; old.components.memory! += memory; old.total += cpu + memory; rows.set(name, old);
}
export function allocateEstimate(query: CostQuery, start: number, end: number, step: number, observations: Observations, prices: NodePrice[]): CostReport {
  const fields = ['cpuRequests', 'memoryRequests', 'cpuUsage', 'memoryUsage'] as const;
  const metrics = Object.fromEntries(fields.map(k => [k, index(observations[k], ['namespace', 'pod', 'node'])])) as Record<typeof fields[number], ReturnType<typeof index>>;
  const cpuCap = index(observations.cpuCapacity, ['node']), memCap = index(observations.memoryCapacity, ['node']);
  const keys = new Set(fields.flatMap(k => [...metrics[k].keys()])), rates = new Map(prices.map(p => [p.node, p]));
  const ownerIndex = (points: Point[] | undefined, kind: string) => {
    const map = new Map<string, Point[]>();
    for (const point of points ?? []) { const key = JSON.stringify([point.labels.namespace, point.labels[kind]]); map.set(key, [...(map.get(key) ?? []), point]); }
    return map;
  };
  const podOwners = ownerIndex(observations.owners, 'pod'), replicaOwners = ownerIndex(observations.replicaOwners, 'replicaset');
  const totals = new Map<string, CostAllocation>(), buckets: CostBucket[] = [];
  let usedCpu = 0, requestedCpu = 0, usedMemory = 0, requestedMemory = 0, idleCost = 0, incomplete = false, ownerFallback = false, rowCount = 0;
  for (let time = start; time <= end; time += step) {
    const rows = new Map<string, CostAllocation>(), charged = new Map<string, { cpu: number; memory: number }>(), partialNodes = new Set<string>();
    for (const key of keys) {
      const [namespace, pod, node] = JSON.parse(key) as string[], price = rates.get(node);
      const values = fields.map(k => metrics[k].get(key)?.get(time));
      if (values.every(v => v === undefined)) continue;
      // Never substitute missing telemetry with a zero and then label the remainder idle.
      if (!price || values.some(v => v === undefined) || cpuCap.get(JSON.stringify([node]))?.get(time) === undefined || memCap.get(JSON.stringify([node]))?.get(time) === undefined) { incomplete = true; partialNodes.add(node); continue; }
      const [cr, mr, cu, mu] = values as number[], hours = step / 3600;
      const cpu = Math.max(cr, cu), memory = Math.max(mr, mu);
      let name = query.group === 'node' ? node : namespace;
      if (query.group === 'controller') {
        const owners = podOwners.get(JSON.stringify([namespace, pod]))?.filter(o => (o.points.get(time) ?? 0) > 0) ?? [];
        let owner = owners.length === 1 ? owners[0].labels : undefined;
        if (owner?.owner_kind === 'ReplicaSet') {
          const parents = replicaOwners.get(JSON.stringify([namespace, owner.owner_name]))?.filter(o => (o.points.get(time) ?? 0) > 0) ?? [];
          if (parents.length === 1) owner = parents[0].labels;
        }
        name = owner ? `${namespace}/${owner.owner_kind}/${owner.owner_name}` : `${namespace}/Pod/${pod}`;
        if (!owner) ownerFallback = true;
      }
      add(rows, name, cpu * price.cpuHourly * hours, memory / GiB * price.memoryHourly * hours);
      usedCpu += cu * hours; requestedCpu += cr * hours; usedMemory += mu * hours; requestedMemory += mr * hours;
      const old = charged.get(node) ?? { cpu: 0, memory: 0 }; old.cpu += cpu; old.memory += memory; charged.set(node, old);
    }
    for (const [key, points] of cpuCap) {
      const capacity = points.get(time); if (capacity === undefined) continue;
      const [node] = JSON.parse(key), memory = memCap.get(key)?.get(time), price = rates.get(node), allocation = charged.get(node);
      if (!price || memory === undefined || !allocation || partialNodes.has(node)) { incomplete = true; continue; }
      const cpuCost = Math.max(0, capacity - allocation.cpu) * price.cpuHourly * step / 3600;
      const memCost = Math.max(0, memory - allocation.memory) / GiB * price.memoryHourly * step / 3600;
      idleCost += cpuCost + memCost;
      if (query.includeIdle) add(rows, query.group === 'node' ? node : '__idle__', cpuCost, memCost);
    }
    if (!rows.size) continue;
    rowCount += rows.size; if (rowCount > 20000) throw new AppError('COST_LIMIT', 'The estimate exceeds 20,000 allocation rows. Choose namespace or node grouping.');
    const allocations = [...rows.values()];
    for (const row of allocations) add(totals, row.name, row.components.cpu!, row.components.memory!);
    buckets.push({ start: (time - step) * 1000, end: time * 1000, total: allocations.reduce((s, r) => s + r.total, 0), allocations });
  }
  const allocations = [...totals.values()].sort((a, b) => b.total - a.total);
  if (allocations.some(a => !Number.isFinite(a.total)) || !Number.isFinite(idleCost)) throw new AppError('COST_METRICS', 'Prometheus returned values too large to estimate costs.');
  const coverage = buckets.length * step * 1000 / (query.end - query.start);
  const expectedIntervals = Math.max(0, Math.floor((end - start) / step) + 1);
  const missingIntervals = Math.max(0, expectedIntervals - buckets.length);
  const observedMilliseconds = buckets.length * step * 1000;
  const edgeExcludedMilliseconds = Math.max(0, query.end - query.start - expectedIntervals * step * 1000);
  const historyCoverage = { expectedIntervals, observedIntervals: buckets.length, missingIntervals, observedMilliseconds, edgeExcludedMilliseconds, observedStart: buckets[0]?.start, observedEnd: buckets.at(-1)?.end };
  const duration = (ms: number) => ms >= 3600000 ? `${(ms / 3600000).toFixed(1)} hours` : `${Math.round(ms / 60000)} minutes`;
  return { ...query, generatedAt: Date.now(), source: 'Prometheus estimate', currency: 'USD', estimated: true, allocations, buckets, total: allocations.length ? allocations.reduce((s, a) => s + a.total, 0) : null,
    idleCost, efficiency: { cpu: requestedCpu > 0 ? usedCpu / requestedCpu : undefined, memory: requestedMemory > 0 ? usedMemory / requestedMemory : undefined }, nodePrices: prices, coverage, historyCoverage,
    notes: [
      'Historical usage estimate at current prices, not a cloud invoice. CPU/RAM allocations use the higher of average requests and usage. Storage, network, discounts and separate GPU charges are excluded; public VM prices may include GPUs.',
      'Node metadata and public prices describe the current configuration, not historical instance changes. CPU/RAM price splitting uses the configured resource-rate weights.',
      ...(edgeExcludedMilliseconds > 0 ? [`The range excludes ${Math.ceil(edgeExcludedMilliseconds / 1000)} seconds at its edges to use complete sampling intervals. This is rounding, not missing history.`] : [])
    ], warnings: [
      ...(prices.some(p => p.source.includes('fallback')) ? ['Some nodes use configurable fallback rates because public pricing is unavailable or unsupported. These rates are assumptions, not discovered cloud prices.'] : []),
      ...(prices.some(p => p.spot && !p.source.includes('spot retail')) ? ['Spot nodes use an on-demand reference or configured rates; actual spot charges may differ.'] : []),
      ...(incomplete ? ['Telemetry is incomplete. Affected allocations and idle amounts are omitted; totals are partial.'] : []),
      ...(missingIntervals > 0 ? [`Historical coverage is partial: ${duration(observedMilliseconds)} of usable observations in the selected ${duration(query.end - query.start)}. ${missingIntervals} sampling intervals have no usable cost data. Choose a shorter range or check Prometheus retention and scrape health; unobserved time is not charged.`] : []),
      ...(ownerFallback ? ['Some historical owners are unavailable or ambiguous. Those workloads are grouped by Pod.'] : []),
      ...(!allocations.length ? ['No complete CPU/memory cost observations were available for this range. Check kube-state-metrics, cAdvisor and Prometheus retention.'] : [])
    ] };
}
export class CostEstimates {
  private cache = new Map<string, { expires: number; value: Promise<CostReport> }>();
  constructor(private clusters: ClusterManager) {}
  read(query: CostQuery): Promise<CostReport> {
    const settings = this.clusters.settings(query.clusterId);
    // Verify connection before using cached observations from that context.
    this.clusters.get(query.clusterId);
    const key = JSON.stringify([query, settings]), cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    const value = this.load(query); this.cache.set(key, { expires: Date.now() + 30000, value });
    if (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value!);
    void value.catch(() => { if (this.cache.get(key)?.value === value) this.cache.delete(key); }); return value;
  }
  private async load(query: CostQuery): Promise<CostReport> {
    const settings = this.clusters.settings(query.clusterId), config = this.clusters.get(query.clusterId).config;
    if (settings.metricsSource === 'none') throw new AppError('COST_METRICS', 'Enable Prometheus in Cluster Settings > Metrics to estimate costs.');
    const step = Math.max(60, Math.ceil((query.end - query.start) / 1000 / 288 / 60) * 60);
    const start = Math.ceil(query.start / 60000) * 60 + step, end = Math.floor(query.end / 1000);
    if (start > end) throw new AppError('COST_RANGE', 'Select a range with at least two complete minutes for cost estimates.');
    const endpoints = settings.prometheus.service ? [settings.prometheus] : (await new Providers(this.clusters).discover(query.clusterId, /prometheus/i)).slice(0, 3);
    const nodes = await kubeJson<any>(config, '/api/v1/nodes');
    if (!Array.isArray(nodes.items) || nodes.items.length > 500) throw new AppError('COST_LIMIT', 'Cost estimates support up to 500 nodes.');
    for (const endpoint of endpoints) {
      const observations: Observations = {}; let warned = false;
      const queries = Object.entries(estimateQueries(step, query.group === 'controller')) as [Metric, string][];
      const results = await Promise.allSettled(queries.map(async ([metric, expression]) => {
        const params = new URLSearchParams({ query: expression, start: String(start), end: String(end), step: String(step), timeout: '15s' });
        const response = await kubeJson(config, `${serviceProxy(endpoint)}/api/v1/query_range?${params}`);
        if (response.warnings?.length) warned = true;
        return { metric, points: estimatePoints(response, start, end) };
      }));
      for (const result of results) if (result.status === 'fulfilled') observations[result.value.metric] = result.value.points;
      const limit = results.find(r => r.status === 'rejected' && r.reason instanceof AppError && r.reason.code === 'COST_LIMIT');
      if (limit?.status === 'rejected') throw limit.reason;
      if (['cpuRequests', 'memoryRequests', 'cpuUsage', 'memoryUsage', 'cpuCapacity', 'memoryCapacity'].some(k => !observations[k as Metric]?.some(p => p.points.size))) continue;
      const byName = new Map<string, any>(nodes.items.map((n: any) => [n.metadata.name, n]));
      for (const point of observations.cpuCapacity ?? []) if (point.labels.node && !byName.has(point.labels.node)) {
        const ram = observations.memoryCapacity?.find(p => p.labels.node === point.labels.node);
        byName.set(point.labels.node, { metadata: { name: point.labels.node }, status: { capacity: { cpu: String(Math.max(0, ...point.points.values())), memory: String(Math.max(0, ...(ram?.points.values() ?? []))) } } });
      }
      if (byName.size > 500) throw new AppError('COST_LIMIT', 'Cost estimates support up to 500 historical nodes.');
      const prices: NodePrice[] = [], queue = [...byName.values()];
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => { while (queue.length) prices.push(await priceNode(queue.shift(), settings)); }));
      const report = allocateEstimate(query, start, end, step, observations, prices);
      report.source = `Prometheus estimate (${endpoint.namespace}/${endpoint.service})`;
      if (warned) report.warnings.push('Prometheus reported query warnings; results may be partial.');
      return report;
    }
    throw new AppError('COST_METRICS', 'No readable Prometheus CPU/memory usage, requests and capacity history was found. Configure Prometheus under Metrics and check cAdvisor, kube-state-metrics, retention and services/proxy access. OpenCost is not required.');
  }
}
