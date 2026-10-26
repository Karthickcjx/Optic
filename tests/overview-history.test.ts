import { beforeEach, expect, it, vi } from 'vitest';
import { OverviewMetrics, overviewSamples } from '../src/main/overview-metrics';
import { kubeJson } from '../src/main/kube-http';
import { defaultClusterSettings } from '../src/shared/cluster-settings';
import { historySegments, scopedUsage, selectNodes } from '../src/shared/metrics';
import { schemas } from '../src/main/validation';
vi.mock('../src/main/kube-http', () => ({ kubeJson: vi.fn() }));
const matrix = (rows: any[]) => ({ status: 'success', data: { resultType: 'matrix', result: rows } });
const row = (node: string, values: any[]) => ({ metric: { node }, values });
function setup(source: 'prometheus' | 'automatic' | 'metrics-server' | 'none' = 'prometheus') {
  const settings = { ...defaultClusterSettings, metricsSource: source, prometheus: { namespace: 'monitoring', service: 'prometheus', port: 9090 } };
  const clusters = { settings: () => settings, get: vi.fn(() => ({ config: {} })) };
  return { settings, service: new OverviewMetrics(clusters as any), clusters };
}
beforeEach(() => vi.resetAllMocks());
it('loads past CPU and memory immediately with bounded range requests through the service proxy', async () => {
  const { service } = setup();
  vi.mocked(kubeJson).mockImplementation(async (_config, path) => {
    const params = new URL('http://test' + path).searchParams;
    expect(path).toContain('/namespaces/monitoring/services/prometheus%3A9090/proxy/api/v1/query_range');
    expect(params.get('timeout')).toBe('10s');
    const end = Number(params.get('end')), start = Number(params.get('start'));
    expect(end - start).toBe(86400); expect((end - start) / Number(params.get('step'))).toBeLessThanOrEqual(240);
    return matrix([row('worker', [[start, params.get('query')!.includes('cpu') ? '0.5' : '1024'], [end, '1']])]);
  });
  const data = await service.read('cluster', 1440);
  expect(data.history).toBe(true); expect(data.samples).toHaveLength(2);
  expect(data.samples[0].time).toBe(data.start); expect(data.samples[0].nodes[0].usage).toEqual({ cpu: '0.5', memory: '1024' });
  expect(kubeJson).toHaveBeenCalledTimes(2);
});
it('rejects unbounded time ranges and strips arbitrary PromQL from IPC input', () => {
  expect(schemas['metrics:history'].safeParse({ clusterId: 'c', minutes: 100000 }).success).toBe(false);
  expect(schemas['metrics:history'].parse({ clusterId: 'c', minutes: 60, query: 'secret' })).toEqual({ clusterId: 'c', minutes: 60 });
});
it('keeps missing values absent, preserves zero, sorts and deduplicates nodes and rejects oversized data', () => {
  const response = matrix([row('worker', [[20, 'NaN'], [10, '0'], [30, '-1'], [40, '2'], [50, 'Infinity']]), row('worker', [[40, '2']])]);
  const samples = overviewSamples([{ key: 'cpu', response }], 10000, 50000);
  expect(samples.map(s => s.time)).toEqual([10000, 40000]);
  expect(samples[0].nodes[0].usage).toEqual({ cpu: '0' }); expect(samples[1].nodes).toHaveLength(1);
  expect(() => overviewSamples([{ key: 'cpu', response: matrix(Array(501).fill(row('a', []))) }], 0, 1)).toThrow('500');
  expect(() => overviewSamples([{ key: 'cpu', response: {} }], 0, 1)).toThrow('invalid');
});
it('scopes historical instance addresses to workers and breaks chart lines across missing intervals', () => {
  const nodes = [{ metadata: { name: 'control', labels: { 'node-role.kubernetes.io/control-plane': '' } } }, { metadata: { name: 'worker' }, status: { addresses: [{ address: '10.0.0.2' }] } }];
  const samples = overviewSamples([{ key: 'cpu', response: matrix([{ metric: { instance: '10.0.0.2:10250' }, values: [[10, '2']] }, row('control', [[10, '1']])]) }], 0, 20000);
  expect(scopedUsage(samples[0].nodes, selectNodes(nodes, 'workers'), false).cpu).toBe(2);
  expect(historySegments([{ time: 0, value: 1 }, { time: 15000, value: 2 }, { time: 60000, value: 3 }], 15000).map(s => s.length)).toEqual([2, 1]);
});
it('returns partial historical data and identifies missing memory without inventing zeros', async () => {
  const { service } = setup();
  vi.mocked(kubeJson).mockImplementation(async (_config, path) => {
    const params = new URL('http://test' + path).searchParams;
    if (params.get('query')!.includes('memory')) throw { statusCode: 403 };
    return matrix([row('worker', [[Number(params.get('end')), '1']])]);
  });
  const data = await service.read('c', 15);
  expect(data.history).toBe(true); expect(data.warning).toContain('memory'); expect(data.samples[0].nodes[0].usage.memory).toBeUndefined();
});
it('honors Metrics Server, disabled and hidden choices without querying Prometheus', async () => {
  for (const source of ['metrics-server', 'none'] as const) { const { service } = setup(source); expect((await service.read('c', 15)).history).toBe(false); }
  const hidden = setup(); hidden.settings.hiddenMetrics = ['Cluster']; expect((await hidden.service.read('c', 15)).history).toBe(false);
  expect(kubeJson).not.toHaveBeenCalled();
});
it('supports automatic history even when current gauges use Metrics Server and reports unavailable history safely', async () => {
  const { service } = setup('automatic');
  vi.mocked(kubeJson).mockResolvedValue(matrix([]));
  const data = await service.read('c', 60); expect(data.history).toBe(false); expect(data.warning).toContain('retention');
  expect(kubeJson).toHaveBeenCalledTimes(2);
});
