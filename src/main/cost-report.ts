import type { ClusterManager } from './clusters';
import { Providers, serviceProxy } from './providers';
import { kubeJson } from './kube-http';
import { AppError } from './errors';
import { costComponents, type CostAllocation, type CostBucket, type CostComponent, type CostQuery, type CostReport } from '../shared/cost';
const fields: Record<CostComponent, string> = { cpu: 'cpuCost', memory: 'ramCost', gpu: 'gpuCost', storage: 'pvCost', network: 'networkCost', loadBalancer: 'loadBalancerCost', shared: 'sharedCost', external: 'externalCost' };
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function sumAllocations(rows: CostAllocation[]) {
  const totals = new Map<string, CostAllocation>();
  for (const row of rows) {
    const old = totals.get(row.name);
    if (!old) { totals.set(row.name, { ...row, components: { ...row.components } }); continue; }
    old.total += row.total;
    for (const key of costComponents) {
      if (old.components[key] !== undefined && row.components[key] !== undefined) old.components[key]! += row.components[key]!;
      else delete old.components[key];
    }
  }
  return [...totals.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}
export function parseCostReport(response: any, query: CostQuery): Pick<CostReport, 'total' | 'allocations' | 'buckets' | 'warnings' | 'currency'> {
  if (response?.code && response.code !== 200 || !Array.isArray(response?.data)) throw new AppError('COST_RESPONSE', 'The allocation service returned an unsupported response.');
  if (response.data.length > 744) throw new AppError('COST_LIMIT', 'The allocation response contains too many intervals. Choose a shorter range.');
  const all: CostAllocation[] = [], buckets: CostBucket[] = [];
  let invalid = 0, untimed = 0, count = 0;
  for (const set of response.data) {
    if (!set || typeof set !== 'object' || Array.isArray(set)) { invalid++; continue; }
    const rows: CostAllocation[] = []; let start: number | undefined, end: number | undefined, ambiguous = false;
    for (const [name, raw] of Object.entries(set)) {
      if (++count > 20000) throw new AppError('COST_LIMIT', 'The allocation response is too large. Choose a shorter range or broader grouping.');
      const row = raw as any;
      if (!row || !finite(row.totalCost)) { invalid++; continue; }
      const components: CostAllocation['components'] = {};
      for (const key of costComponents) if (finite(row[fields[key]])) components[key] = row[fields[key]];
      if (name.length > 1024) throw new AppError('COST_RESPONSE', 'The allocation service returned an invalid allocation name.');
      rows.push({ name, total: row.totalCost, components });
      const a = Date.parse(row.window?.start), b = Date.parse(row.window?.end);
      if (Number.isFinite(a) && Number.isFinite(b) && (a >= b || a < query.start || b > query.end)) throw new AppError('COST_RESPONSE', 'The allocation service returned intervals outside the requested range.');
      if (!Number.isFinite(a) || !Number.isFinite(b)) ambiguous = true;
      else if (start === undefined) { start = a; end = b; } else if (start !== a || end !== b) ambiguous = true;
    }
    all.push(...rows);
    if (rows.length && !ambiguous && start !== undefined && end !== undefined) buckets.push({ start, end, total: rows.reduce((sum, row) => sum + row.total, 0), allocations: rows });
    else if (rows.length) untimed++;
  }
  buckets.sort((a, b) => a.start - b.start);
  const overlap = buckets.some((b, i) => i > 0 && b.start < buckets[i - 1].end);
  if (overlap) throw new AppError('COST_RESPONSE', 'The allocation service returned overlapping intervals. Totals cannot be safely combined.');
  const allocations = sumAllocations(all);
  if (allocations.some(a => !finite(a.total) || Object.values(a.components).some(v => !finite(v))) || buckets.some(b => !finite(b.total))) throw new AppError('COST_RESPONSE', 'The allocation totals are invalid.');
  const total = allocations.length ? allocations.reduce((sum, row) => sum + row.total, 0) : null;
  if (total !== null && !Number.isFinite(total)) throw new AppError('COST_RESPONSE', 'The allocation totals are invalid.');
  return { allocations, total, buckets, currency: typeof response.currency === 'string' && /^[A-Z]{3}$/.test(response.currency) ? response.currency : 'provider units', warnings: [
    ...(!allocations.length ? ['No allocations were returned. Check the selected dates, retention and provider configuration.'] : []),
    ...(invalid ? ['Some allocation rows were invalid and excluded; totals are partial.'] : []),
    ...(untimed ? ['Some allocations have no valid interval timestamps; they appear in totals but not the timeline.'] : []),
    ...(Array.isArray(response.warnings) && response.warnings.length ? ['The provider reported warnings; allocations may be incomplete.'] : []),
    ...(buckets.length && (buckets[0].start > query.start || buckets.at(-1)!.end < query.end || buckets.some((b, i) => i > 0 && b.start > buckets[i - 1].end)) ? ['Historical coverage is incomplete; empty intervals are not zero-cost periods.'] : [])
  ] };
}
export class CostReports {
  constructor(private clusters: ClusterManager) {}
  async read(query: CostQuery): Promise<CostReport> {
    const settings = this.clusters.settings(query.clusterId);
    const base: CostReport = { source: settings.costSource, currency: 'provider units', estimated: false, start: query.start, end: query.end, group: query.group, generatedAt: Date.now(), total: null, allocations: [], buckets: [], warnings: [] };
    if (settings.costSource === 'off') return { ...base, warnings: ['Cost monitoring is disabled. Enable a provider in Cluster Settings > Cost.'] };
    const config = this.clusters.get(query.clusterId).config;
    if (settings.costSource === 'estimate') {
      if (!settings.estimatedNodeHourlyCost) return { ...base, estimated: true, currency: 'USD', group: 'node', warnings: ['Set an estimated hourly node rate in Cluster Settings > Cost.'] };
      const nodes = await kubeJson<any>(config, '/api/v1/nodes');
      const hours = (query.end - query.start) / 3600000;
      const allocations = nodes.items.map((node: any) => ({ name: node.metadata.name, total: settings.estimatedNodeHourlyCost * hours, components: {} }));
      return { ...base, currency: 'USD', estimated: true, group: 'node', allocations, total: allocations.reduce((sum: number, row: CostAllocation) => sum + row.total, 0), warnings: ['Projection from the current node count and configured hourly rate over the selected duration. This is not historical spending or a cloud bill; storage and network are excluded.'] };
    }
    const endpoints = settings.costEndpoint.service ? [settings.costEndpoint] : (await new Providers(this.clusters).discover(query.clusterId, settings.costSource === 'opencost' ? /opencost/i : settings.costSource === 'kubecost' ? /kubecost|cost-analyzer/i : /opencost|kubecost|cost-analyzer/i)).slice(0, 3);
    const params = new URLSearchParams({ window: `${new Date(query.start).toISOString()},${new Date(query.end).toISOString()}`, aggregate: query.group === 'controller' ? 'namespace,controllerKind,controller' : query.group, step: query.end - query.start <= 2 * 86400000 ? '1h' : '1d', resolution: '5m', accumulate: 'false', includeIdle: String(query.includeIdle), shareIdle: 'false' });
    let denied = false;
    for (const endpoint of endpoints) {
      // Kubecost deployments commonly expose /model/allocation, OpenCost /allocation.
      const paths = settings.costSource === 'kubecost' || /kubecost|cost-analyzer/i.test(endpoint.service) ? ['/model/allocation', '/allocation'] : ['/allocation'];
      for (const path of paths) {
        try {
          const response = await kubeJson(config, `${serviceProxy(endpoint)}${path}?${params}`);
          return { ...base, ...parseCostReport(response, query), source: `${endpoint.namespace}/${endpoint.service}` };
        } catch (e) { if (e instanceof AppError) throw e; const status = (e as any)?.statusCode; if (status === 401 || status === 403) denied = true; if (status !== 404) break; }
      }
    }
    throw new AppError(denied ? 'COST_FORBIDDEN' : 'COST_UNAVAILABLE', denied ? 'Cost service access was denied. Check services/proxy permissions and provider authentication.' : 'No readable allocation API was found. Configure OpenCost or Kubecost in Cluster Settings > Cost and check service connectivity.');
  }
}
