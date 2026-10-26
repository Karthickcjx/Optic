export const costGroups = ['namespace', 'node', 'controller'] as const;
export type CostGroup = typeof costGroups[number];
export const costComponents = ['cpu', 'memory', 'gpu', 'storage', 'network', 'loadBalancer', 'shared', 'external'] as const;
export type CostComponent = typeof costComponents[number];
export interface CostQuery { clusterId: string; start: number; end: number; group: CostGroup; includeIdle: boolean }
export interface CostAllocation { name: string; total: number; components: Partial<Record<CostComponent, number>> }
export interface CostBucket { start: number; end: number; total: number; allocations: CostAllocation[] }
export interface CostReport {
  source: string; currency: string; estimated: boolean; start: number; end: number; group: CostGroup;
  generatedAt: number; total: number | null; allocations: CostAllocation[]; buckets: CostBucket[]; warnings: string[];
}
export function costCsv(report: CostReport, search = '') {
  const cell = (value: string | number | undefined) => {
    let text = value === undefined ? '' : String(value);
    if (typeof value === 'string' && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const header = ['source', 'currency', 'estimated', 'start_utc', 'end_utc', 'group', 'allocation', 'total', ...costComponents, 'warnings'];
  const rows = report.allocations.filter(a => a.name.toLowerCase().includes(search.toLowerCase())).map(a => [report.source, report.currency, String(report.estimated), new Date(report.start).toISOString(), new Date(report.end).toISOString(), report.group, a.name, a.total, ...costComponents.map(k => a.components[k]), report.warnings.join(' | ')]);
  return [header, ...rows].map(row => row.map(cell).join(',')).join('\r\n');
}
