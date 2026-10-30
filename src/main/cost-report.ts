import { readPriceHistory } from './cost-price-history';
import { CostEstimates } from './cost-estimate';
import type { ClusterManager } from './clusters';
import { Providers, serviceProxy } from './providers';
import { kubeJson } from './kube-http';
import { AppError } from './errors';
import { costComponents, type CostAllocation, type CostBucket, type CostComponent, type CostQuery, type CostReport } from '../shared/cost';
const fields: Record<CostComponent, string> = { cpu: 'cpuCost', memory: 'ramCost', gpu: 'gpuCost', storage: 'pvCost', network: 'networkCost', loadBalancer: 'loadBalancerCost', shared: 'sharedCost', external: 'externalCost' };
const usageFields = { cpuCoreHours: ['cpuCoreHours', 1], memoryGiBHours: ['ramByteHours', 1024 ** 3], gpuHours: ['gpuHours', 1], storageGiBHours: ['pvByteHours', 1024 ** 3], networkGiB: ['networkTransferBytes', 1024 ** 3] } as const;
const networkFields = { zone: 'networkCrossZoneCost', region: 'networkCrossRegionCost', internet: 'networkInternetCost' } as const;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function sumOptional<T extends Record<string, number | undefined>>(a: T | undefined, b: T | undefined): T | undefined {
  if (!a || !b) return;
  return Object.fromEntries(Object.keys(a).filter(key => b[key] !== undefined).map(key => [key, a[key]! + b[key]!])) as T;
}
function sumAllocations(rows: CostAllocation[]) {
  const totals = new Map<string, CostAllocation>();
  for (const row of rows) {
    const old = totals.get(row.name);
    if (!old) { totals.set(row.name, { ...row, components: { ...row.components }, ...(row.usage ? { usage: { ...row.usage } } : {}), ...(row.network ? { network: { ...row.network } } : {}) }); continue; }
    old.total += row.total;
    for (const key of costComponents) {
      if (old.components[key] !== undefined && row.components[key] !== undefined) old.components[key]! += row.components[key]!;
      else delete old.components[key];
    }
    if (old.usage) { const usage = sumOptional(old.usage, row.usage); if (usage) old.usage = usage; else delete old.usage; }
    if (old.network) { const network = sumOptional(old.network, row.network); if (network) old.network = network; else delete old.network; }
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
      for (const key of costComponents) {
        const adjustment = row[`${fields[key]}Adjustment`];
        if (finite(row[fields[key]]) && (adjustment === undefined || finite(adjustment))) components[key] = row[fields[key]] + (adjustment ?? 0);
      }
      const usage = Object.fromEntries(Object.entries(usageFields).filter(([, [field]]) => finite(row[field]) && row[field] >= 0).map(([key, [field, divisor]]) => [key, row[field] / divisor]));
      const network = Object.fromEntries(Object.entries(networkFields).filter(([, field]) => finite(row[field])).map(([key, field]) => [key, row[field]]));
      if (name.length > 1024) throw new AppError('COST_RESPONSE', 'The allocation service returned an invalid allocation name.');
      rows.push({ name, total: row.totalCost, components, ...(Object.keys(usage).length ? { usage } : {}), ...(Object.keys(network).length ? { network } : {}) });
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
  if (allocations.some(a => !finite(a.total) || [...Object.values(a.components), ...Object.values(a.usage ?? {}), ...Object.values(a.network ?? {})].some(v => !finite(v))) || buckets.some(b => !finite(b.total))) throw new AppError('COST_RESPONSE', 'The allocation totals are invalid.');
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
  private estimates: CostEstimates;
  constructor(private clusters: ClusterManager) { this.estimates = new CostEstimates(clusters); }
  async read(query: CostQuery): Promise<CostReport> {
    const loaded = await this.load(query);
    const report = { ...loaded, warnings: [...loaded.warnings] };
    if (!report.estimated && this.clusters.settings(query.clusterId).costPriceHistory && this.clusters.settings(query.clusterId).costSource !== 'off') {
      try {
        report.priceHistory = await readPriceHistory(this.clusters, query);
        if (!report.priceHistory.length) report.warnings.push('No retained provider price metrics were found. Scrape OpenCost into the configured Prometheus to record price changes, including GCP rates.');
      } catch { report.warnings.push('Provider price history could not be read. Allocation totals remain available; check the configured Prometheus service, access and retained OpenCost price metrics.'); }
    }
    return report;
  }
  private async load(query: CostQuery): Promise<CostReport> {
    const settings = this.clusters.settings(query.clusterId);
    const base: CostReport = { source: settings.costSource, currency: 'provider units', estimated: false, start: query.start, end: query.end, group: query.group, generatedAt: Date.now(), total: null, allocations: [], buckets: [], warnings: [] };
    if (settings.costSource === 'off') return { ...base, warnings: ['Cost monitoring is disabled. Enable a provider in Cluster Settings > Cost.'] };
    const config = this.clusters.get(query.clusterId).config;
    if (settings.costSource === 'estimate') return this.estimates.read(query);
    const endpoints = settings.costEndpoint.service ? [settings.costEndpoint] : (await new Providers(this.clusters).discover(query.clusterId, settings.costSource === 'opencost' ? /opencost/i : settings.costSource === 'kubecost' ? /kubecost|cost-analyzer/i : /opencost|kubecost|cost-analyzer/i)).slice(0, 3);
    // OpenCost's window parser requires whole-second RFC3339 timestamps.
    // Round inward so the provider never bills outside the requested interval.
    const providerQuery = { ...query, start: Math.ceil(query.start / 1000) * 1000, end: Math.floor(query.end / 1000) * 1000 };
    const timestamp = (time: number) => new Date(time).toISOString().replace('.000Z', 'Z');
    const params = new URLSearchParams({ window: `${timestamp(providerQuery.start)},${timestamp(providerQuery.end)}`, aggregate: query.group === 'controller' ? 'namespace,controllerKind,controller' : query.group, step: query.end - query.start <= 2 * 86400000 ? '1h' : '1d', resolution: '5m', accumulate: 'false', includeIdle: String(query.includeIdle), shareIdle: 'false' });
    let denied = false;
    for (const endpoint of endpoints) {
      // Kubecost deployments commonly expose /model/allocation, OpenCost /allocation.
      const paths = settings.costSource === 'kubecost' || /kubecost|cost-analyzer/i.test(endpoint.service) ? ['/model/allocation', '/allocation'] : ['/allocation'];
      for (const path of paths) {
        try {
          const stepMs = query.end - query.start <= 2 * 86400000 ? 3600000 : 86400000;
          const fullEnd = providerQuery.start + Math.floor((providerQuery.end - providerQuery.start) / stepMs) * stepMs;
          // OpenCost extends a partial final step past the requested end. Query
          // that edge separately with its exact duration to avoid overcharging.
          const ranges = [
            ...(fullEnd > providerQuery.start ? [[providerQuery.start, fullEnd, stepMs]] : []),
            ...(providerQuery.end > fullEnd ? [[fullEnd, providerQuery.end, providerQuery.end - fullEnd]] : [])
          ];
          const responses = [];
          for (const [start, end, duration] of ranges) {
            const requestParams = new URLSearchParams(params);
            requestParams.set('window', `${timestamp(start)},${timestamp(end)}`);
            if (duration !== stepMs) requestParams.set('step', `${duration / 1000}s`);
            responses.push(await kubeJson(config, `${serviceProxy(endpoint)}${path}?${requestParams}`));
          }
          if (responses.some(r => (r.code && r.code !== 200) || !Array.isArray(r.data))) throw new AppError('COST_RESPONSE', 'The allocation service returned an unsupported response.');
          const response = { ...responses[0], data: responses.flatMap(r => r.data), warnings: responses.flatMap(r => r.warnings ?? []) };
          return { ...base, ...parseCostReport(response, providerQuery), source: `${endpoint.namespace}/${endpoint.service}`, notes: [
            'Historical allocations use the prices retained by the configured OpenCost/Kubecost provider, including its GCP pricing configuration. Optic does not reprice those intervals using current VM prices.',
            'Component costs include returned adjustments. Network route costs are a breakdown of network cost, not additional charges. Effective rates divide interval costs by reported allocation units; changes can reflect pricing, discounts or a different resource mix.',
            'Storage, network and GPU costs require provider telemetry and pricing. A reported zero is the provider result, not proof that collection is complete. Missing fields remain unavailable. Cloud invoice reconciliation and past data before provider retention are not inferred.'
          ] };
        } catch (e) { if (e instanceof AppError) throw e; const status = (e as any)?.statusCode; if (status === 401 || status === 403) denied = true; if (status !== 404) break; }
      }
    }
    if (settings.costSource === 'automatic' && !settings.costEndpoint.service && !denied) return this.estimates.read(query);
    throw new AppError(denied ? 'COST_FORBIDDEN' : 'COST_UNAVAILABLE', denied ? 'Cost service access was denied. Check services/proxy permissions and provider authentication.' : 'No readable allocation API was found. Configure OpenCost or Kubecost in Cluster Settings > Cost and check service connectivity.');
  }
}
