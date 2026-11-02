import { Providers } from './providers';
import { Watch } from '@kubernetes/client-node';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { catalog } from '../shared/catalog';
import type { ClusterManager } from './clusters';
import type { Resource, Scope, Target } from '../shared/protocol';
import { AppError } from './errors';
import { kubeJson } from './kube-http';

export const definitions = catalog;
export function definition(scope: Scope) {
  if (scope.kind === 'custom') {
    if (!scope.custom) throw new AppError('INVALID_RESOURCE', 'Select a custom resource definition first.');
    return scope.custom;
  }
  return { ...catalog[scope.kind], plural: scope.kind };
}
export function resourcePath(scope: Scope): string {
  const d = definition(scope);
  return `${d.apiVersion === 'v1' ? '/api/v1' : `/apis/${d.apiVersion}`}${d.namespaced && scope.namespace ? `/namespaces/${encodeURIComponent(scope.namespace)}` : ''}/${d.plural}`;
}
function targetPath(target: Target) {
  if (definition(target).namespaced && !target.namespace) throw new AppError('NAMESPACE_REQUIRED', 'Select a namespaced resource.');
  return `${resourcePath(target)}/${encodeURIComponent(target.name)}`;
}
export function validateReplacement(target: Target, document: Resource) {
  const d = definition(target);
  if (!document || document.kind !== d.kind || document.apiVersion !== d.apiVersion || document.metadata?.name !== target.name || (d.namespaced && document.metadata?.namespace !== target.namespace)) throw new AppError('INVALID_RESOURCE', 'YAML must retain the selected resource name, namespace, kind, and API version.');
  if (!document.metadata.resourceVersion) throw new AppError('INVALID_RESOURCE', 'YAML must include resourceVersion to prevent overwriting concurrent changes.');
}
export class ResourceService {
  private apiVersions = new WeakMap<object, Map<string, { version: string; expires: number }>>();
  constructor(private clusters: ClusterManager) {}
  private config(id: string) { return this.clusters.get(id).config; }
  private async resolveScope<T extends Scope>(scope: T): Promise<T> {
    if (!['mutatingadmissionpolicies', 'mutatingadmissionpolicybindings'].includes(scope.kind)) return scope;
    const config = this.config(scope.clusterId), descriptor = definition(scope);
    let cache = this.apiVersions.get(config);
    if (!cache) { cache = new Map(); this.apiVersions.set(config, cache); }
    const cached = cache.get(scope.kind);
    let version = cached && cached.expires > Date.now() ? cached.version : undefined;
    if (!version) {
      for (const candidate of ['admissionregistration.k8s.io/v1', 'admissionregistration.k8s.io/v1beta1']) {
        try {
          const discovery = await kubeJson<{ resources?: { name: string; kind: string }[] }>(config, `/apis/${candidate}`);
          if (discovery.resources?.some(resource => resource.name === descriptor.plural && resource.kind === descriptor.kind)) { version = candidate; break; }
        } catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw error; }
      }
      if (!version) throw new AppError('API_UNAVAILABLE', 'This cluster does not serve Mutating Admission Policies. Check its Kubernetes version and enabled admission APIs.');
      cache.set(scope.kind, { version, expires: Date.now() + 60000 });
    }
    return { ...scope, kind: 'custom', custom: { ...descriptor, apiVersion: version } };
  }
  async get(target: Target) { target = await this.resolveScope(target); return this.normalize(target, await kubeJson<Resource>(this.config(target.clusterId), targetPath(target))); }
  async list(scope: Scope) { return (await this.listVersioned(await this.resolveScope(scope))).items; }
  private async listVersioned(scope: Scope, signal?: AbortSignal): Promise<{ items: Resource[]; version?: string }> {
    const items: Resource[] = []; let continuation = '', version: string | undefined;
    do {
      const query = new URLSearchParams({ limit: '500', ...(continuation ? { continue: continuation } : {}) });
      const response = await kubeJson<{ items: Resource[]; metadata?: { resourceVersion?: string; continue?: string } }>(this.config(scope.clusterId), `${resourcePath(scope)}?${query}`, { signal });
      items.push(...response.items.map(item => this.normalize(scope, item))); version = response.metadata?.resourceVersion;
      continuation = response.metadata?.continue ?? '';
      if (items.length > 50000) throw new AppError('TOO_MANY_RESOURCES', 'Select a namespace to narrow this resource list.');
    } while (continuation);
    return { items, version };
  }
  private normalize(scope: Scope, item: Resource): Resource {
    const d = definition(scope);
    const value: Resource = { ...item, apiVersion: d.apiVersion, kind: d.kind, metadata: { ...item.metadata } };
    if (d.kind === 'Secret') { delete value.data; delete value.stringData; delete value.metadata.annotations; }
    return value;
  }
  watch(scope: Scope, onItems: (items: Resource[]) => void, onError: (error: unknown) => void): () => void {
    let stopped = false, controller: AbortController | undefined, timer: NodeJS.Timeout | undefined;
    const lifetime = new AbortController(); let backoff = 1000;
    const cache = new Map<string, Resource>(); let publishTimer: NodeJS.Timeout | undefined;
    // Resume point for re-watching without a LIST; cleared when the server reports it expired (410 Gone).
    let resolved: Scope | undefined, version: string | undefined, generation = 0, failures = 0, reported = false;
    const publish = () => { if (!publishTimer) publishTimer = setTimeout(() => { publishTimer = undefined; if (!stopped) onItems([...cache.values()]); }, 100); };
    const schedule = (delay: number) => { if (!stopped && !timer) timer = setTimeout(() => { timer = undefined; void start(); }, delay); };
    const fail = (error: unknown, listing: boolean) => {
      if (stopped || timer) return;
      // One dropped watch is routine and resumes silently; LIST failures and repeated watch failures are reported.
      if (listing || ++failures > 1) { reported = true; onError(error); }
      schedule(backoff + Math.random() * 500);
      backoff = Math.min(30000, backoff * 2);
    };
    const expire = () => { version = undefined; schedule(0); };
    const start = async () => {
      const current = ++generation; controller?.abort(); controller = undefined;
      let listing = !version;
      try {
        if (!version) {
          resolved = await this.resolveScope(scope);
          if (stopped) return;
          const initial = await this.listVersioned(resolved, lifetime.signal);
          if (stopped) return;
          cache.clear(); initial.items.forEach(item => cache.set(item.metadata.uid ?? `${item.metadata.namespace}/${item.metadata.name}`, item)); publish();
          version = initial.version; reported = false;
        }
        listing = false;
        const watched = resolved!, opened = Date.now(); let ended = false;
        // The client aborts a watch after 30 s without data; a shorter server timeout ends quiet watches normally first.
        const pending = await new Watch(this.config(scope.clusterId)).watch(resourcePath(watched), { resourceVersion: version, allowWatchBookmarks: true, timeoutSeconds: 25 }, (type, object) => {
          if (stopped || current !== generation) return;
          if (type === 'ERROR') { if (object?.code === 410) expire(); else fail(Object.assign(new Error('Watch failed'), { statusCode: object?.code }), false); return; }
          if (object?.metadata?.resourceVersion) version = object.metadata.resourceVersion;
          if (type === 'BOOKMARK') return;
          const key = object.metadata?.uid ?? `${object.metadata?.namespace}/${object.metadata?.name}`;
          if (type === 'DELETED') cache.delete(key); else if (type === 'ADDED' || type === 'MODIFIED') cache.set(key, this.normalize(watched, object)); publish();
        }, error => {
          ended = true;
          if (stopped || current !== generation) return;
          if ((error as { statusCode?: number } | null)?.statusCode === 410) expire();
          else if (error) fail(error, false);
          else schedule(Date.now() - opened < 5000 ? 1000 : 0); // Normal server close: resume from the last version.
        });
        if (stopped || current !== generation) { pending.abort(); return; }
        controller = pending;
        // Connected: reset backoff, and replace any reported error with the current snapshot.
        if (!ended) { backoff = 1000; failures = 0; if (reported) { reported = false; publish(); } }
      } catch (error) { if (current === generation) fail(error, listing); }
    };
    void start();
    return () => { stopped = true; lifetime.abort(); clearTimeout(timer); clearTimeout(publishTimer); controller?.abort(); cache.clear(); };
  }
  async yaml(target: Target) {
    target = await this.resolveScope(target);
    if (definition(target).kind === 'Secret') throw new AppError('REDACTED', 'Secret values are not exposed by this workbench.');
    const resource = await kubeJson<Resource>(this.config(target.clusterId), targetPath(target));
    if (resource.metadata) delete resource.metadata.managedFields;
    return stringify(resource);
  }
  async replace(target: Target, yaml: string) {
    target = await this.resolveScope(target);
    if (definition(target).kind === 'Secret') throw new AppError('REDACTED', 'Secret editing is unavailable.');
    const document = parse(yaml, { maxAliasCount: 50 }) as Resource; validateReplacement(target, document); delete document.status;
    await kubeJson(this.config(target.clusterId), targetPath(target), { method: 'PUT', body: document });
  }
  async delete(target: Target) { target = await this.resolveScope(target); await kubeJson(this.config(target.clusterId), targetPath(target), { method: 'DELETE', body: { apiVersion: 'v1', kind: 'DeleteOptions', propagationPolicy: 'Background' } }); }
  async restart(target: Target) {
    if (!['deployments', 'statefulsets', 'daemonsets'].includes(target.kind)) throw new AppError('UNSUPPORTED', 'Rollout restart is available for Deployments, StatefulSets and DaemonSets.');
    await kubeJson(this.config(target.clusterId), targetPath(target), { method: 'PATCH', contentType: 'application/merge-patch+json', body: { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } } } } } });
  }
  async scale(target: Target, replicas: number) {
    if (!['deployments', 'statefulsets', 'replicasets', 'replicationcontrollers'].includes(target.kind)) throw new AppError('UNSUPPORTED', 'This resource does not support replica scaling.');
    await kubeJson(this.config(target.clusterId), `${targetPath(target)}/scale`, { method: 'PATCH', contentType: 'application/merge-patch+json', body: { spec: { replicas } } });
  }
  async cordon(clusterId: string, name: string, unschedulable: boolean) {
    await kubeJson(this.config(clusterId), `/api/v1/nodes/${encodeURIComponent(name)}`, { method: 'PATCH', contentType: 'application/merge-patch+json', body: { spec: { unschedulable } } });
  }
  async apply(clusterId: string, yaml: string, namespace: string | undefined, dryRun: boolean) {
    const document = parse(yaml, { maxAliasCount: 50 });
    const identity = z.object({ apiVersion: z.string().regex(/^(?:v1|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\/v[0-9]+(?:(?:alpha|beta)[0-9]+)?)$/), kind: z.string().regex(/^[A-Za-z][A-Za-z0-9]+$/), metadata: z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/).max(253), namespace: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(63).optional() }) }).safeParse(document);
    if (!identity.success) throw new AppError('INVALID_RESOURCE', 'Provide one manifest with apiVersion, kind and metadata.name.');
    const info = identity.data;
    const root = info.apiVersion === 'v1' ? '/api/v1' : `/apis/${info.apiVersion}`;
    const discovery = await kubeJson<{ resources: { kind: string; name: string; namespaced: boolean; verbs: string[] }[] }>(this.config(clusterId), root);
    const descriptor = discovery.resources.find(r => r.kind === info.kind && !r.name.includes('/') && r.verbs.includes('patch'));
    if (!descriptor) throw new AppError('UNSUPPORTED', 'The cluster does not expose an apply-capable API for this kind.');
    const ns = info.metadata.namespace ?? namespace ?? 'default';
    if (descriptor.namespaced) document.metadata.namespace = ns; else delete document.metadata.namespace;
    delete document.status; delete document.metadata.managedFields;
    const path = `${root}${descriptor.namespaced ? `/namespaces/${encodeURIComponent(ns)}` : ''}/${encodeURIComponent(descriptor.name)}/${encodeURIComponent(info.metadata.name)}`;
    const query = new URLSearchParams({ fieldManager: 'cluster-workbench', ...(dryRun ? { dryRun: 'All' } : {}) });
    await kubeJson(this.config(clusterId), `${path}?${query}`, { method: 'PATCH', contentType: 'application/apply-patch+yaml', body: document });
    return { name: info.metadata.name, kind: info.kind, namespace: descriptor.namespaced ? ns : undefined };
  }
  async metrics(clusterId: string) {
    const settings = this.clusters.settings(clusterId);
    if (settings.metricsSource === 'none') return { nodes: [], pods: [], source: 'none', warning: 'Metrics are disabled for this cluster.' };
    const providers = new Providers(this.clusters);
    if (settings.metricsSource === 'prometheus') return providers.prometheus(clusterId);
    const result = await Promise.allSettled(['/apis/metrics.k8s.io/v1beta1/nodes', '/apis/metrics.k8s.io/v1beta1/pods'].map(path => kubeJson<{ items: Resource[] }>(this.config(clusterId), path)));
    if (settings.metricsSource === 'automatic' && result[0].status === 'rejected') { try { return await providers.prometheus(clusterId); } catch {} }
    return { source: 'metrics-server', nodes: result[0].status === 'fulfilled' ? result[0].value.items : [], pods: result[1].status === 'fulfilled' ? result[1].value.items : [], warning: result.some(r => r.status === 'rejected') ? 'Live CPU and memory metrics require metrics-server and permission to read metrics.k8s.io.' : undefined };
  }
}
