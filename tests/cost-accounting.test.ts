import { describe, expect, it, vi } from 'vitest';
import { parseCostReport, CostReports } from '../src/main/cost-report';
import { parsePriceHistory } from '../src/main/cost-price-history';
import { componentSummary, costCsv, effectiveRate, type CostQuery } from '../src/shared/cost';
import { kubeJson } from '../src/main/kube-http';
import { defaultClusterSettings } from '../src/shared/cluster-settings';
vi.mock('../src/main/kube-http', () => ({ kubeJson: vi.fn() }));
const query: CostQuery = { clusterId: 'test', start: 0, end: 7200000, group: 'namespace', includeIdle: true };
const row = (start: number, extra = {}) => ({ totalCost: 20, cpuCost: 4, ramCost: 2, gpuCost: 8, pvCost: 4, networkCost: 2, cpuCoreHours: 2, ramByteHours: 2 * 1024 ** 3, gpuHours: 1, pvByteHours: 4 * 1024 ** 3, networkTransferBytes: 1024 ** 3, networkCrossZoneCost: 0.5, networkCrossRegionCost: 0.5, networkInternetCost: 1, window: { start: new Date(start).toISOString(), end: new Date(start + 3600000).toISOString() }, ...extra });
describe('richer cost accounting', () => {
  it('uses whole-second provider windows rounded inside the requested range', async () => {
    vi.mocked(kubeJson).mockImplementation(async (_config, path) => {
      const window = new URL(path, 'http://test').searchParams.get('window');
      const params = new URL(path, 'http://test').searchParams;
      if (params.get('step') === '1h') expect(window).toBe('1970-01-01T00:00:01Z,1970-01-01T01:00:01Z');
      else { expect(window).toBe('1970-01-01T01:00:01Z,1970-01-01T02:00:00Z'); expect(params.get('step')).toBe('3599s'); }
      return { data: [] };
    });
    const manager = { get: () => ({ config: {} }), settings: () => ({ ...defaultClusterSettings, costSource: 'opencost', costEndpoint: { namespace: 'cost', service: 'opencost', port: 9003 } }) } as any;
    await new CostReports(manager).read({ ...query, start: 123, end: 7200456 });
  });
  it('retains units, network classifications and adjustments without adding network twice', () => {
    const result = parseCostReport({ currency: 'USD', data: [{ team: row(0, { totalCost: 19, gpuCostAdjustment: -1 }) }, { team: row(3600000) }] }, query);
    const team = result.allocations[0];
    expect(team.total).toBe(39); expect(team.components).toMatchObject({ cpu: 8, memory: 4, gpu: 15, storage: 8, network: 4 });
    expect(team.usage).toEqual({ cpuCoreHours: 4, memoryGiBHours: 4, gpuHours: 2, storageGiBHours: 8, networkGiB: 2 });
    expect(team.network).toEqual({ zone: 1, region: 1, internet: 2 });
    expect(effectiveRate([team], 'gpu')).toBe(7.5);
    const csv = costCsv({ ...query, ...result, source: 'OpenCost GCP', estimated: false, generatedAt: 0 });
    expect(csv).toContain('storageGiBHours'); expect(csv).toContain('network_internet_cost');
  });
  it('shows historical rate changes instead of repricing old usage with the latest rate', () => {
    const result = parseCostReport({ data: [{ team: row(0) }, { team: row(3600000, { cpuCost: 8, totalCost: 24 }) }] }, query);
    expect(result.buckets.map(b => effectiveRate(b.allocations, 'cpu'))).toEqual([2, 4]);
    expect(result.total).toBe(44);
  });
  it('keeps partial usage and component costs unavailable, and reports partial component sums', () => {
    const result = parseCostReport({ data: [{ a: row(0), b: row(0, { gpuCost: undefined, gpuHours: undefined }) }, { a: row(3600000, { pvByteHours: undefined }) }] }, query);
    expect(effectiveRate(result.allocations, 'gpu')).toBeUndefined();
    expect(effectiveRate(result.allocations, 'storage')).toBeUndefined();
    expect(componentSummary(result.allocations, 'gpu')).toEqual({ total: 16, reported: 1, count: 2 });
  });
  it('does not accept invalid adjustments or quantities as valid rates', () => {
    const result = parseCostReport({ data: [{ a: row(0, { cpuCostAdjustment: '5', gpuHours: -1 }) }] }, query);
    expect(result.allocations[0].components.cpu).toBeUndefined();
    expect(effectiveRate(result.allocations, 'gpu')).toBeUndefined();
  });
});
describe('retained cloud price history', () => {
  const response = (values: unknown = [[0, '0.02'], [3600, '0.04']]) => ({ status: 'success', data: { resultType: 'matrix', result: [{ metric: { __name__: 'node_cpu_hourly_cost', node: 'gke-node', provider_id: 'gce://project/zone/node', cluster: 'gke-test' }, values }] } });
  it('preserves GCP identity and actual price changes', () => {
    expect(parsePriceHistory(response(), query)).toEqual([{ resource: 'cpu', identity: 'gke-node', cloud: 'GCP', cluster: 'gke-test', unit: 'USD/core-hour', samples: [{ time: 0, price: 0.02 }, { time: 3600000, price: 0.04 }] }]);
  });
  it('rejects ambiguous series and omits invalid and out-of-range samples', () => {
    const duplicate = response(); duplicate.data.result.push(duplicate.data.result[0]);
    expect(() => parsePriceHistory(duplicate, query)).toThrow('conflicting');
    expect(parsePriceHistory(response([[0, 'NaN'], [5, '-1'], [6, ''], [9000, '1'], [3600, '0']]), query)[0].samples).toEqual([{ time: 3600000, price: 0 }]);
    expect(() => parsePriceHistory(response(Array(302).fill([0, '1'])), query)).toThrow('too many');
  });
  it('fetches prices separately without changing historical allocation totals', async () => {
    vi.mocked(kubeJson).mockImplementation(async (_config, path) => path.includes('query_range') ? response() : { currency: 'USD', data: [{ team: row(0) }] });
    const manager = { get: () => ({ config: {} }), settings: () => ({ ...defaultClusterSettings, costSource: 'opencost', costPriceHistory: true, costEndpoint: { namespace: 'cost', service: 'opencost', port: 9003 }, prometheus: { namespace: 'metrics', service: 'prometheus', port: 9090 } }) } as any;
    const result = await new CostReports(manager).read(query);
    expect(result.total).toBe(20); expect(result.priceHistory?.[0].cloud).toBe('GCP');
    vi.mocked(kubeJson).mockImplementation(async (_config, path) => { if (path.includes('query_range')) throw new Error('Denied'); return { data: [{ team: row(0) }] }; });
    const partial = await new CostReports(manager).read(query);
    expect(partial.total).toBe(20); expect(partial.warnings.join()).toContain('price history could not be read');
  });
});
