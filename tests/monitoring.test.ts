import { it, expect, vi, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { Monitoring } from '../src/main/monitoring';
import { schemas } from '../src/main/validation';
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });
function catalog(entries: unknown) {
  return vi.fn(async () => new Response(JSON.stringify({ apiVersion: 'v1', entries })));
}
it('selects the latest stable published version numerically and shares a cached catalog', async () => {
  const fetcher = catalog({ prometheus: [
    { name: 'prometheus', version: '9.9.9' }, { name: 'prometheus', version: '10.2.3', appVersion: '99.0.0' },
    { name: 'prometheus', version: '11.0.0-beta' }, { name: 'other', version: '99.0.0' },
    { name: 'prometheus', version: '12.0.0', deprecated: true }
  ], 'kube-state-metrics': [{ name: 'kube-state-metrics', version: '8.6.0' }] });
  vi.stubGlobal('fetch', fetcher);
  const service = new Monitoring({} as any);
  const results = await Promise.all([service.latestVersion('prometheus'), service.latestVersion('kube-state-metrics')]);
  expect(results).toEqual([{ version: '10.2.3' }, { version: '8.6.0' }]);
  await service.latestVersion('prometheus');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]).toEqual(['https://prometheus-community.github.io/helm-charts/index.yaml', expect.objectContaining({ signal: expect.any(AbortSignal) })]);
  expect(execFile).not.toHaveBeenCalled();
  expect(schemas['monitoring:version'].safeParse({ component: '--bad-option' }).success).toBe(false);
});
it('rejects missing stable versions and invalid catalogs', async () => {
  vi.stubGlobal('fetch', catalog({ prometheus: [] }));
  await expect(new Monitoring({} as any).latestVersion('prometheus')).rejects.toMatchObject({ code: 'CHART_LOOKUP_FAILED' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not: [yaml')));
  await expect(new Monitoring({} as any).latestVersion('prometheus')).rejects.toMatchObject({ code: 'CHART_LOOKUP_FAILED' });
});
it('reports network failures without leaking diagnostics and permits retry', async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new Error('private diagnostics')).mockResolvedValueOnce(new Response(JSON.stringify({ apiVersion: 'v1', entries: { prometheus: [{ name: 'prometheus', version: '1.2.3' }] } })));
  vi.stubGlobal('fetch', fetcher);
  const service = new Monitoring({} as any);
  await expect(service.latestVersion('prometheus')).rejects.toThrow('Check internet access');
  await expect(service.latestVersion('prometheus')).resolves.toEqual({ version: '1.2.3' });
});
it('reports blocked Helm startup and cleans the temporary kubeconfig', async () => {
  vi.mocked(execFile).mockImplementation(() => { throw new Error('spawn UNKNOWN'); });
  const cleanup = vi.fn();
  const service = new Monitoring({ cliConfig: () => ({ path: 'temporary-config', cleanup }) } as any);
  await expect(service.status('cluster')).rejects.toThrow('application-control policy');
  expect(cleanup).toHaveBeenCalledOnce();
});
