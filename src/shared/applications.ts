import type { Resource } from './protocol';

export function groupApplications(resources: Resource[]) {
  const groups = new Map<string, { name: string; namespace: string; resources: Resource[] }>();
  for (const resource of resources) {
    const labels = resource.metadata.labels ?? {};
    const name = labels['app.kubernetes.io/part-of'] || labels['app.kubernetes.io/instance'] || labels['app.kubernetes.io/name'] || labels.app;
    if (!name) continue;
    const namespace = resource.metadata.namespace ?? '';
    const key = JSON.stringify([namespace, name]);
    const group = groups.get(key) ?? { name, namespace, resources: [] };
    group.resources.push(resource);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name) || a.namespace.localeCompare(b.namespace));
}
