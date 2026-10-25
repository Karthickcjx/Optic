import { z } from 'zod';
import type { Resource } from './protocol';

const map = z.record(z.string().min(1).max(253), z.string().max(1_000_000));
const resources = z.object({ requests: map, limits: map }).strict();
export const resourceEditSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('configmap'), data: map }).strict(),
  z.object({ type: z.literal('workload'), replicas: z.number().int().min(0).max(10000).optional(), containers: z.array(z.object({ name: z.string().min(1), image: z.string().min(1).max(2048), resources }).strict()).min(1).max(100) }).strict(),
  z.object({ type: z.literal('service'), serviceType: z.enum(['ClusterIP', 'NodePort', 'LoadBalancer']), selector: map, ports: z.array(z.object({ name: z.string().max(63), port: z.number().int().min(1).max(65535), targetPort: z.union([z.number().int().min(1).max(65535), z.string().min(1).max(63)]), protocol: z.enum(['TCP', 'UDP', 'SCTP']), nodePort: z.number().int().min(1).max(65535).optional() }).strict()).min(1).max(100) }).strict(),
  z.object({ type: z.literal('cronjob'), schedule: z.string().trim().min(1).max(256), timeZone: z.string().max(128), concurrencyPolicy: z.enum(['Allow', 'Forbid', 'Replace']), successfulJobsHistoryLimit: z.number().int().min(0).max(10000), failedJobsHistoryLimit: z.number().int().min(0).max(10000) }).strict()
]);
export type ResourceEdit = z.infer<typeof resourceEditSchema>;
export const editableWorkloads = ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'ReplicationController'];
export function supportsEditor(resource: Resource) { return resource.kind === 'ConfigMap' || resource.kind === 'CronJob' || editableWorkloads.includes(resource.kind ?? '') || resource.kind === 'Service' && resource.spec?.type !== 'ExternalName'; }
export function editorValues(resource: Resource): ResourceEdit {
  if (resource.kind === 'ConfigMap') return { type: 'configmap', data: { ...resource.data } };
  if (resource.kind === 'CronJob') return { type: 'cronjob', schedule: resource.spec?.schedule ?? '', timeZone: resource.spec?.timeZone ?? '', concurrencyPolicy: resource.spec?.concurrencyPolicy ?? 'Allow', successfulJobsHistoryLimit: resource.spec?.successfulJobsHistoryLimit ?? 3, failedJobsHistoryLimit: resource.spec?.failedJobsHistoryLimit ?? 1 };
  if (resource.kind === 'Service' && resource.spec?.type !== 'ExternalName') return { type: 'service', serviceType: resource.spec?.type ?? 'ClusterIP', selector: { ...resource.spec?.selector }, ports: (resource.spec?.ports ?? []).map((p: any) => ({ name: p.name ?? '', port: p.port, targetPort: p.targetPort ?? p.port, protocol: p.protocol ?? 'TCP', ...(p.nodePort ? { nodePort: p.nodePort } : {}) })) };
  if (!editableWorkloads.includes(resource.kind ?? '')) throw new Error('No form editor is available for this resource.');
  return { type: 'workload', ...(resource.kind === 'DaemonSet' ? {} : { replicas: resource.spec?.replicas ?? 1 }), containers: (resource.spec?.template?.spec?.containers ?? []).map((c: any) => ({ name: c.name, image: c.image, resources: { requests: { ...c.resources?.requests }, limits: { ...c.resources?.limits } } })) };
}

// Edit only supported fields, retaining selectors, probes, volumes and other settings.
export function editedFields(resource: Resource, input: ResourceEdit) {
  const changes = resourceEditSchema.parse(input);
  if (editorValues(resource).type !== changes.type) throw new Error('Editor does not match the selected resource.');
  if (changes.type === 'configmap') return { path: '/data', value: changes.data };
  const spec = structuredClone(resource.spec ?? {});
  if (changes.type === 'workload') {
    if (resource.kind !== 'DaemonSet') { if (changes.replicas === undefined) throw new Error('Replicas are required.'); spec.replicas = changes.replicas; }
    const containers = spec.template?.spec?.containers;
    if (!containers || containers.length !== changes.containers.length || new Set(changes.containers.map(c => c.name)).size !== containers.length) throw new Error('Container identities changed. Reopen the editor.');
    for (const item of changes.containers) {
      const container = containers.find((c: any) => c.name === item.name);
      if (!container) throw new Error('Container identities changed. Reopen the editor.');
      container.image = item.image; container.resources = { ...container.resources, ...item.resources };
    }
  } else if (changes.type === 'service') {
    spec.type = changes.serviceType; spec.selector = changes.selector;
    spec.ports = changes.ports.map(p => {
      const original = resource.spec?.ports?.find((old: any) => (old.name ?? '') === p.name);
      const result = { ...original, ...p };
      if (!result.name) delete result.name;
      if (changes.serviceType === 'ClusterIP' || !p.nodePort) delete result.nodePort;
      return result;
    });
    if (changes.serviceType !== 'LoadBalancer') { delete spec.healthCheckNodePort; delete spec.allocateLoadBalancerNodePorts; delete spec.loadBalancerClass; }
    if (changes.serviceType === 'ClusterIP') delete spec.externalTrafficPolicy;
  } else {
    const { type: _type, timeZone, ...fields } = changes;
    Object.assign(spec, fields); if (timeZone.trim()) spec.timeZone = timeZone.trim(); else delete spec.timeZone;
  }
  return { path: '/spec', value: spec };
}
