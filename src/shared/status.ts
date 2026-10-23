import type { Resource } from './protocol';
export function resourceStatus(resource: Resource): string {
  if (resource.metadata.deletionTimestamp) return 'Terminating';
  const waiting = resource.status?.containerStatuses?.find((c: any) => c.state?.waiting)?.state.waiting.reason;
  if (waiting) return waiting;
  if (resource.kind === 'Node') return resource.status?.conditions?.find((c: any) => c.type === 'Ready')?.status === 'True' ? 'Ready' : 'NotReady';
  if (['Deployment','StatefulSet','ReplicaSet'].includes(resource.kind ?? '')) return `${resource.status?.readyReplicas ?? 0}/${resource.spec?.replicas ?? 1} ready`;
  if (resource.kind === 'CronJob') return resource.spec?.suspend ? 'Suspended' : 'Active';
  if (resource.kind === 'Job') return resource.status?.failed ? 'Failed' : resource.status?.succeeded ? 'Complete' : 'Active';
  return resource.status?.phase ?? resource.type ?? 'Active';
}
