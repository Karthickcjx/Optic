import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Imports, safeArchivePath } from '../src/main/imports';
import { Deployments, parseBatch, redacted } from '../src/main/deploy';
import { kubeJson } from '../src/main/kube-http';
vi.mock('../src/main/kube-http', () => ({ kubeJson: vi.fn() }));
const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.clearAllMocks(); });
const manifest = (name: string) => `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\ndata:\n  example: value\n`;
const input = (yaml: string) => ({ clusterId: 'test', namespace: 'default', yaml, files: [], release: '', action: 'install' as const, valuesIds: [], values: '{}' });
function service() {
  const imports = new Imports(); const deploy = new Deployments({ get: () => ({ config: {} }) } as any, imports, () => false);
  cleanup.push(() => { deploy.close(); imports.close(); });
  vi.mocked(kubeJson).mockImplementation(async (_config, path, options) => {
    if (path === '/api/v1') return { resources: [{ name: 'configmaps', kind: 'ConfigMap', namespaced: true, verbs: ['patch'] }] } as any;
    if (!options) throw Object.assign(new Error(), { statusCode: 404 });
    return {};
  });
  return { imports, deploy };
}
it('parses documents and Lists, orders prerequisites and hides Secret payloads', () => {
  const rows = parseBatch([{ name: 'test', text: manifest('test') + '---\napiVersion: v1\nkind: List\nitems:\n- apiVersion: v1\n  kind: Namespace\n  metadata:\n    name: test\n' }]);
  expect(rows.map(r => r.body.kind)).toEqual(['Namespace', 'ConfigMap']);
  expect(JSON.stringify(redacted({ kind: 'Secret', data: { password: 'secret' }, stringData: { token: 'token' } }))).not.toContain('password');
});
it('rejects malformed, empty and unnamed inputs', () => {
  for (const text of ['', 'kind: [', 'apiVersion: v1\nkind: Pod\nmetadata:\n  generateName: app-']) expect(() => parseBatch([{ name: 'file.yaml', text }])).toThrow();
});
it('snapshots file bytes, binds owners and rejects archive traversal', async () => {
  const { imports } = service(); const dir = mkdtempSync(join(tmpdir(), 'optic-test-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'app.yaml'); writeFileSync(path, manifest('first'));
  const source = await imports.add('manifests', [path], 7); writeFileSync(path, manifest('changed'));
  expect(readFileSync(join(imports.get(source.id, 7).directory, source.files[0]), 'utf8')).toContain('first');
  expect(() => imports.get(source.id, 8)).toThrow();
  for (const path of ['../file', '/root/file', 'C:\\file', 'chart/../../escape', '\\\\server\\share']) expect(safeArchivePath(path)).toBe(false);
  expect(safeArchivePath('chart/templates/deploy.yaml')).toBe(true);
});
it('rejects duplicate identities after namespace defaulting', async () => {
  const { deploy } = service(); await expect(deploy.prepare(input(manifest('same') + '---\n' + manifest('same')), 1)).rejects.toThrow('Duplicate');
});
it('binds a single-use plan to its owner and stops on first failure', async () => {
  const { deploy } = service(); const preview = await deploy.prepare(input(['first', 'second', 'third'].map(manifest).join('---\n')), 1);
  expect(preview.rows.every(r => r.namespace === 'default' && r.state === 'validated')).toBe(true);
  expect(() => deploy.start(preview.id, 2)).toThrow();
  const original = vi.mocked(kubeJson).getMockImplementation()!;
  vi.mocked(kubeJson).mockImplementation(async (...args) => { if (args[1].includes('/second?') && !args[1].includes('dryRun')) throw Object.assign(new Error(), { statusCode: 403 }); return original(...args); });
  deploy.start(preview.id, 1); expect(() => deploy.start(preview.id, 1)).toThrow();
  await vi.waitFor(() => expect(deploy.status()[0].status).toBe('failed'));
  expect(deploy.status()[0].rows.map(r => r.state)).toEqual(['succeeded', 'failed', 'skipped']);
});
it('expires previews and discards them explicitly', async () => {
  const { deploy } = service(); const preview = await deploy.prepare(input(manifest('one')), 1);
  deploy.discard(preview.id, 1); expect(() => deploy.start(preview.id, 1)).toThrow();
  const second = await deploy.prepare(input(manifest('two')), 1); const now = vi.spyOn(Date, 'now').mockReturnValue(second.expires + 1);
  expect(() => deploy.start(second.id, 1)).toThrow(); now.mockRestore();
});
