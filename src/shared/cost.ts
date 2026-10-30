export const costGroups = ['namespace', 'node', 'controller'] as const;
export type CostGroup = typeof costGroups[number];
export const costComponents = ['cpu', 'memory', 'gpu', 'storage', 'network', 'loadBalancer', 'shared', 'external'] as const;
export type CostComponent = typeof costComponents[number];
export const costUsageUnits = { cpuCoreHours: 'core-hours', memoryGiBHours: 'GiB-hours', gpuHours: 'GPU-hours', storageGiBHours: 'GiB-hours', networkGiB: 'GiB transferred' } as const;
export type CostUsage = Partial<Record<keyof typeof costUsageUnits, number>>;
export interface CostQuery { clusterId: string; start: number; end: number; group: CostGroup; includeIdle: boolean; forceRefresh?: boolean }
export interface CostAllocation { name: string; total: number; components: Partial<Record<CostComponent, number>>; usage?: CostUsage; network?: Partial<Record<'zone' | 'region' | 'internet', number>> }
export interface CostBucket { start: number; end: number; total: number; allocations: CostAllocation[]; observedMilliseconds?: number }
export interface NodePrice {
  node: string; cloud: string; region: string; instanceType: string; spot: boolean; cpu: number; memoryGiB: number;
  hourly: number; cpuHourly: number; memoryHourly: number; source: string; fetchedAt?: number;
}
export interface CostEfficiency { cpu?: number; memory?: number }
export interface CostHistoryCoverage {
  expectedIntervals: number; observedIntervals: number; missingIntervals: number; partialIntervals?: number;
  observedMilliseconds: number; edgeExcludedMilliseconds: number; observedStart?: number; observedEnd?: number;
  leadingMissingIntervals?: number; internalMissingIntervals?: number; trailingMissingIntervals?: number;
}
export interface CostReport {
  priceHistory?: HistoricalPrice[];
  source: string; currency: string; estimated: boolean; start: number; end: number; group: CostGroup;
  generatedAt: number; total: number | null; allocations: CostAllocation[]; buckets: CostBucket[]; warnings: string[]; notes?: string[]; nodePrices?: NodePrice[]; efficiency?: CostEfficiency; idleCost?: number; coverage?: number; historyCoverage?: CostHistoryCoverage;
}
export interface HistoricalPrice { resource: 'cpu' | 'memory' | 'gpu' | 'storage'; identity: string; cloud: string; cluster: string; unit: string; samples: { time: number; price: number }[] }
export const costLabels: Record<CostComponent, string> = { cpu: 'CPU', memory: 'Memory', gpu: 'GPU', storage: 'Storage', network: 'Network', loadBalancer: 'Load balancer', shared: 'Shared', external: 'External' };
export function componentSummary(rows: CostAllocation[], component: CostComponent) {
  const reported = rows.filter(row => row.components[component] !== undefined);
  return { total: reported.length ? reported.reduce((sum, row) => sum + row.components[component]!, 0) : undefined, reported: reported.length, count: rows.length };
}
export const rateUnits = { cpu: 'core-hour', memory: 'GiB-hour', gpu: 'GPU-hour', storage: 'GiB-hour' } as const;
const usageKeys = { cpu: 'cpuCoreHours', memory: 'memoryGiBHours', gpu: 'gpuHours', storage: 'storageGiBHours' } as const;
// Ratios of interval cost to interval allocation units, not cloud catalog prices.
// Do not combine a partial numerator with a different set of usage rows.
export function effectiveRate(rows: CostAllocation[], component: keyof typeof rateUnits): number | undefined {
  if (!rows.length || rows.some(row => row.components[component] === undefined || row.usage?.[usageKeys[component]] === undefined)) return;
  const usage = rows.reduce((sum, row) => sum + row.usage![usageKeys[component]]!, 0);
  return usage > 0 ? rows.reduce((sum, row) => sum + row.components[component]!, 0) / usage : undefined;
}
export function costCsv(report: CostReport, search = '') {
  const cell = (value: string | number | undefined) => {
    let text = value === undefined ? '' : String(value);
    if (typeof value === 'string' && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const header = ['source', 'currency', 'estimated', 'start_utc', 'end_utc', 'group', 'allocation', 'total', ...costComponents, ...Object.keys(costUsageUnits), 'network_zone_cost', 'network_region_cost', 'network_internet_cost', 'cpu_efficiency', 'memory_efficiency', 'coverage', 'pricing_sources', 'notes', 'warnings'];
  const rows = report.allocations.filter(a => a.name.toLowerCase().includes(search.toLowerCase())).map(a => [report.source, report.currency, String(report.estimated), new Date(report.start).toISOString(), new Date(report.end).toISOString(), report.group, a.name, a.total, ...costComponents.map(k => a.components[k]), ...Object.keys(costUsageUnits).map(k => a.usage?.[k as keyof CostUsage]), a.network?.zone, a.network?.region, a.network?.internet, report.efficiency?.cpu, report.efficiency?.memory, report.coverage, report.nodePrices ? [...new Set(report.nodePrices.map(n => n.source))].join(' | ') : '', report.notes?.join(' | '), report.warnings.join(' | ')]);
  return [header, ...rows].map(row => row.map(cell).join(',')).join('\r\n');
}

// Report fields, rather than installation alone, determine usable accounting views.
export function availableCostComponents(report: CostReport): CostComponent[] {
  if (report.estimated) return ['cpu', 'memory'];
  return costComponents.filter(key => report.allocations.some(a => a.components[key] !== undefined)
    || report.buckets.some(b => b.allocations.some(a => a.components[key] !== undefined)));
}
