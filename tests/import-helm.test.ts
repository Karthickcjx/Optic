import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { c } from 'tar';
import { execFile } from 'node:child_process';
import { Imports, inspectArchive } from '../src/main/imports';
import { Deployments } from '../src/main/deploy';
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.clearAllMocks(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'optic-chart-test-')); const chart = join(dir, 'app'); mkdirSync(chart); mkdirSync(join(chart, 'templates'));
  writeFileSync(join(chart, 'Chart.yaml'), 'apiVersion: v2\nname: app\nversion: 1.0.0\n');
  writeFileSync(join(chart, 'templates', 'config.yaml'), 'original');
  const imports = new Imports(); const deploy = new Deployments({ get: () => ({ config: {} }), cliConfig: () => ({ path: join(dir, 'config'), cleanup: () => {} }) } as any, imports, () => false);
  cleanup.push(() => { deploy.close(); imports.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, chart, imports, deploy };
}
it('renders and installs the same snapshot with ordered values and isolated Helm configuration', async () => {
  const { dir, chart, imports, deploy } = fixture(); const captured: any[] = [];
  vi.mocked(execFile).mockImplementation(((binary: string, args: string[], options: any, callback: any) => {
    captured.push({ binary, args, options, values: args.flatMap((a, i) => a === '--values' ? [readFileSync(args[i + 1], 'utf8')] : []), chart: readFileSync(join(args[2], 'templates', 'config.yaml'), 'utf8') });
    queueMicrotask(() => callback(null, 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: example\n'));
    return { stdin: { end: vi.fn() }, kill: vi.fn() };
  }) as any);
  const source = await imports.add('chart', [chart], 1); const valuesFile = join(dir, 'values.yaml'); writeFileSync(valuesFile, 'replicas: 2\n'); const values = await imports.add('values', [valuesFile], 1);
  const preview = await deploy.prepare({ clusterId: 'cluster', namespace: 'team', sourceId: source.id, files: [], release: 'app', action: 'install', valuesIds: [values.id], values: 'replicas: 3\n' }, 1);
  expect(preview.rows[0].state).toBe('rendered');
  writeFileSync(join(chart, 'templates', 'config.yaml'), 'changed'); imports.dispose(source.id, 1);
  deploy.start(preview.id, 1); await vi.waitFor(() => expect(deploy.status()[0].status).toBe('succeeded'));
  expect(captured).toHaveLength(2); expect(captured.map(c => c.chart)).toEqual(['original', 'original']);
  expect(captured[1].values).toEqual(['replicas: 2\n', 'replicas: 3\n']); expect(captured[1].args).toContain('--wait');
  expect(captured[0].options.shell).toBe(false); expect(captured[0].options.env.HELM_PLUGINS).toContain('no-plugins');
});
it('accepts packaged charts and rejects archives containing links', async () => {
  const { dir, imports } = fixture(); const archive = join(dir, 'app.tgz'); await c({ gzip: true, cwd: dir, file: archive }, ['app']);
  await expect(inspectArchive(archive)).resolves.toBeUndefined();
  const source = await imports.add('archive', [archive], 1); expect(source.chart).toMatchObject({ name: 'app', version: '1.0.0' });
  linkSync(join(dir, 'app', 'Chart.yaml'), join(dir, 'app', 'linked.yaml'));
  const linked = join(dir, 'links.tgz'); await c({ gzip: true, cwd: dir, file: linked }, ['app']);
  await expect(inspectArchive(linked)).rejects.toThrow();
});
it('rejects Kustomize remote references before invoking kubectl', async () => {
  const { dir, imports, deploy } = fixture(); const overlay = join(dir, 'overlay'); mkdirSync(overlay); writeFileSync(join(overlay, 'kustomization.yaml'), 'resources:\n- https://example.com/base\n');
  const source = await imports.add('kustomize', [overlay], 1);
  await expect(deploy.prepare({ clusterId: 'test', namespace: 'default', sourceId: source.id, files: source.files, release: '', action: 'install', valuesIds: [], values: '{}' }, 1)).rejects.toThrow('Remote Kustomize');
  expect(execFile).not.toHaveBeenCalled();
});
