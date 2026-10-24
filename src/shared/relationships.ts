import { catalog, type BuiltinKind } from './catalog';
import type { Resource } from './protocol';
export function resourceKind(resource: { kind?: string; apiVersion?: string }) {
  return (Object.keys(catalog) as BuiltinKind[]).find(key => catalog[key].kind === resource.kind && (!resource.apiVersion || catalog[key].apiVersion === resource.apiVersion));
}
export function ownedBy(child: Resource, parent: Resource) {
  return !!parent.metadata.uid && child.metadata.namespace === parent.metadata.namespace && (child.metadata.ownerReferences as any[] | undefined)?.some(o => o.uid === parent.metadata.uid && o.controller !== false) === true;
}
export function deploymentRevisions(deployment: Resource, sets: Resource[]) {
  return sets.filter(rs => ownedBy(rs, deployment)).sort((a, b) => Number(b.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? 0) - Number(a.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? 0));
}
export function relatedPods(resource: Resource, pods: Resource[], intermediates: Resource[] = []) {
  return pods.filter(pod => {
    if (resource.kind === 'Node') return pod.spec?.nodeName === resource.metadata.name;
    if (pod.metadata.namespace !== resource.metadata.namespace) return false;
    if (resource.kind === 'Service') {
      const selector = resource.spec?.selector ?? {};
      return Object.keys(selector).length > 0 && Object.entries(selector).every(([k, v]) => pod.metadata.labels?.[k] === v);
    }
    if (resource.kind === 'PersistentVolumeClaim') return pod.spec?.volumes?.some((v: any) => v.persistentVolumeClaim?.claimName === resource.metadata.name) === true;
    return ownedBy(pod, resource) || intermediates.some(child => ownedBy(child, resource) && ownedBy(pod, child));
  });
}
