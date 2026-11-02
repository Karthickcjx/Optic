import { describe, expect, it } from 'vitest';
import { applicationSet, appProject, argoActivity, argoApplication, argoAttention, argoSummary, consumersOf, filterActivity, filterApplications, fluxAttention, fluxObject, fluxSummary, sortApplications, type ArgoApplication } from '../src/shared/gitops';
import { argoApplicationUrl, safeArgoUrl } from '../src/main/gitops';
import { schemas } from '../src/main/validation';
import type { Resource } from '../src/shared/protocol';
// Captured from a live cluster running Argo CD v3.5.6 and Flux v2.10.0.
import argoApps from './fixtures/argo-applications.json';
import argoProjects from './fixtures/argo-appprojects.json';
import argoSets from './fixtures/argo-applicationsets.json';
import argoEvents from './fixtures/argo-events.json';
import kustomizations from './fixtures/flux-kustomizations.json';
import gitRepositories from './fixtures/flux-gitrepositories.json';
import ociRepositories from './fixtures/flux-ocirepositories.json';
import helmReleases from './fixtures/flux-helmreleases.json';

const live = (argoApps.items as Resource[]).map(argoApplication);
const app = (name: string, health: string, sync: string, extra: Record<string, unknown> = {}) => argoApplication({ apiVersion: 'argoproj.io/v1alpha1', kind: 'Application', metadata: { name, namespace: 'argocd', uid: name }, spec: { project: 'p', destination: { server: 'https://kubernetes.default.svc', namespace: 'x' } }, status: { health: { status: health }, sync: { status: sync }, reconciledAt: '2026-11-02T10:00:00Z', ...extra } });

describe('Argo CD summary counters', () => {
  it('count every health and sync category from real application states', () => {
    const apps = [app('a', 'Healthy', 'Synced'), app('b', 'Degraded', 'OutOfSync'), app('c', 'Progressing', 'Synced'), app('d', 'Missing', 'OutOfSync'), app('e', 'Suspended', 'Synced'), app('f', 'Unknown', 'Unknown'), app('g', 'Weird', 'Strange'),
      app('h', 'Healthy', 'Synced', { operationState: { phase: 'Failed', message: 'boom' } })];
    expect(argoSummary(apps)).toMatchObject({ total: 8, synced: 4, outOfSync: 2, syncUnknown: 2, healthy: 2, degraded: 1, progressing: 1, missing: 1, suspended: 1, healthUnknown: 2, failedSync: 1, lastReconciled: '2026-11-02T10:00:00Z' });
  });
  it('matches the live cluster', () => {
    expect(argoSummary(live)).toMatchObject({ total: 6, synced: 4, outOfSync: 1, syncUnknown: 1, missing: 1, healthy: 5 });
  });
});

describe('application filtering and sorting', () => {
  it('filters by search, project, health, sync and application set', () => {
    const names = (f: Parameters<typeof filterApplications>[1]) => filterApplications(live, f).map(a => a.name).sort();
    expect(names({ project: 'team-a' })).toEqual(['team-a-guestbook']);
    expect(names({ sync: 'OutOfSync' })).toEqual(['guestbook-manual']);
    expect(names({ health: 'Missing' })).toEqual(['guestbook-manual']);
    expect(names({ sync: 'Unknown' })).toEqual(['broken']);
    expect(names({ applicationSet: 'guestbook-envs' })).toEqual(['guestbook-dev', 'guestbook-stage']);
    expect(names({ search: 'STAGE' })).toEqual(['guestbook-stage']);
    expect(names({ search: 'argocd-example-apps', project: 'default', health: 'Healthy' })).toEqual(['broken', 'guestbook', 'guestbook-dev', 'guestbook-stage']);
  });
  it('sorts with problems first by status and supports descending order', () => {
    const apps = [app('a', 'Healthy', 'Synced'), app('b', 'Degraded', 'OutOfSync'), app('c', 'Missing', 'Unknown')];
    expect(sortApplications(apps, 'health').map(a => a.name)).toEqual(['b', 'c', 'a']);
    expect(sortApplications(apps, 'sync').map(a => a.name)).toEqual(['b', 'c', 'a']);
    expect(sortApplications(apps, 'name', true).map(a => a.name)).toEqual(['c', 'b', 'a']);
  });
});

describe('Needs attention', () => {
  it('flags each problem type with the controller message', () => {
    const rows = argoAttention([
      app('degraded', 'Degraded', 'Synced', { health: { status: 'Degraded', message: 'Deployment exceeded its progress deadline' } }),
      app('missing', 'Missing', 'OutOfSync'), app('drift', 'Healthy', 'OutOfSync', { resources: [{ kind: 'Deployment', name: 'web', status: 'OutOfSync' }] }),
      app('failed', 'Healthy', 'Synced', { operationState: { phase: 'Error', message: 'one or more objects failed to apply', finishedAt: '2026-11-02T11:00:00Z' } }),
      app('unknown', 'Healthy', 'Unknown'), app('comparison', 'Healthy', 'Unknown', { conditions: [{ type: 'ComparisonError', message: 'repo not found' }] }),
      app('unhealthy-resource', 'Healthy', 'Synced', { resources: [{ kind: 'StatefulSet', name: 'db', namespace: 'x', status: 'Synced', health: { status: 'Degraded', message: 'pod crash' } }] }),
      app('fine', 'Healthy', 'Synced')]);
    const by = (name: string) => rows.filter(r => r.application === name).map(r => `${r.severity}:${r.problem}`);
    expect(by('degraded')).toEqual(['error:Degraded']);
    expect(rows.find(r => r.application === 'degraded')?.message).toBe('Deployment exceeded its progress deadline');
    expect(by('missing')).toEqual(['error:Missing']);
    expect(by('drift')).toEqual(['warning:Out of sync']); expect(rows.find(r => r.application === 'drift')?.message).toContain('Deployment/web');
    expect(by('failed')).toEqual(['error:Sync failed']);
    expect(by('unknown')).toEqual(['warning:Unknown status']);
    expect(by('comparison')).toEqual(['error:ComparisonError']);
    expect(rows.find(r => r.application === 'unhealthy-resource')).toMatchObject({ kind: 'StatefulSet', name: 'db', problem: 'Resource Degraded', severity: 'error' });
    expect(by('fine')).toEqual([]);
    expect(rows.findIndex(r => r.severity === 'warning')).toBeGreaterThan(rows.map(r => r.severity).lastIndexOf('error'));
  });
  it('finds the live problems: the missing app and the comparison error', () => {
    expect(argoAttention(live).map(r => `${r.name}:${r.problem}`).sort()).toEqual(['broken:ComparisonError', 'guestbook-manual:Missing']);
  });
});

describe('projects and application sets', () => {
  it('maps AppProjects with destinations, sources, permissions, roles and applications', () => {
    const team = appProject((argoProjects.items as Resource[]).find(p => p.metadata.name === 'team-a')!, live);
    expect(team).toMatchObject({ description: 'Team A applications (restricted)', sourceRepos: ['https://github.com/argoproj/argocd-example-apps.git'], destinations: [{ server: 'https://kubernetes.default.svc', namespace: 'team-a-*' }], clusterAllow: [{ group: '', kind: 'Namespace' }], namespaceDeny: [{ group: '', kind: 'ResourceQuota' }], applications: ['team-a-guestbook'] });
    expect(team.roles).toEqual([{ name: 'viewer', description: 'Read-only access for Team A', policies: ['p, proj:team-a:viewer, applications, get, team-a/*, allow'], groups: ['team-a-viewers'] }]);
    const defaults = appProject((argoProjects.items as Resource[]).find(p => p.metadata.name === 'default')!, live);
    expect(defaults.applications).toEqual(['broken', 'guestbook', 'guestbook-dev', 'guestbook-manual', 'guestbook-stage']);
  });
  it('maps ApplicationSets with generators, template and generated applications', () => {
    const set = applicationSet((argoSets.items as Resource[])[0], live);
    expect(set).toMatchObject({ name: 'guestbook-envs', generators: [{ type: 'list', summary: '2 element(s)' }], template: { name: 'guestbook-{{.env}}', project: 'default' }, errors: [] });
    expect(set.generated.map(g => `${g.name}:${g.status}:${g.health}`)).toEqual(['guestbook-dev:Synced:Healthy', 'guestbook-stage:Synced:Healthy']);
    const failing = applicationSet({ apiVersion: 'argoproj.io/v1alpha1', kind: 'ApplicationSet', metadata: { name: 'bad', namespace: 'argocd' }, spec: { generators: [{ git: { repoURL: 'r', directories: [{ path: '*' }] } }, { matrix: { generators: [{}, {}] } }] }, status: { conditions: [{ type: 'ErrorOccurred', status: 'True', message: 'repo unreachable' }] } }, []);
    expect(failing.generators).toEqual([{ type: 'git', summary: 'r · 1 directory pattern(s)' }, { type: 'matrix', summary: '2 nested generator(s)' }]);
    expect(failing.errors[0].message).toBe('repo unreachable');
  });
});

describe('recent activity', () => {
  const rows = argoActivity(argoEvents.items as Resource[], live);
  it('combines real events and deployment history, newest first', () => {
    expect(rows.length).toBe(argoEvents.items.length + live.reduce((n, a) => n + a.history.length, 0));
    expect(new Set(rows.map(r => r.type))).toEqual(new Set(['ResourceUpdated', 'OperationStarted', 'OperationCompleted', 'Deployed']));
    expect(rows.every((r, i) => i === 0 || String(rows[i - 1].at) >= String(r.at))).toBe(true);
    expect(rows.find(r => r.type === 'Deployed')?.message).toMatch(/^Deployed [0-9a-f]{12} from guestbook · automated$/);
  });
  it('filters by kind, namespace, application, type and time range', () => {
    expect(filterActivity(rows, { type: 'OperationCompleted' }).every(r => r.type === 'OperationCompleted')).toBe(true);
    expect(filterActivity(rows, { application: 'manual' }).every(r => r.application === 'guestbook-manual')).toBe(true);
    expect(filterActivity(rows, { kind: 'Application', namespace: 'argocd' })).toHaveLength(rows.length);
    expect(filterActivity(rows, { namespace: 'elsewhere' })).toEqual([]);
    const newest = Date.parse(rows[0].at!);
    expect(filterActivity(rows, { sinceMs: 1 }, newest)).toEqual(rows.filter(r => Date.parse(r.at!) >= newest - 1));
    expect(filterActivity(rows, { sinceMs: 1 }, newest + 86400e3)).toEqual([]);
  });
});

describe('Flux dashboard', () => {
  const objects = [
    ...(kustomizations.items as Resource[]).map(i => fluxObject('kustomizations', i)), ...(gitRepositories.items as Resource[]).map(i => fluxObject('gitrepositories', i)),
    ...(ociRepositories.items as Resource[]).map(i => fluxObject('ocirepositories', i)), ...(helmReleases.items as Resource[]).map(i => fluxObject('helmreleases', i))];
  it('maps OCIRepositories with url, reference and artifact revision', () => {
    expect(objects.find(o => o.type === 'ocirepositories')).toMatchObject({ name: 'podinfo-oci', ready: 'True', url: 'oci://ghcr.io/stefanprodan/manifests/podinfo', ref: 'tag latest' });
  });
  it('counts readiness from real objects', () => {
    expect(fluxSummary(objects)).toMatchObject({ total: 6, ready: 4, failing: 2, suspended: 0, stalled: 0 });
  });
  it('lists failing, suspended, stalled and source-not-ready objects', () => {
    expect(fluxAttention(objects).map(r => `${r.kind}/${r.name}:${r.problem}`).sort()).toEqual(['GitRepository/missing-repo:GitOperationFailed', 'Kustomization/broken-path:ArtifactFailed']);
    const base = (kustomizations.items as Resource[]).find(i => i.metadata.name === 'podinfo')!;
    const suspended = fluxObject('kustomizations', { ...base, metadata: { ...base.metadata, name: 'paused', uid: 'p' }, spec: { ...base.spec, suspend: true } });
    const stalled = fluxObject('kustomizations', { ...base, metadata: { ...base.metadata, name: 'stuck', uid: 's' }, status: { conditions: [{ type: 'Stalled', status: 'True', message: 'dependency loop' }, { type: 'Ready', status: 'False' }] } });
    const orphan = fluxObject('kustomizations', { ...base, metadata: { ...base.metadata, name: 'needs-source', uid: 'o' }, spec: { ...base.spec, sourceRef: { kind: 'GitRepository', name: 'missing-repo' } } });
    const rows = fluxAttention([...objects, suspended, stalled, orphan]).map(r => `${r.name}:${r.problem}`);
    expect(rows).toEqual(expect.arrayContaining(['paused:Suspended', 'stuck:Stalled', 'needs-source:Source not ready']));
    expect(rows.filter(r => r.startsWith('stuck:'))).toEqual(['stuck:Stalled']);
  });
  it('finds the workloads that consume a source', () => {
    expect(consumersOf('GitRepository/flux-system/podinfo', objects).map(o => o.name).sort()).toEqual(['broken-path', 'podinfo']);
  });
});

describe('safety checks', () => {
  it('accepts only http(s) Argo CD URLs without credentials, and builds application links', () => {
    expect(safeArgoUrl('https://argocd.example.com/')).toBe('https://argocd.example.com');
    expect(safeArgoUrl('https://example.com/argo/')).toBe('https://example.com/argo');
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pw@example.com', 'https://x.com/?a=1', 'not a url', 42, undefined]) expect(safeArgoUrl(bad)).toBeUndefined();
    expect(argoApplicationUrl('https://argocd.example.com', { namespace: 'argocd', name: 'guest book' })).toBe('https://argocd.example.com/applications/argocd/guest%20book');
  });
  it('validates field selectors and the open-argo request at the IPC boundary', () => {
    const scope = { clusterId: 'c', kind: 'events', id: crypto.randomUUID() };
    expect(schemas['resources:watch'].safeParse({ ...scope, fieldSelector: 'involvedObject.apiVersion=argoproj.io/v1alpha1' }).success).toBe(true);
    for (const bad of ['a=b&watch=1', 'x', 'a in (b)', 'a=b\n']) expect(schemas['resources:watch'].safeParse({ ...scope, fieldSelector: bad }).success).toBe(false);
    expect(schemas['gitops:open-argo'].safeParse({ clusterId: 'c', namespace: 'argocd', application: { namespace: 'argocd', name: 'guestbook' } }).success).toBe(true);
    expect(schemas['gitops:open-argo'].safeParse({ clusterId: 'c', namespace: 'argocd', url: 'https://evil.example' }).success).toBe(true);
    expect((schemas['gitops:open-argo'].parse({ clusterId: 'c', namespace: 'argocd', url: 'https://evil.example' }) as Record<string, unknown>).url).toBeUndefined();
    expect(schemas['gitops:open-argo'].safeParse({ clusterId: 'c', namespace: '../x' }).success).toBe(false);
  });
});

describe('large collections', () => {
  it('summarizes, filters and finds problems in 10,000 applications quickly', () => {
    const many: ArgoApplication[] = Array.from({ length: 10000 }, (_, i) => app(`app-${i}`, i % 50 ? 'Healthy' : 'Degraded', i % 7 ? 'Synced' : 'OutOfSync'));
    const start = performance.now();
    const summary = argoSummary(many), attention = argoAttention(many), filtered = sortApplications(filterApplications(many, { health: 'Degraded' }), 'name');
    expect(performance.now() - start).toBeLessThan(1500);
    expect(summary).toMatchObject({ total: 10000, degraded: 200 }); expect(filtered).toHaveLength(200); expect(attention.length).toBeGreaterThan(1000);
  });
});
