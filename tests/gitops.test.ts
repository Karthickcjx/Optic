import { describe, expect, it, vi } from 'vitest';
import { argoApplication, fluxObject, inventoryEntry } from '../src/shared/gitops';
import { detectGitOps } from '../src/main/gitops';
import { kubeJson } from '../src/main/kube-http';
import type { Resource } from '../src/shared/protocol';
// Objects captured from a live cluster running Argo CD v3.5.6 and Flux v2.10.0 (managedFields removed).
import argoApps from './fixtures/argo-applications.json';
import kustomizations from './fixtures/flux-kustomizations.json';
import helmReleases from './fixtures/flux-helmreleases.json';
import gitRepositories from './fixtures/flux-gitrepositories.json';
import helmRepositories from './fixtures/flux-helmrepositories.json';
vi.mock('../src/main/kube-http', () => ({ kubeJson: vi.fn() }));

const find = (list: { items: unknown[] }, name: string) => list.items.find((i: any) => i.metadata.name === name) as Resource;

describe('Argo CD Applications', () => {
  it('maps a synced, healthy, auto-synced application with history and managed resources', () => {
    const app = argoApplication(find(argoApps, 'guestbook'));
    expect(app).toMatchObject({ name: 'guestbook', namespace: 'argocd', project: 'default', sync: 'Synced', health: 'Healthy', automated: true, inCluster: true, errors: [], outOfSync: [] });
    expect(app.sources).toEqual([{ repoURL: 'https://github.com/argoproj/argocd-example-apps.git', path: 'guestbook', targetRevision: 'HEAD', chart: undefined }]);
    expect(app.destination).toEqual({ server: 'https://kubernetes.default.svc', name: undefined, namespace: 'argo-demo' });
    expect(app.resources.map(r => `${r.group ?? ''}/${r.kind}/${r.name}`).sort()).toEqual(['/Service/guestbook-ui', 'apps/Deployment/guestbook-ui']);
    expect(app.operation).toMatchObject({ phase: 'Succeeded' });
    expect(app.history[0]).toMatchObject({ initiatedBy: 'automated', source: { path: 'guestbook' } });
    expect(app.history[0].revision).toMatch(/^[0-9a-f]{40}$/);
  });
  it('lists out-of-sync resources of a manual application', () => {
    const app = argoApplication(find(argoApps, 'guestbook-manual'));
    expect(app).toMatchObject({ sync: 'OutOfSync', health: 'Missing', automated: false, history: [] });
    expect(app.outOfSync.length).toBeGreaterThan(0);
    expect(app.outOfSync.every(r => r.status === 'OutOfSync')).toBe(true);
  });
  it('reports comparison errors as sync errors', () => {
    const app = argoApplication(find(argoApps, 'broken'));
    expect(app.sync).toBe('Unknown');
    expect(app.errors).toEqual([expect.objectContaining({ type: 'ComparisonError', message: expect.stringContaining('app path does not exist') })]);
  });
  it('reports failed sync operations and failed resources', () => {
    const app = argoApplication({ apiVersion: 'argoproj.io/v1alpha1', kind: 'Application', metadata: { name: 'x' }, spec: { sources: [{ repoURL: 'r1', chart: 'c' }, { repoURL: 'r2' }], destination: { name: 'prod' } }, status: { operationState: { phase: 'Failed', message: 'one or more objects failed to apply', finishedAt: '2026-01-01T00:00:00Z', syncResult: { resources: [{ kind: 'Deployment', name: 'web', status: 'SyncFailed', message: 'admission webhook denied' }, { kind: 'Job', name: 'pre', status: 'Synced', hookPhase: 'Failed', message: 'hook failed' }, { kind: 'Service', name: 'ok', status: 'Synced' }] } } } });
    expect(app.errors.map(e => e.type)).toEqual(['Sync failed', 'Deployment/web', 'Job/pre']);
    expect(app.sources.map(s => s.repoURL)).toEqual(['r1', 'r2']);
    expect(app.inCluster).toBe(false);
  });
  it('tolerates malformed objects without throwing', () => {
    for (const status of [undefined, null, 'x', { resources: 'nope', history: [null, 5, { id: 'a' }], conditions: [{}], sync: 7 }]) {
      const app = argoApplication({ apiVersion: 'argoproj.io/v1alpha1', kind: 'Application', metadata: { name: 'm' }, spec: 3 as any, status: status as any });
      expect(app).toMatchObject({ name: 'm', sync: 'Unknown', health: 'Unknown', resources: [] });
    }
  });
});

describe('Flux resources', () => {
  it('maps a ready Kustomization with inventory, history and last success', () => {
    const k = fluxObject('kustomizations', find(kustomizations, 'podinfo'));
    expect(k).toMatchObject({ ready: 'True', reason: 'ReconciliationSucceeded', suspended: false, source: 'GitRepository/flux-system/podinfo', path: './kustomize' });
    expect(k.revision).toMatch(/^6\.\d+\.\d+@sha1:/);
    expect(k.inventory).toContainEqual({ namespace: 'flux-demo', name: 'podinfo', group: 'apps', kind: 'Deployment' });
    expect(k.history[0]).toMatchObject({ status: 'ReconciliationSucceeded' });
    expect(k.lastSuccessAt).toBe(k.history[0].at);
  });
  it('maps a failing Kustomization with its reconciliation error', () => {
    const k = fluxObject('kustomizations', find(kustomizations, 'broken-path'));
    expect(k).toMatchObject({ ready: 'False', reason: 'ArtifactFailed', reconciling: true, inventory: [], lastSuccessAt: undefined });
    expect(k.message).toMatch(/kustomization path not found/);
  });
  it('maps HelmRelease history and chart', () => {
    const h = fluxObject('helmreleases', find(helmReleases, 'podinfo-helm'));
    expect(h).toMatchObject({ ready: 'True', reason: 'InstallSucceeded', chart: 'podinfo 6.x', source: 'HelmRepository/flux-system/podinfo' });
    expect(h.history[0]).toMatchObject({ status: 'deployed', detail: 'release v1 (install)' });
    expect(h.revision).toMatch(/^podinfo@6\./);
  });
  it('maps source readiness and artifacts', () => {
    const ok = fluxObject('gitrepositories', find(gitRepositories, 'podinfo')), bad = fluxObject('gitrepositories', find(gitRepositories, 'missing-repo'));
    expect(ok).toMatchObject({ ready: 'True', url: 'https://github.com/stefanprodan/podinfo' });
    expect(ok.lastSuccessAt).toBeTruthy(); expect(ok.revision).toMatch(/@sha1:/);
    expect(bad).toMatchObject({ ready: 'False', reason: 'GitOperationFailed', revision: undefined });
    const repo = fluxObject('helmrepositories', find(helmRepositories, 'podinfo'));
    expect(repo).toMatchObject({ ready: 'True', url: 'https://stefanprodan.github.io/podinfo' });
  });
  it('parses inventory ids and rejects malformed ones', () => {
    expect(inventoryEntry('_flux-system__Namespace')).toEqual({ namespace: undefined, name: 'flux-system', group: undefined, kind: 'Namespace' });
    for (const id of ['', 'a_b_c', 'a_b_c_d_e', 'ns__apps_Deployment']) expect(inventoryEntry(id)).toBeUndefined();
  });
  it('tolerates malformed objects and counts suspension', () => {
    const f = fluxObject('helmreleases', { apiVersion: 'helm.toolkit.fluxcd.io/v2', kind: 'HelmRelease', metadata: { name: 'm' }, spec: { suspend: true }, status: { conditions: 'bad', history: [7], inventory: { entries: [{ id: 3 }] } } as any });
    expect(f).toMatchObject({ ready: 'Unknown', suspended: true, conditions: [], inventory: [], history: [] });
  });
  it('maps thousands of objects quickly', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ ...find(kustomizations, 'podinfo'), metadata: { name: `k${i}`, namespace: 'flux-system', uid: String(i) } }));
    const start = performance.now(); const mapped = many.map(i => fluxObject('kustomizations', i));
    expect(mapped).toHaveLength(5000); expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('GitOps detection', () => {
  const discovery = (paths: Record<string, unknown>) => vi.mocked(kubeJson).mockImplementation(async (_c, path) => { if (path in paths) { const v = paths[path]; if (v instanceof Error) throw v; return v; } throw Object.assign(new Error('nf'), { statusCode: 404 }); });
  const group = (name: string, versions: string[]) => ({ name, versions: versions.map(v => ({ groupVersion: `${name}/${v}` })), preferredVersion: { groupVersion: `${name}/${versions[0]}` } });
  const list = (...resources: [string, string, string[]?][]) => ({ resources: resources.map(([name, kind, verbs = ['get', 'list', 'watch']]) => ({ name, kind, namespaced: true, verbs })) });
  it('finds Argo CD and Flux types at their served versions', async () => {
    discovery({
      '/apis': { groups: [group('apps', ['v1']), group('argoproj.io', ['v1alpha1']), group('kustomize.toolkit.fluxcd.io', ['v1']), group('helm.toolkit.fluxcd.io', ['v2', 'v2beta2']), group('source.toolkit.fluxcd.io', ['v1'])] },
      '/apis/argoproj.io/v1alpha1': list(['applications', 'Application'], ['applications/status', 'Application'], ['appprojects', 'AppProject']),
      '/apis/kustomize.toolkit.fluxcd.io/v1': list(['kustomizations', 'Kustomization']),
      '/apis/helm.toolkit.fluxcd.io/v2': list(['helmreleases', 'HelmRelease']),
      '/apis/source.toolkit.fluxcd.io/v1': list(['gitrepositories', 'GitRepository'], ['helmrepositories', 'HelmRepository'], ['buckets', 'Bucket'])
    });
    expect(await detectGitOps({} as any)).toEqual({ unavailableGroups: [], types: {
      applications: { apiVersion: 'argoproj.io/v1alpha1', kind: 'Application', plural: 'applications', namespaced: true },
      appprojects: { apiVersion: 'argoproj.io/v1alpha1', kind: 'AppProject', plural: 'appprojects', namespaced: true },
      kustomizations: { apiVersion: 'kustomize.toolkit.fluxcd.io/v1', kind: 'Kustomization', plural: 'kustomizations', namespaced: true },
      helmreleases: { apiVersion: 'helm.toolkit.fluxcd.io/v2', kind: 'HelmRelease', plural: 'helmreleases', namespaced: true },
      gitrepositories: { apiVersion: 'source.toolkit.fluxcd.io/v1', kind: 'GitRepository', plural: 'gitrepositories', namespaced: true },
      helmrepositories: { apiVersion: 'source.toolkit.fluxcd.io/v1', kind: 'HelmRepository', plural: 'helmrepositories', namespaced: true },
      buckets: { apiVersion: 'source.toolkit.fluxcd.io/v1', kind: 'Bucket', plural: 'buckets', namespaced: true } } });
  });
  it('falls back to another served version when the preferred one lacks the type', async () => {
    discovery({ '/apis': { groups: [group('source.toolkit.fluxcd.io', ['v1', 'v1beta2'])] }, '/apis/source.toolkit.fluxcd.io/v1': list(['gitrepositories', 'GitRepository']), '/apis/source.toolkit.fluxcd.io/v1beta2': list(['helmrepositories', 'HelmRepository']) });
    const { types } = await detectGitOps({} as any);
    expect(types.helmrepositories?.apiVersion).toBe('source.toolkit.fluxcd.io/v1beta2'); expect(types.gitrepositories?.apiVersion).toBe('source.toolkit.fluxcd.io/v1');
  });
  it('reports nothing when the CRDs are missing, and skips types that cannot be watched', async () => {
    discovery({ '/apis': { groups: [group('apps', ['v1'])] } });
    expect(await detectGitOps({} as any)).toEqual({ types: {}, unavailableGroups: [] });
    discovery({ '/apis': { groups: [group('argoproj.io', ['v1alpha1'])] }, '/apis/argoproj.io/v1alpha1': list(['applications', 'Application', ['get', 'list']]) });
    expect((await detectGitOps({} as any)).types).toEqual({});
  });
  it('reports groups whose discovery fails instead of calling them missing', async () => {
    discovery({ '/apis': { groups: [group('argoproj.io', ['v1alpha1']), group('kustomize.toolkit.fluxcd.io', ['v1'])] }, '/apis/argoproj.io/v1alpha1': Object.assign(new Error('denied'), { statusCode: 503 }), '/apis/kustomize.toolkit.fluxcd.io/v1': list(['kustomizations', 'Kustomization']) });
    const result = await detectGitOps({} as any);
    expect(result.unavailableGroups).toEqual(['argoproj.io']); expect(Object.keys(result.types)).toEqual(['kustomizations']);
  });
  it('propagates a failure to read the API list (disconnected or denied cluster)', async () => {
    discovery({ '/apis': Object.assign(new Error('Forbidden'), { statusCode: 403 }) });
    await expect(detectGitOps({} as any)).rejects.toMatchObject({ statusCode: 403 });
  });
});
