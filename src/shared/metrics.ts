import type { Resource } from './protocol';
import { quantity } from './quantities';
export function isControlPlane(node: Resource) {
  const labels = node.metadata.labels ?? {};
  return 'node-role.kubernetes.io/control-plane' in labels || 'node-role.kubernetes.io/master' in labels || labels['kubernetes.io/role'] === 'master';
}
export function selectNodes(nodes: Resource[], scope: string) {
  return nodes.filter(n => scope === 'all' || (scope === 'masters' ? isControlPlane(n) : scope === 'workers' ? !isControlPlane(n) : n.metadata.name === scope.slice(5)));
}
export function scopedUsage(samples: Resource[], nodes: Resource[], all: boolean) {
  const aliases = new Set(nodes.flatMap(n => [n.metadata.name, ...(n.status?.addresses ?? []).map((a: any) => a.address)]).filter(Boolean));
  const matches = samples.filter(sample => {
    const name = sample.metadata.name ?? '';
    const host = name.startsWith('[') ? name.slice(1, name.indexOf(']')) : name.replace(/:\d+$/, '');
    return all || aliases.has(name) || aliases.has(host);
  });
  return { cpu: matches.reduce((sum, n) => sum + quantity(n.usage?.cpu), 0), memory: matches.reduce((sum, n) => sum + quantity(n.usage?.memory), 0), available: matches.length > 0 };
}
