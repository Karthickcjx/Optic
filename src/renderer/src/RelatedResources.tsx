import { LogSourceDialog } from './LogSourceDialog';
import { useEffect, useState } from 'react';
import { catalog } from '../../shared/catalog';
import type { Resource } from '../../shared/protocol';
import { deploymentRevisions, relatedPods, resourceKind } from '../../shared/relationships';
import { request } from './api';
import { useResources } from './hooks';
import { useStore } from './store';
import { Status } from './Table';

const podKinds = ['Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet', 'ReplicationController', 'Job', 'CronJob', 'Service', 'Node', 'PersistentVolumeClaim'];
type Owner = { label: string; resource?: Resource; error?: string; depth: number };
export function RelatedResources({ resource, clusterId }: { resource: Resource; clusterId: string }) {
  const [logPicker, setLogPicker] = useState(false);
  const [owners, setOwners] = useState<Owner[]>([]), [ownerLoading, setOwnerLoading] = useState(false), [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const showPods = podKinds.includes(resource.kind ?? '');
  const pods = useResources(showPods ? clusterId : '', 'pods', resource.metadata.namespace);
  const intermediates = useResources(['Deployment', 'CronJob'].includes(resource.kind ?? '') ? clusterId : '', resource.kind === 'CronJob' ? 'jobs' : 'replicasets', resource.metadata.namespace);
  const ownerKey = JSON.stringify(resource.metadata.ownerReferences ?? []);
  useEffect(() => {
    let active = true;
    setOwners([]); setOwnerLoading(true);
    const walk = async (child: Resource, seen: Set<string>, depth: number): Promise<Owner[]> => {
      const result: Owner[] = [];
      for (const owner of (child.metadata.ownerReferences ?? []) as any[]) {
        const label = `${owner.kind} / ${owner.name}`, kind = resourceKind(owner);
        if (!kind) { result.push({ label, depth, error: 'This owner API is not supported by the resource browser.' }); continue; }
        if (depth >= 12 || seen.has(owner.uid)) { result.push({ label, depth, error: 'Owner chain limit or cycle detected.' }); continue; }
        try {
          const parent = await request('resources:get', { clusterId, kind, name: owner.name, namespace: catalog[kind].namespaced ? child.metadata.namespace : undefined });
          if (parent.metadata.uid !== owner.uid) throw new Error('The original owner no longer exists; its name has been reused.');
          result.push({ label, resource: parent, depth });
          result.push(...await walk(parent, new Set([...seen, owner.uid]), depth + 1));
        } catch (e) { result.push({ label, depth, error: (e as Error).message }); }
      }
      return result;
    };
    void walk(resource, new Set([resource.metadata.uid ?? '']), 0).then(rows => { if (active) setOwners(rows); }).finally(() => { if (active) setOwnerLoading(false); });
    return () => { active = false; };
  }, [clusterId, resource.metadata.uid, ownerKey, refresh]);
  const open = (target: Resource) => {
    const kind = resourceKind(target);
    if (!kind) { setError('This resource API is not supported by the browser.'); return; }
    const store = useStore.getState();
    store.navigate(kind, clusterId); store.setNamespace(target.metadata.namespace ?? ''); store.select(target);
  };
  const related = relatedPods(resource, pods.items, intermediates.items);
  const revisions = resource.kind === 'Deployment' ? deploymentRevisions(resource, intermediates.items) : [];
  const currentRevision = resource.metadata.annotations?.['deployment.kubernetes.io/revision'];
  return <div className="related-resources"><button onClick={() => { setRefresh(v => v + 1); pods.refresh(); intermediates.refresh(); }}>Refresh relationships</button>
    {error && <p className="inline-error">{error}</p>}
    <h3>Owner chain</h3>{ownerLoading ? <p>Loading owners…</p> : !owners.length ? <p className="muted">No owner references.</p> : <ul className="owner-chain">{owners.map((owner, i) => <li key={i} style={{ marginLeft: owner.depth * 10 }}><button disabled={!owner.resource} onClick={() => owner.resource && open(owner.resource)}>{owner.label}</button>{owner.error && <p className="inline-error">{owner.error}</p>}</li>)}</ul>}
    {showPods && <><h3>Related Pods ({related.length})</h3>{!!related.length && <button onClick={() => setLogPicker(true)}>Logs for related Pods</button>}{pods.error && <p className="inline-error">{pods.error}</p>}{intermediates.error && <p className="inline-error">{intermediates.error}</p>}{pods.loading || intermediates.loading ? <p>Loading related Pods…</p> : <><div className="related-table"><table><thead><tr><th>Pod</th><th>Ready</th><th>Status</th><th>Node</th></tr></thead><tbody>{related.map(pod => <tr key={pod.metadata.uid}><td><button onClick={() => open(pod)}>{pod.metadata.name}</button></td><td>{pod.status?.containerStatuses?.filter((c: any) => c.ready).length ?? 0}/{pod.spec?.containers?.length ?? 0}</td><td><Status resource={pod}/></td><td>{pod.spec?.nodeName ?? 'Unscheduled'}</td></tr>)}</tbody></table></div>{!related.length && !pods.error && !intermediates.error && <p className="muted">No related Pods found.</p>}</> }</>}
    {resource.kind === 'Deployment' && <><h3>Deployment revisions</h3><p className="muted">Retained ReplicaSets only. Select one to inspect its pod template, containers and YAML.</p><div className="related-table"><table><thead><tr><th>Revision</th><th>ReplicaSet</th><th>Ready / desired</th></tr></thead><tbody>{revisions.map(rs => <tr key={rs.metadata.uid}><td>{String(rs.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? 'Unknown')}{currentRevision && rs.metadata.annotations?.['deployment.kubernetes.io/revision'] === currentRevision ? ' (current)' : ''}</td><td><button onClick={() => open(rs)}>{rs.metadata.name}</button></td><td>{rs.status?.readyReplicas ?? 0} / {rs.spec?.replicas ?? 0}</td></tr>)}</tbody></table></div>{!revisions.length && !intermediates.loading && !intermediates.error && <p className="muted">No retained revisions found.</p>}</>}
    {logPicker && <LogSourceDialog pods={related} clusterId={clusterId} onClose={() => setLogPicker(false)}/>}
  </div>;
}
