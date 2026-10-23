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
  constructor(private clusters: ClusterManager) {}
  private config(id: string) { return this.clusters.get(id).config; }
  async list(scope: Scope) { return (await this.listVersioned(scope)).items; }
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
    const publish = () => { if (!publishTimer) publishTimer = setTimeout(() => { publishTimer = undefined; if (!stopped) onItems([...cache.values()]); }, 100); };
    const retry = (error?: unknown) => {
      if (stopped || timer) return;
      if (error) onError(error);
      timer = setTimeout(() => { timer = undefined; void start(); }, backoff + Math.random() * 500);
      backoff = Math.min(30000, backoff * 2);
    };
    const start = async () => {
      try {
        const initial = await this.listVersioned(scope, lifetime.signal);
        if (stopped) return;
        cache.clear(); initial.items.forEach(item => cache.set(item.metadata.uid ?? `${item.metadata.namespace}/${item.metadata.name}`, item)); publish();
        const pending = await new Watch(this.config(scope.clusterId)).watch(resourcePath(scope), { resourceVersion: initial.version, allowWatchBookmarks: true, timeoutSeconds: 240 }, (type, object) => {
          if (stopped) return;
          if (type === 'ERROR') { controller?.abort(); retry(new Error('Watch expired')); return; }
          if (type === 'BOOKMARK') return;
          backoff = 1000; const key = object.metadata?.uid ?? `${object.metadata?.namespace}/${object.metadata?.name}`;
          if (type === 'DELETED') cache.delete(key); else if (type === 'ADDED' || type === 'MODIFIED') cache.set(key, this.normalize(scope, object)); publish();
        }, error => retry(error));
        if (stopped) pending.abort(); else controller = pending;
      } catch (error) { retry(error); }
    };
    void start();
    return () => { stopped = true; lifetime.abort(); clearTimeout(timer); clearTimeout(publishTimer); controller?.abort(); cache.clear(); };
  }
  async yaml(target: Target) {
    if (definition(target).kind === 'Secret') throw new AppError('REDACTED', 'Secret values are not exposed by this workbench.');
    const resource = await kubeJson<Resource>(this.config(target.clusterId), targetPath(target));
    if (resource.metadata) delete resource.metadata.managedFields;
    return stringify(resource);
  }
  async replace(target: Target, yaml: string) {
    if (definition(target).kind === 'Secret') throw new AppError('REDACTED', 'Secret editing is unavailable.');
    const document = parse(yaml, { maxAliasCount: 50 }) as Resource; validateReplacement(target, document); delete document.status;
    await kubeJson(this.config(target.clusterId), targetPath(target), { method: 'PUT', body: document });
  }
  async delete(target: Target) { await kubeJson(this.config(target.clusterId), targetPath(target), { method: 'DELETE', body: { apiVersion: 'v1', kind: 'DeleteOptions', propagationPolicy: 'Background' } }); }
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
