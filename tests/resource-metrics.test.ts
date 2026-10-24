import { beforeEach, expect, it, vi } from 'vitest';
import { ResourceMetrics, metricQueries, rangePoints } from '../src/main/resource-metrics';
import { kubeJson } from '../src/main/kube-http';
import { defaultClusterSettings } from '../src/shared/cluster-settings';
import { schemas } from '../src/main/validation';
vi.mock('../src/main/kube-http', () => ({ kubeJson: vi.fn() }));
const input = { clusterId: 'c', kind: 'pods' as const, namespace: 'team', name: 'api', uid: 'p', minutes: 15 };
const pod = { kind: 'Pod', metadata: { name: 'api', namespace: 'team', uid: 'p' }, spec: { containers: [{ name: 'web' }, { name: 'sidecar' }] } };
function setup(source: 'prometheus' | 'metrics-server' | 'none' = 'prometheus') {
  const settings = { ...defaultClusterSettings, metricsSource: source, prometheus: { namespace: 'monitoring', service: 'prometheus', port: 9090 } };
  const resources = { get: vi.fn(async () => pod), list: vi.fn(async (_scope: any): Promise<any[]> => []) };
  return { service: new ResourceMetrics({ settings: () => settings, get: () => ({ config: {} }) } as any, resources as any), resources };
}
beforeEach(() => vi.resetAllMocks());
it('scopes queries by namespace, exact pod names and container without accepting PromQL input', () => {
  const q = metricQueries('team', ['api.v1', 'worker'], 'web');
  expect(q.cpu).toContain('namespace="team"'); expect(q.cpu).toContain('container="web"');
  expect(q.cpu).toContain('api\\\\.v1|worker');
  expect(q.networkRx).not.toContain('container="web"');
  expect(schemas['metrics:resource'].safeParse({ ...input, minutes: 100000 }).success).toBe(false);
  expect(rangePoints({ status: 'success', data: { resultType: 'matrix', result: [{ values: [[1, 'NaN'], [2, '0'], [3, '-5'], [4, '2.5']] }] } })).toEqual([[2000, 0], [4000, 2.5]]);
});
it('returns historical CPU and marks missing disk series unavailable rather than zero', async () => {
  const { service } = setup();
  vi.mocked(kubeJson).mockImplementation(async (_config, path) => ({ status: 'success', data: { resultType: 'matrix', result: decodeURIComponent(path).includes('container_fs_usage_bytes') ? [] : [{ values: [[100, '2']] }] } }));
  const result = await service.read(input);
  expect(result.history).toBe(true); expect(result.series.cpu).toEqual([[100000, 2]]);
  expect(result.series.filesystem).toEqual([]); expect(result.unavailable.filesystem).toContain('No readable series');
  expect(kubeJson).toHaveBeenCalledTimes(5);
});
it('does not attribute shared network traffic to a selected container', async () => {
  const { service } = setup();
  vi.mocked(kubeJson).mockResolvedValue({ status: 'success', data: { resultType: 'matrix', result: [{ values: [[100, '1']] }] } });
  const result = await service.read({ ...input, container: 'web' });
  expect(result.series.networkRx).toEqual([]); expect(result.unavailable.networkRx).toContain('shared by the Pod');
  expect(kubeJson).toHaveBeenCalledTimes(3);
});
it('uses only matching Pod/container CPU and memory from Metrics Server', async () => {
  const { service } = setup('metrics-server');
  vi.mocked(kubeJson).mockResolvedValue({ items: [{ metadata: { name: 'api', namespace: 'team' }, containers: [{ name: 'web', usage: { cpu: '250m', memory: '64Mi' } }, { name: 'sidecar', usage: { cpu: '1', memory: '1Gi' } }] }, { metadata: { name: 'other', namespace: 'team' }, containers: [{ name: 'web', usage: { cpu: '9' } }] }] });
  const result = await service.read({ ...input, container: 'web' });
  expect(result.history).toBe(false); expect(result.series.cpu[0][1]).toBe(.25); expect(result.series.memory[0][1]).toBe(64 * 1024 ** 2);
  expect(result.series.networkTx).toEqual([]);
});
it('honors disabled metrics and rejects replaced resources', async () => {
  const disabled = setup('none'); expect((await disabled.service.read(input)).warning).toContain('disabled'); expect(disabled.resources.get).not.toHaveBeenCalled();
  const { service } = setup(); await expect(service.read({ ...input, uid: 'old' })).rejects.toThrow('replaced'); expect(kubeJson).not.toHaveBeenCalled();
});
it('distinguishes a missing metrics API from a deleted resource and denied access', async () => {
  const { service, resources } = setup('metrics-server');
  vi.mocked(kubeJson).mockRejectedValue({ statusCode: 404 });
  await expect(service.read(input)).rejects.toThrow('Metrics Server API is not available');
  vi.mocked(kubeJson).mockRejectedValue({ statusCode: 403 });
  await expect(service.read(input)).rejects.toThrow('cannot read Pod metrics');
  vi.mocked(kubeJson).mockRejectedValue({ statusCode: 503 });
  await expect(service.read(input)).rejects.toThrow('registered but unavailable');
  resources.get.mockRejectedValue({ statusCode: 404 });
  await expect(service.read(input)).rejects.toThrow('resource no longer exists');
});
it('aggregates workload Pods only through their owner chain', async () => {
  const { service, resources } = setup();
  resources.get.mockResolvedValue({ kind: 'Deployment', metadata: { name: 'web', namespace: 'team', uid: 'd' } } as any);
  resources.list.mockImplementation(async (scope: any) => (scope.kind === 'replicasets' ? [{ metadata: { uid: 'rs', namespace: 'team', ownerReferences: [{ uid: 'd', controller: true }] } }] : [
    { ...pod, metadata: { ...pod.metadata, ownerReferences: [{ uid: 'rs', controller: true }] } },
    { ...pod, metadata: { name: 'unrelated', namespace: 'team', uid: 'other' } }
  ]) as any);
  vi.mocked(kubeJson).mockImplementation(async (_config, path) => {
    const query = new URL(path, 'http://localhost').searchParams.get('query')!;
    expect(query).toContain('^(api)$'); expect(query).not.toContain('unrelated');
    return { status: 'success', data: { resultType: 'matrix', result: [{ values: [[100, '1']] }] } };
  });
  const result = await service.read({ ...input, kind: 'deployments', name: 'web', uid: 'd' });
  expect(result.podCount).toBe(1);
});
