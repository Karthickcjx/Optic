import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResourceService } from '../src/main/resources';
import { Deployments } from '../src/main/deploy';
import { Imports } from '../src/main/imports';
import { fault } from '../src/main/errors';
import { schemas } from '../src/main/validation';
import { kubeFailure, kubeJson } from '../src/main/kube-http';
vi.mock('../src/main/kube-http', async original => ({ ...await original<typeof import('../src/main/kube-http')>(), kubeJson: vi.fn() }));

const configMap = (name: string) => `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\ndata:\n  key: value\n`;
const conflictMessage = 'Apply failed with 1 conflict: conflict with "other-tool": .data.key';
const status = (code: number, message: string, details?: object) => new Response(JSON.stringify({ kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Failure', message, reason: 'Conflict', ...(details ? { details } : {}), code }), { status: code, headers: { 'content-type': 'application/json' } });
// Exact body returned by a Kubernetes 1.36 API server for a server-side apply field conflict.
const fieldConflict = () => status(409, conflictMessage, { causes: [{ reason: 'FieldManagerConflict', message: 'conflict with "other-tool"', field: '.data.key' }] });
const patches = () => vi.mocked(kubeJson).mock.calls.filter(([, , options]) => options?.method === 'PATCH').map(([, path]) => new URL(path, 'https://api.test'));
const service = new ResourceService({ get: () => ({ config: {} }) } as any);
const apply = (yaml: string, dryRun = true, force?: boolean) => service.apply('c', yaml, 'default', dryRun, force);
const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error('expected failure'); }, e => fault(e));

beforeEach(() => {
  vi.mocked(kubeJson).mockImplementation(async (_config, path, options) => {
    if (path === '/api/v1') return { resources: [{ name: 'configmaps', kind: 'ConfigMap', namespaced: true, verbs: ['patch'] }] };
    if (path.includes('/configmaps/owned?') && !path.includes('force=true')) throw await kubeFailure(fieldConflict(), 'Kubernetes request failed');
    if (path.includes('/configmaps/stale?')) throw await kubeFailure(status(409, 'Operation cannot be fulfilled on configmaps "stale": the object has been modified'), 'Kubernetes request failed');
    if (!options) throw Object.assign(new Error(), { statusCode: 404 });
    return {};
  });
});
afterEach(() => { vi.clearAllMocks(); });

describe('server-side apply field manager', () => {
  it('uses the shared optic field manager for Create resource and Import and Deploy', async () => {
    await apply(configMap('created'));
    const imports = new Imports(), deploy = new Deployments({ get: () => ({ config: {} }) } as any, imports, () => false);
    try { await deploy.prepare({ clusterId: 'c', namespace: 'default', yaml: configMap('imported'), files: [], release: '', action: 'install', valuesIds: [], values: '{}' }, 1); }
    finally { deploy.close(); imports.close(); }
    const managers = patches().map(url => url.searchParams.get('fieldManager'));
    expect(managers).toEqual(['optic', 'optic']);
    expect(patches().every(url => !url.searchParams.has('force'))).toBe(true);
  });
});

describe('apply conflicts', () => {
  it('reports field-manager conflicts with the owning manager and an override hint', async () => {
    const result = await failure(apply(configMap('owned')));
    expect(result.code).toBe('APPLY_CONFLICT');
    expect(result.message).toContain(`Kubernetes API: ${conflictMessage}`);
    expect(result.message).toContain('Override field conflicts');
  });
  it('sends force only when the override is requested, for dry run and apply', async () => {
    await expect(apply(configMap('owned'), true, true)).resolves.toMatchObject({ name: 'owned', kind: 'ConfigMap', namespace: 'default' });
    await expect(apply(configMap('owned'), false, true)).resolves.toMatchObject({ name: 'owned' });
    expect(patches().map(url => [url.searchParams.get('force'), url.searchParams.get('dryRun')])).toEqual([['true', 'All'], ['true', null]]);
  });
  it('keeps other 409 responses as ordinary conflicts', async () => {
    expect(await failure(apply(configMap('stale')))).toMatchObject({ code: 'CONFLICT', retryable: true });
  });
  it('accepts force only as an optional boolean at the IPC boundary', () => {
    const input = { clusterId: 'c', yaml: 'kind: Pod', dryRun: true };
    expect(schemas['resources:apply'].safeParse(input).success).toBe(true);
    expect(schemas['resources:apply'].safeParse({ ...input, force: true }).success).toBe(true);
    expect(schemas['resources:apply'].safeParse({ ...input, force: 'true' }).success).toBe(false);
  });
});

describe('apply manifest parsing', () => {
  it('rejects multi-document YAML with guidance and without contacting the cluster', async () => {
    for (const yaml of [`${configMap('a')}---\n${configMap('b')}`, `---\n${configMap('a')}---\n`]) {
      const result = await failure(apply(yaml));
      expect(result.code).toBe('MULTIPLE_DOCUMENTS');
      expect(result.message).toContain('Import files / chart');
    }
    expect(kubeJson).not.toHaveBeenCalled();
  });
  it('reports invalid YAML as an invalid resource with its line, not a connectivity failure', async () => {
    const result = await failure(apply('apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: [broken\n'));
    expect(result).toMatchObject({ code: 'INVALID_RESOURCE', retryable: false });
    expect(result.message).toMatch(/not valid YAML \(line \d+\)/);
    expect(kubeJson).not.toHaveBeenCalled();
  });
  it('still accepts one document with a leading separator', async () => {
    await expect(apply(`---\n${configMap('single')}`)).resolves.toMatchObject({ name: 'single' });
  });
});

describe('kubeFailure field conflicts', () => {
  it('flags only Status bodies whose causes include FieldManagerConflict', async () => {
    expect(await kubeFailure(fieldConflict(), 'x')).toMatchObject({ statusCode: 409, fieldConflict: true });
    expect(await kubeFailure(status(409, 'modified'), 'x')).not.toHaveProperty('fieldConflict');
    expect(await kubeFailure(status(409, 'modified', { causes: [{ reason: 'FieldValueInvalid' }, null] }), 'x')).not.toHaveProperty('fieldConflict');
  });
});
