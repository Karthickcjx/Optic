import { it, expect, vi, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { Monitoring } from '../src/main/monitoring';
import { schemas } from '../src/main/validation';
import { existsSync, readFileSync } from 'node:fs';
import { helmFailure } from '../src/main/helm-cli';
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
it('isolates monitoring from broken user repositories and removes its cache after completion', async () => {
  const paths: string[] = [];
  vi.mocked(execFile).mockImplementation((...params: any[]) => {
    const args = params[1] as string[], config = args[args.indexOf('--repository-config') + 1], cache = args[args.indexOf('--repository-cache') + 1];
    expect(readFileSync(config, 'utf8')).toBe('apiVersion: v1\nrepositories: []\n');
    expect(existsSync(cache)).toBe(true); paths.push(cache);
    const child = { kill: vi.fn() };
    queueMicrotask(() => params.at(-1)(null, '[]', ''));
    return child as any;
  });
  const cleanup = vi.fn();
  const service = new Monitoring({ cliConfig: () => ({ path: 'temporary-config', cleanup }) } as any);
  await expect(service.status('cluster')).resolves.toEqual([]);
  expect(paths.every(path => !existsSync(path))).toBe(true);
  expect(cleanup).toHaveBeenCalledOnce();
});
it('cleans the isolated cache on Helm failure and gives a safe cache-specific error', async () => {
  let cache = '';
  vi.mocked(execFile).mockImplementation((...params: any[]) => {
    const args = params[1] as string[]; cache = args[args.indexOf('--repository-cache') + 1];
    queueMicrotask(() => params.at(-1)({ code: 1 }, '', 'Error: no cached repo found: private-path/bitnami-index.yaml'));
    return { kill: vi.fn() } as any;
  });
  const cleanup = vi.fn();
  await expect(new Monitoring({ cliConfig: () => ({ path: 'temporary-config', cleanup }) } as any).status('cluster')).rejects.toThrow('repository cache');
  expect(existsSync(cache)).toBe(false); expect(cleanup).toHaveBeenCalledOnce();
  expect(helmFailure({}, 'no cached repo found private-path')).not.toContain('private-path');
});
