import type { CustomType } from './catalog';
import type { Resource } from './protocol';

// GitOps resource types Optic understands. Versions come from API discovery, not from this table.
export const gitopsTypes = {
  applications: { tool: 'argo', group: 'argoproj.io', kind: 'Application', label: 'Applications' },
  applicationsets: { tool: 'argo', group: 'argoproj.io', kind: 'ApplicationSet', label: 'Application sets' },
  appprojects: { tool: 'argo', group: 'argoproj.io', kind: 'AppProject', label: 'Projects' },
  kustomizations: { tool: 'flux', group: 'kustomize.toolkit.fluxcd.io', kind: 'Kustomization', label: 'Kustomizations' },
  helmreleases: { tool: 'flux', group: 'helm.toolkit.fluxcd.io', kind: 'HelmRelease', label: 'Helm releases' },
  gitrepositories: { tool: 'flux', group: 'source.toolkit.fluxcd.io', kind: 'GitRepository', label: 'Git repositories' },
  helmrepositories: { tool: 'flux', group: 'source.toolkit.fluxcd.io', kind: 'HelmRepository', label: 'Helm repositories' },
  ocirepositories: { tool: 'flux', group: 'source.toolkit.fluxcd.io', kind: 'OCIRepository', label: 'OCI repositories' },
  buckets: { tool: 'flux', group: 'source.toolkit.fluxcd.io', kind: 'Bucket', label: 'Buckets' }
} as const;
export type GitOpsType = keyof typeof gitopsTypes;
export type FluxType = 'kustomizations' | 'helmreleases' | 'gitrepositories' | 'helmrepositories' | 'ocirepositories' | 'buckets';
export const fluxSourceTypes = ['gitrepositories', 'helmrepositories', 'ocirepositories', 'buckets'] as const satisfies readonly FluxType[];
export const fluxTypesAll: FluxType[] = ['kustomizations', 'helmreleases', ...fluxSourceTypes];
// Detected served types; groups whose discovery failed are listed so the UI can say so instead of "not installed".
export interface GitOpsDetection { types: Partial<Record<GitOpsType, CustomType>>; unavailableGroups: string[] }

// Defensive readers: CRD objects are untrusted input and older or newer controllers may omit fields.
const str = (v: unknown) => typeof v === 'string' && v ? v : undefined;
const arr = (v: unknown): any[] => Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : [];
const strings = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const obj = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
export interface Condition { type: string; status: string; reason?: string; message?: string; at?: string }
const conditions = (status: Record<string, any>): Condition[] => arr(status.conditions).map(c => ({ type: str(c.type) ?? 'Unknown', status: str(c.status) ?? 'Unknown', reason: str(c.reason), message: str(c.message), at: str(c.lastTransitionTime) }));
const newest = (...times: (string | undefined)[]) => times.filter((t): t is string => !!t).sort().at(-1);

// ---------------------------------------------------------------- Argo CD Applications
export interface ArgoSource { repoURL?: string; path?: string; chart?: string; targetRevision?: string }
export interface ArgoManagedResource { group?: string; version?: string; kind: string; namespace?: string; name: string; status?: string; health?: string; healthMessage?: string; hook: boolean; requiresPruning: boolean }
export interface ArgoApplication {
  name: string; namespace?: string; uid?: string; project: string; sync: string; health: string; healthMessage?: string; revision?: string; automated: boolean;
  sources: ArgoSource[]; destination: { server?: string; name?: string; namespace?: string }; inCluster: boolean; applicationSet?: string; controllerNamespace?: string;
  operation?: { phase: string; message?: string; startedAt?: string; finishedAt?: string };
  conditions: Condition[]; errors: { type: string; message: string; at?: string }[]; resources: ArgoManagedResource[]; outOfSync: ArgoManagedResource[];
  history: { id?: number; revision?: string; deployedAt?: string; startedAt?: string; initiatedBy?: string; source?: ArgoSource }[]; reconciledAt?: string; createdAt?: string;
}
const source = (s: unknown): ArgoSource => { const v = obj(s); return { repoURL: str(v.repoURL), path: str(v.path), chart: str(v.chart), targetRevision: str(v.targetRevision) }; };

export function argoApplication(item: Resource): ArgoApplication {
  const spec = obj(item.spec), status = obj(item.status), sync = obj(status.sync), health = obj(status.health), op = obj(status.operationState), destination = obj(spec.destination);
  const resources: ArgoManagedResource[] = arr(status.resources).filter(r => str(r.kind) && str(r.name)).map(r => ({ group: str(r.group), version: str(r.version), kind: r.kind, namespace: str(r.namespace), name: r.name, status: str(r.status), health: str(obj(r.health).status), healthMessage: str(obj(r.health).message), hook: r.hook === true, requiresPruning: r.requiresPruning === true }));
  // Sync errors: error-type conditions, a failed sync operation and the resources that operation could not sync.
  const errors = [
    ...arr(status.conditions).filter(c => /Error|Warning/.test(str(c.type) ?? '')).map(c => ({ type: str(c.type)!, message: str(c.message) ?? '', at: str(c.lastTransitionTime) })),
    ...(['Failed', 'Error'].includes(str(op.phase) ?? '') ? [{ type: `Sync ${str(op.phase)!.toLowerCase()}`, message: str(op.message) ?? '', at: str(op.finishedAt) }] : []),
    ...arr(obj(op.syncResult).resources).filter(r => ['SyncFailed'].includes(str(r.status) ?? '') || ['Failed', 'Error'].includes(str(r.hookPhase) ?? '')).map(r => ({ type: `${str(r.kind) ?? 'Resource'}/${str(r.name) ?? ''}`, message: str(r.message) ?? 'Failed to sync', at: str(op.finishedAt) }))
  ];
  const sources = arr(spec.sources).length ? arr(spec.sources).map(source) : spec.source ? [source(spec.source)] : [];
  const owner = arr(item.metadata.ownerReferences).find(o => o.kind === 'ApplicationSet');
  return {
    name: item.metadata.name ?? '', namespace: item.metadata.namespace, uid: item.metadata.uid, project: str(spec.project) ?? 'default',
    sync: str(sync.status) ?? 'Unknown', health: str(health.status) ?? 'Unknown', healthMessage: str(health.message), revision: str(sync.revision) ?? strings(sync.revisions)[0], automated: !!obj(spec.syncPolicy).automated,
    sources, destination: { server: str(destination.server), name: str(destination.name), namespace: str(destination.namespace) },
    inCluster: destination.server === 'https://kubernetes.default.svc' || destination.name === 'in-cluster', applicationSet: str(owner?.name), controllerNamespace: str(status.controllerNamespace),
    operation: str(op.phase) ? { phase: op.phase, message: str(op.message), startedAt: str(op.startedAt), finishedAt: str(op.finishedAt) } : undefined,
    conditions: conditions(status), errors, resources, outOfSync: resources.filter(r => r.status === 'OutOfSync'),
    // Argo CD keeps the most recent deployments (10 by default), oldest first; show newest first.
    history: arr(status.history).map(h => ({ id: typeof h.id === 'number' ? h.id : undefined, revision: str(h.revision) ?? strings(h.revisions)[0], deployedAt: str(h.deployedAt), startedAt: str(h.deployStartedAt), initiatedBy: obj(h.initiatedBy).automated ? 'automated' : str(obj(h.initiatedBy).username), source: h.source ? source(h.source) : h.sources ? source(arr(h.sources)[0]) : undefined })).reverse(),
    reconciledAt: str(status.reconciledAt), createdAt: item.metadata.creationTimestamp
  };
}

// Status buckets used by counters and filters. Each application counts once per dimension (sync and health).
export const healthStates = ['Healthy', 'Progressing', 'Degraded', 'Suspended', 'Missing', 'Unknown'] as const;
export const syncStates = ['Synced', 'OutOfSync', 'Unknown'] as const;
const healthBucket = (h: string) => (healthStates as readonly string[]).includes(h) ? h : 'Unknown';
const syncBucket = (s: string) => s === 'Synced' || s === 'OutOfSync' ? s : 'Unknown';
export function argoSummary(apps: ArgoApplication[]) {
  const count = (fn: (a: ArgoApplication) => boolean) => apps.filter(fn).length;
  return {
    total: apps.length,
    synced: count(a => syncBucket(a.sync) === 'Synced'), outOfSync: count(a => syncBucket(a.sync) === 'OutOfSync'), syncUnknown: count(a => syncBucket(a.sync) === 'Unknown'),
    healthy: count(a => healthBucket(a.health) === 'Healthy'), progressing: count(a => healthBucket(a.health) === 'Progressing'), degraded: count(a => healthBucket(a.health) === 'Degraded'),
    suspended: count(a => healthBucket(a.health) === 'Suspended'), missing: count(a => healthBucket(a.health) === 'Missing'), healthUnknown: count(a => healthBucket(a.health) === 'Unknown'),
    failedSync: count(a => ['Failed', 'Error'].includes(a.operation?.phase ?? '')), automated: count(a => a.automated),
    lastReconciled: newest(...apps.map(a => a.reconciledAt))
  };
}

export interface ArgoFilter { search?: string; project?: string; health?: string; sync?: string; applicationSet?: string }
export function filterApplications(apps: ArgoApplication[], f: ArgoFilter) {
  const search = f.search?.trim().toLowerCase();
  return apps.filter(a => (!search || `${a.name} ${a.namespace ?? ''} ${a.project} ${a.destination.namespace ?? ''} ${a.sources.map(s => s.repoURL ?? '').join(' ')}`.toLowerCase().includes(search))
    && (!f.project || a.project === f.project) && (!f.health || healthBucket(a.health) === f.health) && (!f.sync || syncBucket(a.sync) === f.sync) && (!f.applicationSet || a.applicationSet === f.applicationSet));
}
export type ArgoSortKey = 'name' | 'namespace' | 'project' | 'sync' | 'health' | 'deployed';
// Problems first when sorting by status, so the column is useful for triage.
const healthRank: Record<string, number> = { Degraded: 0, Missing: 1, Unknown: 2, Progressing: 3, Suspended: 4, Healthy: 5 }, syncRank: Record<string, number> = { OutOfSync: 0, Unknown: 1, Synced: 2 };
export function sortApplications(apps: ArgoApplication[], key: ArgoSortKey, descending = false) {
  const value = (a: ArgoApplication): string | number => key === 'sync' ? syncRank[syncBucket(a.sync)] : key === 'health' ? healthRank[healthBucket(a.health)] : key === 'deployed' ? a.history[0]?.deployedAt ?? '' : key === 'namespace' ? a.namespace ?? '' : key === 'project' ? a.project : a.name;
  const sorted = [...apps].sort((x, y) => { const a = value(x), b = value(y); return (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))) || x.name.localeCompare(y.name); });
  return descending ? sorted.reverse() : sorted;
}

export interface AttentionRow { severity: 'error' | 'warning'; problem: string; kind: string; name: string; namespace?: string; application?: string; message: string; at?: string }
// Everything an operator should look at, worst first. Messages come from the controller; nothing is inferred beyond status fields.
export function argoAttention(apps: ArgoApplication[]): AttentionRow[] {
  const rows: AttentionRow[] = [];
  for (const a of apps) {
    const base = { kind: 'Application', name: a.name, namespace: a.namespace, application: a.name };
    if (a.health === 'Degraded') rows.push({ ...base, severity: 'error', problem: 'Degraded', message: a.healthMessage ?? 'Application health is Degraded.', at: a.reconciledAt });
    if (a.health === 'Missing') rows.push({ ...base, severity: 'error', problem: 'Missing', message: `Sync: ${a.sync} · Health: Missing${a.healthMessage ? ` · ${a.healthMessage}` : ''}`, at: a.reconciledAt });
    if (['Failed', 'Error'].includes(a.operation?.phase ?? '')) rows.push({ ...base, severity: 'error', problem: 'Sync failed', message: a.operation?.message ?? 'The last sync operation failed.', at: a.operation?.finishedAt });
    for (const c of a.conditions.filter(c => /Error/.test(c.type))) rows.push({ ...base, severity: 'error', problem: c.type, message: c.message ?? c.type, at: c.at });
    if (a.sync === 'OutOfSync' && a.health !== 'Missing') rows.push({ ...base, severity: 'warning', problem: 'Out of sync', message: `${a.outOfSync.length} resource(s) differ from Git${a.outOfSync.length ? `: ${a.outOfSync.slice(0, 3).map(r => `${r.kind}/${r.name}`).join(', ')}` : ''}`, at: a.reconciledAt });
    if (a.sync !== 'Synced' && a.sync !== 'OutOfSync' && !a.conditions.some(c => /Error/.test(c.type))) rows.push({ ...base, severity: 'warning', problem: 'Unknown status', message: `Sync status is ${a.sync}.`, at: a.reconciledAt });
    else if (a.health === 'Unknown') rows.push({ ...base, severity: 'warning', problem: 'Unknown status', message: 'Health status is Unknown.', at: a.reconciledAt });
    for (const r of a.resources.filter(r => r.health && !['Healthy', 'Progressing', 'Suspended'].includes(r.health))) rows.push({ severity: r.health === 'Degraded' || r.health === 'Missing' ? 'error' : 'warning', problem: `Resource ${r.health}`, kind: r.kind, name: r.name, namespace: r.namespace, application: a.name, message: r.healthMessage ?? `${r.kind} ${r.name} is ${r.health}.`, at: a.reconciledAt });
  }
  return rows.sort((x, y) => (x.severity === y.severity ? 0 : x.severity === 'error' ? -1 : 1) || String(y.at ?? '').localeCompare(String(x.at ?? '')));
}

// ---------------------------------------------------------------- Projects and ApplicationSets
export interface ResourceRule { group: string; kind: string }
export interface ArgoProject {
  name: string; namespace?: string; uid?: string; description?: string; sourceRepos: string[]; destinations: { server?: string; name?: string; namespace?: string }[];
  clusterAllow: ResourceRule[]; clusterDeny: ResourceRule[]; namespaceAllow: ResourceRule[]; namespaceDeny: ResourceRule[];
  roles: { name: string; description?: string; policies: string[]; groups: string[] }[]; applications: string[];
}
const rules = (v: unknown) => arr(v).map(r => ({ group: typeof r.group === 'string' ? r.group : '*', kind: str(r.kind) ?? '*' }));
export function appProject(item: Resource, apps: ArgoApplication[]): ArgoProject {
  const spec = obj(item.spec);
  return {
    name: item.metadata.name ?? '', namespace: item.metadata.namespace, uid: item.metadata.uid, description: str(spec.description), sourceRepos: strings(spec.sourceRepos),
    destinations: arr(spec.destinations).map(d => ({ server: str(d.server), name: str(d.name), namespace: str(d.namespace) })),
    clusterAllow: rules(spec.clusterResourceWhitelist), clusterDeny: rules(spec.clusterResourceBlacklist), namespaceAllow: rules(spec.namespaceResourceWhitelist), namespaceDeny: rules(spec.namespaceResourceBlacklist),
    roles: arr(spec.roles).map(r => ({ name: str(r.name) ?? '', description: str(r.description), policies: strings(r.policies), groups: strings(r.groups) })),
    applications: apps.filter(a => a.project === item.metadata.name).map(a => a.name).sort()
  };
}
export interface ArgoApplicationSet {
  name: string; namespace?: string; uid?: string; generators: { type: string; summary: string }[]; template: { name?: string; project?: string; source?: ArgoSource; destination?: { server?: string; name?: string; namespace?: string } };
  conditions: Condition[]; errors: Condition[]; health?: string; generated: { name: string; namespace?: string; status?: string; health?: string }[];
}
// Generator types are the keys of each spec.generators entry (list, clusters, git, matrix, merge, scmProvider, pullRequest, ...).
const generatorSummary = (type: string, g: Record<string, any>) => type === 'list' ? `${arr(g.elements).length} element(s)` : type === 'git' ? [str(g.repoURL), arr(g.directories).length ? `${arr(g.directories).length} directory pattern(s)` : arr(g.files).length ? `${arr(g.files).length} file pattern(s)` : undefined].filter(Boolean).join(' · ') : type === 'clusters' ? (Object.keys(obj(obj(g.selector).matchLabels)).length ? `selector ${Object.entries(obj(obj(g.selector).matchLabels)).map(([k, v]) => `${k}=${v}`).join(',')}` : 'all clusters') : type === 'matrix' || type === 'merge' ? `${arr(g.generators).length} nested generator(s)` : '';
export function applicationSet(item: Resource, apps: ArgoApplication[]): ArgoApplicationSet {
  const spec = obj(item.spec), status = obj(item.status), template = obj(spec.template), tspec = obj(template.spec), conds = conditions(status);
  const fromStatus = arr(status.resources).filter(r => str(r.name)).map(r => ({ name: r.name as string, namespace: str(r.namespace), status: str(r.status), health: str(obj(r.health).status) }));
  const owned = apps.filter(a => a.applicationSet === item.metadata.name && a.namespace === item.metadata.namespace).map(a => ({ name: a.name, namespace: a.namespace, status: a.sync, health: a.health }));
  return {
    name: item.metadata.name ?? '', namespace: item.metadata.namespace, uid: item.metadata.uid,
    generators: arr(spec.generators).flatMap(g => Object.entries(g).filter(([k]) => k !== 'selector').map(([type, v]) => ({ type, summary: generatorSummary(type, obj(v)) }))),
    template: { name: str(obj(template.metadata).name), project: str(tspec.project), source: tspec.source ? source(tspec.source) : tspec.sources ? source(arr(tspec.sources)[0]) : undefined, destination: tspec.destination ? { server: str(obj(tspec.destination).server), name: str(obj(tspec.destination).name), namespace: str(obj(tspec.destination).namespace) } : undefined },
    conditions: conds, errors: conds.filter(c => c.type === 'ErrorOccurred' && c.status === 'True'), health: str(obj(status.health).status),
    // Live applications win over the status snapshot because they carry current sync and health.
    generated: [...owned, ...fromStatus.filter(r => !owned.some(o => o.name === r.name))].sort((a, b) => a.name.localeCompare(b.name))
  };
}

// ---------------------------------------------------------------- Activity (real events and deployment history only)
export interface ActivityRow { at?: string; kind: string; name: string; namespace?: string; application?: string; type: string; message: string; origin: 'event' | 'history'; warning: boolean }
export function argoActivity(events: Resource[], apps: ArgoApplication[]): ActivityRow[] {
  const fromEvents: ActivityRow[] = events.filter(e => obj(e.involvedObject).name).map(e => {
    const involved = obj(e.involvedObject);
    return { at: str(e.lastTimestamp) ?? str(e.eventTime) ?? str(obj(e.series).lastObservedTime) ?? e.metadata.creationTimestamp, kind: str(involved.kind) ?? 'Unknown', name: involved.name, namespace: str(involved.namespace), application: involved.kind === 'Application' ? involved.name : undefined, type: str(e.reason) ?? 'Event', message: str(e.message) ?? '', origin: 'event' as const, warning: e.type === 'Warning' };
  });
  const fromHistory: ActivityRow[] = apps.flatMap(a => a.history.map(h => ({ at: h.deployedAt, kind: 'Application', name: a.name, namespace: a.namespace, application: a.name, type: 'Deployed', message: `Deployed ${h.revision ? h.revision.slice(0, 12) : 'revision'}${h.source?.path ? ` from ${h.source.path}` : h.source?.chart ? ` (chart ${h.source.chart})` : ''}${h.initiatedBy ? ` · ${h.initiatedBy}` : ''}`, origin: 'history' as const, warning: false })));
  return [...fromEvents, ...fromHistory].sort((x, y) => String(y.at ?? '').localeCompare(String(x.at ?? '')));
}
export interface ActivityFilter { kind?: string; namespace?: string; application?: string; type?: string; sinceMs?: number }
export function filterActivity(rows: ActivityRow[], f: ActivityFilter, now = Date.now()) {
  const app = f.application?.trim().toLowerCase();
  return rows.filter(r => (!f.kind || r.kind === f.kind) && (!f.namespace || r.namespace === f.namespace) && (!f.type || r.type === f.type) && (!app || (r.application ?? r.name).toLowerCase().includes(app)) && (!f.sinceMs || (!!r.at && now - Date.parse(r.at) <= f.sinceMs)));
}

// ---------------------------------------------------------------- Flux
export interface FluxObject {
  type: FluxType; name: string; namespace?: string; uid?: string; ready: string; reason?: string; message?: string; suspended: boolean; reconciling: boolean; stalled: boolean;
  revision?: string; attemptedRevision?: string; lastSuccessAt?: string; lastReconcileAt?: string; source?: string; url?: string; path?: string; chart?: string; ref?: string; interval?: string;
  conditions: Condition[]; inventory: { namespace?: string; name: string; group?: string; kind: string }[];
  history: { at?: string; status?: string; revision?: string; detail?: string }[];
}
// Flux inventory ids are "<namespace>_<name>_<group>_<Kind>"; Kubernetes names cannot contain "_".
export function inventoryEntry(id: string) {
  const parts = id.split('_');
  return parts.length === 4 && parts[1] && parts[3] ? { namespace: parts[0] || undefined, name: parts[1], group: parts[2] || undefined, kind: parts[3] } : undefined;
}
const refText = (ref: Record<string, any>) => str(ref.tag) ? `tag ${ref.tag}` : str(ref.semver) ? `semver ${ref.semver}` : str(ref.digest) ? `digest ${ref.digest.slice(0, 19)}` : str(ref.commit) ? `commit ${ref.commit.slice(0, 12)}` : str(ref.branch) ? `branch ${ref.branch}` : str(ref.name) ? `ref ${ref.name}` : undefined;
export function fluxObject(type: FluxType, item: Resource): FluxObject {
  const spec = obj(item.spec), status = obj(item.status), conds = conditions(status), ready = conds.find(c => c.type === 'Ready');
  const ref = obj(type === 'helmreleases' ? obj(obj(spec.chart).spec).sourceRef ?? spec.chartRef : spec.sourceRef), artifact = obj(status.artifact);
  const history = type === 'kustomizations'
    ? arr(status.history).map(h => ({ at: str(h.lastReconciled), status: str(h.lastReconciledStatus), revision: str(obj(h.metadata).revision), detail: typeof h.totalReconciliations === 'number' ? `${h.totalReconciliations} reconciliation(s)` : undefined }))
    : type === 'helmreleases' ? arr(status.history).map(h => ({ at: str(h.lastDeployed), status: str(h.status), revision: [str(h.chartName), str(h.chartVersion)].filter(Boolean).join('@') || undefined, detail: typeof h.version === 'number' ? `release v${h.version}${str(h.action) ? ` (${h.action})` : ''}` : undefined })) : [];
  // Last success: the newest successful history entry, else when Ready last became True, else the stored artifact time.
  const succeeded = history.find(h => h.status === 'ReconciliationSucceeded' || h.status === 'deployed');
  return {
    type, name: item.metadata.name ?? '', namespace: item.metadata.namespace, uid: item.metadata.uid,
    ready: ready?.status ?? 'Unknown', reason: ready?.reason, message: ready?.message, suspended: spec.suspend === true,
    reconciling: conds.some(c => c.type === 'Reconciling' && c.status === 'True'), stalled: conds.some(c => c.type === 'Stalled' && c.status === 'True'),
    revision: str(status.lastAppliedRevision) ?? (type === 'helmreleases' ? history[0]?.revision : str(artifact.revision)), attemptedRevision: str(status.lastAttemptedRevision),
    lastSuccessAt: succeeded?.at ?? (ready?.status === 'True' ? ready.at : undefined) ?? str(artifact.lastUpdateTime),
    lastReconcileAt: newest(history[0]?.at, ready?.at, str(artifact.lastUpdateTime), str(status.lastHandledReconcileAt)),
    source: str(ref.kind) && str(ref.name) ? [ref.kind, str(ref.namespace) ?? item.metadata.namespace, ref.name].filter(Boolean).join('/') : undefined,
    url: str(spec.url) ?? (type === 'buckets' ? [str(spec.endpoint), str(spec.bucketName)].filter(Boolean).join('/') || undefined : undefined), path: str(spec.path),
    chart: type === 'helmreleases' ? [str(obj(obj(spec.chart).spec).chart), str(obj(obj(spec.chart).spec).version)].filter(Boolean).join(' ') || undefined : undefined,
    ref: refText(obj(spec.ref)), interval: str(spec.interval),
    conditions: conds, inventory: arr(obj(status.inventory).entries).map(e => inventoryEntry(str(e.id) ?? '')).filter((e): e is NonNullable<typeof e> => !!e), history
  };
}
export const fluxKindOf = (type: FluxType) => gitopsTypes[type].kind;
export function fluxSummary(objects: FluxObject[]) {
  const count = (fn: (o: FluxObject) => boolean) => objects.filter(fn).length;
  return { total: objects.length, ready: count(o => o.ready === 'True' && !o.suspended), failing: count(o => o.ready === 'False'), unknown: count(o => o.ready !== 'True' && o.ready !== 'False'), suspended: count(o => o.suspended), reconciling: count(o => o.reconciling), stalled: count(o => o.stalled) };
}
export function fluxAttention(objects: FluxObject[]): AttentionRow[] {
  const ready = new Set(objects.filter(o => o.ready === 'True').map(o => `${fluxKindOf(o.type)}/${o.namespace}/${o.name}`));
  const sources = new Set(objects.filter(o => (fluxSourceTypes as readonly string[]).includes(o.type)).map(o => `${fluxKindOf(o.type)}/${o.namespace}/${o.name}`));
  const rows: AttentionRow[] = [];
  for (const o of objects) {
    const base = { kind: fluxKindOf(o.type), name: o.name, namespace: o.namespace };
    if (o.stalled) rows.push({ ...base, severity: 'error', problem: 'Stalled', message: o.conditions.find(c => c.type === 'Stalled')?.message ?? 'Reconciliation is stalled.', at: o.lastReconcileAt });
    else if (o.ready === 'False') rows.push({ ...base, severity: 'error', problem: o.reason ?? 'Not ready', message: o.message ?? 'Ready is False.', at: o.conditions.find(c => c.type === 'Ready')?.at });
    else if (o.ready !== 'True' && !o.suspended) rows.push({ ...base, severity: 'warning', problem: o.reconciling ? 'Reconciling' : 'Unknown status', message: o.message ?? 'The controller has not reported readiness yet.', at: o.lastReconcileAt });
    if (o.suspended) rows.push({ ...base, severity: 'warning', problem: 'Suspended', message: 'Reconciliation is suspended (spec.suspend: true).', at: o.lastReconcileAt });
    // A workload whose source is known but not ready will not pick up new revisions.
    if (o.source && sources.has(o.source) && !ready.has(o.source)) rows.push({ ...base, severity: 'warning', problem: 'Source not ready', message: `${o.source} is not ready; new revisions are not applied.`, at: o.lastReconcileAt });
  }
  return rows.sort((x, y) => (x.severity === y.severity ? 0 : x.severity === 'error' ? -1 : 1) || x.name.localeCompare(y.name));
}
// Workloads that consume a source, for the source's "Associated resources".
export const consumersOf = (sourceRef: string, objects: FluxObject[]) => objects.filter(o => o.source === sourceRef);
