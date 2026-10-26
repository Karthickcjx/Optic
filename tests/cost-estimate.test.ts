import { beforeEach, expect, it, vi } from 'vitest';
import { allocateEstimate, CostEstimates, estimatePoints, estimateQueries } from '../src/main/cost-estimate';
import { priceNode, awsHourly, azureHourly, nodeFacts } from '../src/main/node-pricing';
import { defaultClusterSettings as defaults } from '../src/shared/cluster-settings';
import { clusterSettingsSchema } from '../src/main/cluster-settings';
import { kubeJson } from '../src/main/kube-http';
import type { CostQuery, NodePrice } from '../src/shared/cost';
vi.mock('../src/main/kube-http', () => ({ kubeJson: vi.fn() }));
const hour = 3600, GiB = 1024 ** 3;
const query: CostQuery = { clusterId: 'c', start: 0, end: hour * 2000, group: 'namespace', includeIdle: true };
const price: NodePrice = { node: 'worker', cloud: 'AWS', region: 'us-east-1', instanceType: 'test.large', spot: false, cpu: 4, memoryGiB: 8, hourly: 0.48, cpuHourly: 0.1, memoryHourly: 0.01, source: 'test rate' };
const point = (labels: Record<string, string>, value: number) => ({ labels, points: new Map([[hour, value], [hour * 2, value]]) });
const observations = () => {
  const pod = { namespace: 'team', pod: 'api', node: 'worker' }, node = { node: 'worker' };
  return { cpuRequests: [point(pod, 1)], memoryRequests: [point(pod, 2 * GiB)], cpuUsage: [point(pod, 0.5)], memoryUsage: [point(pod, GiB)], cpuCapacity: [point(node, 4)], memoryCapacity: [point(node, 8 * GiB)] };
};
beforeEach(() => vi.resetAllMocks());
it('integrates observed requests/usage and idle capacity while preserving the node price', () => {
  const report = allocateEstimate(query, hour, hour * 2, hour, observations(), [price]);
  expect(report.buckets).toHaveLength(2); expect(report.total).toBeCloseTo(0.96);
  expect(report.allocations.find(r => r.name === 'team')!.total).toBeCloseTo(0.24);
  expect(report.idleCost).toBeCloseTo(0.72); expect(report.efficiency).toEqual({ cpu: 0.5, memory: 0.5 }); expect(report.coverage).toBe(1);
  const used = allocateEstimate({ ...query, includeIdle: false }, hour, hour * 2, hour, observations(), [price]);
  expect(used.total).toBeCloseTo(0.24); expect(used.idleCost).toBeCloseTo(0.72);
  const node = allocateEstimate({ ...query, group: 'node' }, hour, hour * 2, hour, observations(), [price]);
  expect(node.allocations[0].name).toBe('worker'); expect(node.total).toBeCloseTo(report.total!);
});
it('uses usage above requests and leaves zero-request efficiency unavailable', () => {
  const rows = observations(); rows.cpuRequests[0].points = new Map([[hour, 0], [2 * hour, 0]]);
  const report = allocateEstimate({ ...query, includeIdle: false }, hour, hour * 2, hour, rows, [price]);
  expect(report.allocations[0].components.cpu).toBeCloseTo(0.1); expect(report.efficiency?.cpu).toBeUndefined();
});
it('does not charge missing samples as idle or historical zero cost', () => {
  const rows = observations(); rows.memoryUsage[0].points.delete(hour * 2);
  const report = allocateEstimate(query, hour, hour * 2, hour, rows, [price]);
  expect(report.buckets).toHaveLength(1); expect(report.total).toBeCloseTo(0.48); expect(report.coverage).toBe(0.5); expect(report.warnings.join()).toContain('partial');
  rows.memoryUsage = [];
  expect(allocateEstimate(query, hour, hour * 2, hour, rows, [price]).total).toBeNull();
});
it('resolves historical ReplicaSet ownership to Deployment and falls back to Pod honestly', () => {
  const rows = { ...observations(), owners: [point({ namespace: 'team', pod: 'api', owner_kind: 'ReplicaSet', owner_name: 'api-v1' }, 1)], replicaOwners: [point({ namespace: 'team', replicaset: 'api-v1', owner_kind: 'Deployment', owner_name: 'api' }, 1)] };
  const report = allocateEstimate({ ...query, group: 'controller', includeIdle: false }, hour, hour * 2, hour, rows, [price]);
  expect(report.allocations[0].name).toBe('team/Deployment/api');
  rows.owners = []; expect(allocateEstimate({ ...query, group: 'controller' }, hour, hour * 2, hour, rows, [price]).warnings.join()).toContain('grouped by Pod');
});
it('deduplicates duplicate scrape identities and rejects non-finite or excessive samples', () => {
  const rows = observations(); rows.cpuUsage.push(rows.cpuUsage[0]);
  expect(allocateEstimate(query, hour, hour * 2, hour, rows, [price]).efficiency?.cpu).toBe(0.5);
  const parsed = estimatePoints({ status: 'success', data: { resultType: 'matrix', result: [{ metric: { node: 'a' }, values: [[1, 'NaN'], [2, ''], [3, '-1'], [4, '0']] }] } }, 1, 4);
  expect([...parsed[0].points.values()]).toEqual([0]);
  expect(() => estimatePoints({ status: 'error' }, 1, 4)).toThrow();
  expect(() => estimatePoints({ status: 'success', data: { resultType: 'matrix', result: Array(1001).fill({}) } }, 1, 4)).toThrow('1,000');
});
it('discovers node facts and falls back to independently configurable resource rates', async () => {
  const node = { metadata: { name: 'worker', labels: { 'node.kubernetes.io/instance-type': 'test.large', 'topology.kubernetes.io/region': 'us-east-1', 'karpenter.sh/capacity-type': 'spot' } }, spec: { providerID: 'aws:///id' }, status: { capacity: { cpu: '4', memory: '8Gi' } } };
  expect(nodeFacts(node)).toMatchObject({ cpu: 4, memoryGiB: 8, cloud: 'AWS', spot: true });
  const fallback = await priceNode(node, defaults, async () => { throw new Error('Offline'); });
  expect(fallback.hourly).toBeCloseTo(0.152); expect(fallback.source).toContain('fallback');
  const reader = vi.fn(); const override = await priceNode(node, { ...defaults, estimatedNodeHourlyCost: 1 }, reader);
  expect(reader).not.toHaveBeenCalled(); expect(override.cpuHourly * 4 + override.memoryHourly * 8).toBeCloseTo(1);
});
it('uses independently fetched AWS price and retains provenance without sending node names', async () => {
  const node = { metadata: { name: 'private-node', labels: { 'node.kubernetes.io/instance-type': 'test.large', 'topology.kubernetes.io/region': 'test-1' } }, spec: { providerID: 'aws:///id' }, status: { capacity: { cpu: '4', memory: '8Gi' } } };
  const data = { manifest: { currencyCode: 'USD' }, regions: { Test: { one: { 'Instance Type': 'test.large', 'Operating System': 'Linux', 'Pre Installed S/W': 'NA', price: '0.4' } } } };
  const reader = vi.fn().mockResolvedValueOnce({ Test: { name: 'Test', code: 'test-1', type: 'AWS Region' } }).mockResolvedValueOnce(data);
  const resolved = await priceNode(node, defaults, reader);
  expect(resolved.hourly).toBe(0.4); expect(resolved.source).toContain('AWS Linux'); expect(reader.mock.calls.flat().join()).not.toContain('private-node');
  expect(awsHourly({ ...data, manifest: { currencyCode: 'EUR' } }, 'Test', 'test.large')).toBeUndefined();
});
it('filters Azure OS, market, currency and unit rather than choosing an arbitrary price', () => {
  const row = { armRegionName: 'eastus', armSkuName: 'test', currencyCode: 'USD', type: 'Consumption', unitOfMeasure: '1 Hour', isPrimaryMeterRegion: true, productName: 'VM', meterName: 'VM', retailPrice: 0.2 };
  expect(azureHourly({ Items: [row, { ...row, productName: 'VM Windows', retailPrice: 0.5 }] }, 'eastus', 'test', false)).toBe(0.2);
  expect(azureHourly({ Items: [row] }, 'eastus', 'test', true)).toBeUndefined();
});
it('migrates old settings and bounds rate settings', () => {
  const { estimatePublicPrices, estimatedCpuHourlyCost, estimatedMemoryHourlyCost, ...old } = defaults;
  expect(clusterSettingsSchema.parse(old).estimatePublicPrices).toBe(true);
  expect(clusterSettingsSchema.safeParse({ ...defaults, estimatedCpuHourlyCost: -1 }).success).toBe(false);
});
it('queries selected Prometheus, discovers nodes and caches identical requests', async () => {
  const settings = { ...defaults, costSource: 'estimate', estimatePublicPrices: false, prometheus: { namespace: 'metrics', service: 'prom', port: 9090 } };
  const queries = estimateQueries(60, false);
  vi.mocked(kubeJson).mockImplementation(async (_config, path) => {
    if (path === '/api/v1/nodes') return { items: [{ metadata: { name: 'worker' }, status: { capacity: { cpu: '4', memory: '8Gi' } } }] };
    const url = new URL(path, 'http://test'), expression = url.searchParams.get('query');
    const key = Object.entries(queries).find(([, v]) => v === expression)![0];
    const labels = key.includes('Capacity') ? { node: 'worker' } : { namespace: 'team', pod: 'api', node: 'worker' };
    return { status: 'success', data: { resultType: 'matrix', result: [{ metric: labels, values: [[60, key.startsWith('memory') ? String(GiB) : '1'], [120, key.startsWith('memory') ? String(GiB) : '1']] }] } };
  });
  const service = new CostEstimates({ get: () => ({ config: {} }), settings: () => settings } as any);
  const input = { ...query, end: 120000 }; const report = await service.read(input);
  expect(report.buckets).toHaveLength(2); expect(report.estimated).toBe(true); expect(report.source).toContain('metrics/prom');
  const calls = vi.mocked(kubeJson).mock.calls.length; await service.read(input); expect(vi.mocked(kubeJson).mock.calls).toHaveLength(calls);
  expect(vi.mocked(kubeJson).mock.calls[1][1]).toContain('/namespaces/metrics/services/prom%3A9090/proxy/');
});

it('does not warn about missing history when only the request edges are rounded', () => {
  const report = allocateEstimate({ ...query, start: -30000, end: query.end + 30000 }, hour, hour * 2, hour, observations(), [price]);
  expect(report.coverage).toBeLessThan(0.999);
  expect(report.historyCoverage).toMatchObject({ expectedIntervals: 2, observedIntervals: 2, missingIntervals: 0, edgeExcludedMilliseconds: 60000 });
  expect(report.warnings.join()).not.toContain('Historical coverage');
  expect(report.notes?.join()).toContain('rounding');
});
it('reports actual observed bounds and missing intervals without filling gaps', () => {
  const rows = observations(); rows.cpuUsage[0].points.delete(hour);
  const report = allocateEstimate(query, hour, hour * 2, hour, rows, [price]);
  expect(report.historyCoverage).toMatchObject({ expectedIntervals: 2, observedIntervals: 1, missingIntervals: 1, observedMilliseconds: 3600000, observedStart: 3600000, observedEnd: 7200000 });
  expect(report.warnings.join()).toContain('1 sampling intervals');
});
