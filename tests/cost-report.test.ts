import { beforeEach, it, expect, vi } from 'vitest';
import { CostReports, parseCostReport } from '../src/main/cost-report';
import { costCsv, type CostQuery } from '../src/shared/cost';
import { kubeJson } from '../src/main/kube-http';
import { defaultClusterSettings } from '../src/shared/cluster-settings';
import { schemas } from '../src/main/validation';
vi.mock('../src/main/kube-http', () => ({ kubeJson: vi.fn() }));
const start = Date.parse('2026-01-01T00:00:00Z'), hour = 3600000;
const query: CostQuery = { clusterId: 'test', start, end: start + 2 * hour, group: 'namespace', includeIdle: true };
const row = (offset: number, totalCost: number, extra = {}) => ({ totalCost, cpuCost: totalCost / 2, window: { start: new Date(start + offset * hour).toISOString(), end: new Date(start + (offset + 1) * hour).toISOString() }, ...extra });
const fixture = () => ({ currency: 'USD', data: [{ team: row(0, 2), credit: row(0, -1) }, { team: row(1, 4) }] });
const manager = (extra = {}) => ({ get: () => ({ config: {} }), settings: () => ({ ...defaultClusterSettings, costSource: 'opencost', costEndpoint: { namespace: 'cost', service: 'opencost', port: 9003 }, ...extra }) }) as any;
beforeEach(() => vi.resetAllMocks());
it('aggregates dated intervals, components and credits without inventing currency', () => {
  const result = parseCostReport(fixture(), query);
  expect(result.total).toBe(5); expect(result.buckets.map(b => b.total)).toEqual([1, 4]);
  expect(result.allocations[0]).toEqual({ name: 'team', total: 6, components: { cpu: 3 } });
  expect(result.currency).toBe('USD'); expect(result.warnings).toEqual([]);
  expect(parseCostReport({ data: fixture().data }, query).currency).toBe('provider units');
});
it('keeps missing components unavailable and warns about incomplete coverage', () => {
  const result = parseCostReport({ data: [{ team: row(1, 4, { cpuCost: undefined }) }] }, query);
  expect(result.allocations[0].components.cpu).toBeUndefined(); expect(result.warnings.join()).toContain('coverage is incomplete');
  expect(parseCostReport({ data: [{ team: row(0, 2) }, { team: row(1, 4, { cpuCost: undefined }) }] }, query).allocations[0].components.cpu).toBeUndefined();
});
it('distinguishes no data from zero and does not fabricate timestamps', () => {
  expect(parseCostReport({ data: [] }, query).total).toBeNull();
  const result = parseCostReport({ data: [{ team: { totalCost: 0 }, bad: { totalCost: '4' } }] }, query);
  expect(result.total).toBe(0); expect(result.buckets).toEqual([]); expect(result.warnings).toHaveLength(2);
});
it('rejects overlapping, out-of-range, malformed and oversized responses', () => {
  expect(() => parseCostReport({ data: [{ a: row(0, 2) }, { a: row(0, 2) }] }, query)).toThrow('overlapping');
  expect(() => parseCostReport({ data: [{ a: row(2, 2) }] }, query)).toThrow('outside');
  expect(() => parseCostReport({}, query)).toThrow('unsupported');
  expect(() => parseCostReport({ data: Array(745).fill({}) }, query)).toThrow('too many');
});
it('validates grouping and bounded past ranges at IPC boundary', () => {
  expect(schemas['cost:report'].safeParse(query).success).toBe(true);
  for (const change of [{ end: start }, { end: start + 32 * 86400000 }, { group: 'injected' }, { end: Date.now() + hour }, { includeIdle: 'true' }]) expect(schemas['cost:report'].safeParse({ ...query, ...change }).success).toBe(false);
});
it('queries historical service API with scope, daily buckets and idle setting', async () => {
  vi.mocked(kubeJson).mockResolvedValue({ data: [] });
  await new CostReports(manager()).read({ ...query, end: start + 7 * 86400000, group: 'controller', includeIdle: false });
  const url = new URL(vi.mocked(kubeJson).mock.calls[0][1], 'http://test');
  expect(url.pathname).toContain('/namespaces/cost/services/opencost%3A9003/proxy/allocation');
  expect(Object.fromEntries(url.searchParams)).toMatchObject({ aggregate: 'namespace,controllerKind,controller', step: '1d', includeIdle: 'false', accumulate: 'false', shareIdle: 'false' });
  expect(url.searchParams.get('window')).toContain(new Date(start).toISOString());
});
it('supports Kubecost route fallback and reports permission failures', async () => {
  vi.mocked(kubeJson).mockRejectedValueOnce({ statusCode: 404 }).mockResolvedValueOnce(fixture());
  expect((await new CostReports(manager({ costSource: 'kubecost' })).read(query)).total).toBe(5);
  expect(vi.mocked(kubeJson).mock.calls[0][1]).toContain('/model/allocation?');
  vi.mocked(kubeJson).mockRejectedValue({ statusCode: 403 });
  await expect(new CostReports(manager()).read(query)).rejects.toThrow('access was denied');
});
it('does not query metrics or pricing when disabled', async () => {
  const disabled = await new CostReports(manager({ costSource: 'off' })).read(query);
  expect(disabled.total).toBeNull(); expect(kubeJson).not.toHaveBeenCalled();
});
it('exports filtered CSV with provenance and spreadsheet formula escaping', async () => {
  vi.mocked(kubeJson).mockResolvedValue({ data: [{ '=formula,"test"': row(0, -1), excluded: row(1, 4) }] });
  const report = await new CostReports(manager()).read(query);
  const csv = costCsv(report, '=formula');
  expect(csv).toContain('"\'=formula,""test"""'); expect(csv).toContain('"-1"'); expect(csv).not.toContain('excluded'); expect(csv).toContain('start_utc'); expect(csv).toContain('provider units');
});
