import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HelmService, installArgs, redactManifest, validateValues } from '../src/main/helm';
import { helmFailure, helmReleaseStatuses } from '../src/main/helm-cli';
import { schemas } from '../src/main/validation';
import type { HelmInstall } from '../src/shared/helm';
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('../src/main/helm-index', () => ({ parseHelmIndex: async (source: string) => {
 const { parse } = await import('yaml');
 const entries = parse(source).entries;
 for (const versions of Object.values(entries) as any[][]) versions.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
 return entries;
} }));
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'optic-helm-test-')); vi.resetAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });
const plan: HelmInstall = { clusterId: 'c', namespace: 'team', release: 'web', action: 'install', repository: 'bitnami', chart: 'nginx', version: '2.0.0', values: 'replicaCount: 2' };
function setup(otherBusy = () => false) {
 const paths: string[] = [];
 const clusters = { cliConfig: vi.fn(() => { const dir = mkdtempSync(join(root, 'session-')); const path = join(dir, 'config'); writeFileSync(path, 'private-config'); paths.push(path); return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }; }) };
 const service = new HelmService(clusters as any, join(root, 'repos.json'), otherBusy);
 vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ apiVersion: 'v1', entries: { nginx: [{ name: 'nginx', version: '1.9.0', urls: ['nginx-1.9.0.tgz'] }, { name: 'nginx', version: '2.0.0', appVersion: '1.27', urls: ['oci://registry.example.com/charts/nginx'] }] } }))));
 return { service, paths, clusters };
}
function respond(fn: (args: string[]) => string) {
 vi.mocked(execFile).mockImplementation((...args: any[]) => { const output = fn(args[1]); queueMicrotask(() => args.at(-1)(null, output)); return { kill: vi.fn() } as any; });
}
it('isolates catalog commands from CLI repository caches and cleans up on success and failure', async () => {
 const { service } = setup(); const directories: string[] = [];
 respond(args => {
  const directory = args[args.indexOf('--repository-cache') + 1];
  directories.push(directory);
  expect(readFileSync(args[args.indexOf('--repository-config') + 1], 'utf8')).toBe('apiVersion: v1\nrepositories: []\n');
  expect(existsSync(directory)).toBe(true);
  return '{}';
 });
 await service.chartInfo('bitnami', 'nginx', '2.0.0');
 expect(new Set(directories).size).toBe(2);
 expect(directories.every(dir => !existsSync(dir))).toBe(true);
 vi.mocked(execFile).mockImplementation((...args: any[]) => {
  directories.push(args[1][args[1].indexOf('--repository-cache') + 1]);
  queueMicrotask(() => args.at(-1)({code: 1}, '', 'no cached repo found private-path'));
  return {kill: vi.fn()} as any;
 });
 await expect(service.releases('c')).rejects.toThrow('repository cache');
 expect(directories.every(dir => !existsSync(dir))).toBe(true);
});
it('reads and persists public repository catalogs without executing Helm', async () => {
 const { service } = setup();
 expect((await service.charts('bitnami'))[0]).toMatchObject({ name: 'nginx', version: '2.0.0' });
 expect((await service.versions('bitnami', 'nginx')).map(v => v.version)).toEqual(['2.0.0', '1.9.0']);
 expect(execFile).not.toHaveBeenCalled();
 service.saveRepository({ name: 'custom', url: 'https://charts.example.com' });
 expect(new HelmService({} as any, join(root, 'repos.json')).repositories()).toContainEqual({ name: 'custom', url: 'https://charts.example.com' });
 expect(schemas['helm:repository-save'].safeParse({ repository: { name: 'x', url: 'https://user:password@example.com' }, remove: false }).success).toBe(false);
});
it('shares concurrent index requests and reuses the parsed catalog', async () => {
 const { service } = setup();
 await Promise.all([service.charts('bitnami'), service.versions('bitnami', 'nginx'), service.charts('bitnami')]);
 expect(fetch).toHaveBeenCalledTimes(1);
 await service.charts('bitnami');
 expect(fetch).toHaveBeenCalledTimes(1);
 await service.charts('bitnami', true);
 expect(fetch).toHaveBeenCalledTimes(2);
});
it('pins the exact preview inputs, hides Secret payloads, scopes commands and removes private files', async () => {
 const { service, paths } = setup();
 respond(args => {
  expect(args).toContain('--kubeconfig');
  const values = args[args.indexOf('--values') + 1]; expect(readFileSync(values, 'utf8')).toBe(plan.values);
  return args[0] === 'template' ? 'apiVersion: v1\nkind: Secret\nmetadata: {name: test}\ndata: {password: private-value}\n' : '';
 });
 const preview = await service.preview(plan);
 expect(preview.manifest).not.toContain('private-value');
 await expect(service.apply({ ...plan, values: 'replicaCount: 3' }, preview.token)).rejects.toThrow('Preview');
 await service.apply(plan, preview.token);
 expect(vi.mocked(execFile).mock.calls[1][1]).toEqual(expect.arrayContaining(['install', 'web', 'oci://registry.example.com/charts/nginx', '--version', '2.0.0', '--namespace', 'team', '--create-namespace']));
 expect(paths.every(p => !existsSync(p))).toBe(true);
 await expect(service.apply(plan, preview.token)).rejects.toThrow('Preview');
});
it('keeps upgrades separate from installs and rejects invalid inputs', () => {
 const args = installArgs({ ...plan, action: 'upgrade' }, 'https://example.com/chart.tgz', 'values.yaml');
 expect(args[0]).toBe('upgrade'); expect(args).toContain('--reset-values'); expect(args).not.toContain('--install');
 expect(() => validateValues('- array')).toThrow('mapping'); expect(() => validateValues('key: [bad')).toThrow();
 expect(schemas['helm:preview'].safeParse({ ...plan, release: '--other' }).success).toBe(false);
 expect(schemas['helm:rollback'].safeParse({ ...plan, revision: 0 }).success).toBe(false);
 expect(redactManifest('kind: List\nitems:\n- kind: Secret\n  stringData: {password: sensitive}').manifest).not.toContain('sensitive');
});
it('lists releases with namespace scoping and reads release details/history', async () => {
 const { service } = setup();
 respond(args => args[0] === 'list' ? JSON.stringify([{ name: 'web', namespace: 'team' }]) : args[0] === 'history' ? '[{"revision":1,"status":"deployed"}]' : args[0] === 'status' ? '{"info":{"status":"deployed"}}' : args[1] === 'values' ? 'replicaCount: 2' : args[1] === 'manifest' ? 'kind: ConfigMap\nmetadata: {name: web}' : 'Release notes');
 expect(await service.releases('c', 'team')).toHaveLength(1);
 expect(vi.mocked(execFile).mock.calls[0][1]).toContain('team');
 expect(vi.mocked(execFile).mock.calls[0][1]).not.toContain('--all');
 expect(vi.mocked(execFile).mock.calls[0][1]).toEqual(expect.arrayContaining(helmReleaseStatuses));
 const result = await service.details(plan); expect(result.status).toBe('deployed'); expect(result.history[0].revision).toBe(1); expect(result.notes).toBe('Release notes');
});
it('scopes rollback/uninstall, serializes mutations and releases locks after a blocked executable', async () => {
 const { service, paths } = setup(); respond(() => '');
 await service.rollback(plan, 2); await service.uninstall(plan);
 expect(vi.mocked(execFile).mock.calls[0][1]).toEqual(expect.arrayContaining(['rollback', 'web', '2', '--namespace', 'team']));
 expect(vi.mocked(execFile).mock.calls[1][1]).toEqual(expect.arrayContaining(['uninstall', 'web', '--namespace', 'team']));
 vi.mocked(execFile).mockImplementation(() => { throw new Error('spawn UNKNOWN'); });
 await expect(service.uninstall(plan)).rejects.toThrow('application-control'); expect(service.isBusy('c')).toBe(false);
 expect(paths.every(p => !existsSync(p))).toBe(true);
 const locked = setup(() => true); await expect(locked.service.uninstall(plan)).rejects.toThrow('already running');
});

it('classifies Helm failures without disclosing stderr secrets', () => {
 expect(helmFailure({}, 'context deadline exceeded private-token')).toContain('timed out');
 expect(helmFailure({}, 'cannot re-use a name that is still in use')).toContain('already exists');
 expect(helmFailure({}, 'unknown flag: --all')).toContain('does not support');
 expect(helmFailure({}, 'arbitrary private-token')).not.toContain('private-token');
 expect(helmFailure({code:'ENOENT'})).toContain('PATH');
});

it('serializes downloads of the same chart across defaults and preview', async () => {
 const { service } = setup();
 let active = 0, peak = 0;
 vi.mocked(execFile).mockImplementation((...args: any[]) => {
  active++; peak = Math.max(peak, active);
  setTimeout(() => { active--; args.at(-1)(null, args[1][0] === 'template' ? 'kind: ConfigMap\nmetadata: {name: test}' : 'chart information'); }, 5);
  return { kill: vi.fn() } as any;
 });
 const [info, preview] = await Promise.all([service.chartInfo('bitnami', 'nginx', '2.0.0'), service.preview(plan)]);
 expect(info).toEqual({ values: 'chart information', readme: 'chart information' });
 expect(preview.resources).toBe(1);
 expect(peak).toBe(1);
 expect(execFile).toHaveBeenCalledTimes(3);
});

it('releases the chart queue after a download failure and stops queued work on disposal', async () => {
 const { service } = setup();
 let fail = true;
 vi.mocked(execFile).mockImplementation((...args: any[]) => {
  queueMicrotask(() => { const error = fail ? { code: 1 } : null; fail = false; args.at(-1)(error, 'chart information', ''); });
  return { kill: vi.fn() } as any;
 });
 await expect(service.chartInfo('bitnami', 'nginx', '2.0.0')).rejects.toThrow('Helm failed');
 await expect(service.chartInfo('bitnami', 'nginx', '2.0.0')).resolves.toEqual({ values: 'chart information', readme: 'chart information' });
 service.dispose();
 const calls = vi.mocked(execFile).mock.calls.length;
 await expect(service.chartInfo('bitnami', 'nginx', '2.0.0')).rejects.toThrow('closed');
 expect(execFile).toHaveBeenCalledTimes(calls);
});
