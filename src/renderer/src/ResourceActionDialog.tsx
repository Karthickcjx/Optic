import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { Resource, Target } from '../../shared/protocol';
import type { ActionTarget, DeploymentRevision, DrainOptions, DrainPreview } from '../../shared/resource-actions';
import { request } from './api';
import { useStore } from './store';
import { startResourceOperation } from './resource-operations';

export type ResourceAction = 'drain' | 'rollback' | 'trigger' | 'suspend';
export function ResourceActionDialog({ target: original, action, onClose }: { target: Target; action: ResourceAction; onClose: () => void }) {
  const [target] = useState(original), [resource, setResource] = useState<Resource>();
  const [preview, setPreview] = useState<DrainPreview>(), [revisions, setRevisions] = useState<DeploymentRevision[]>([]), [revisionUid, setRevisionUid] = useState('');
  const [options, setOptions] = useState<DrainOptions>({ ignoreDaemonSets: true, deleteEmptyDirData: false, force: false, timeoutSeconds: 300 });
  const [jobName, setJobName] = useState(`${target.name.slice(0, 40)}-manual-${Date.now().toString(36)}`);
  const [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const clusterName = useStore(s => s.clusters.find(c => c.id === target.clusterId)?.name ?? target.clusterId);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        if (action === 'drain') { const data = await request('nodes:drain-preview', target); if (active) { setPreview(data); setResource(data.node); } }
        else {
          const current = await request('resources:get', target);
          const history = action === 'rollback' ? await request('deployments:revisions', target) : [];
          if (active) { setResource(current); setRevisions(history); setRevisionUid(history.find(r => !r.current)?.uid ?? ''); }
        }
      } catch (e) { if (active) setError((e as Error).message); } finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [target, action]);
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); onClose(); } }; document.addEventListener('keydown', key, true); return () => document.removeEventListener('keydown', key, true); }, [onClose]);
  const selected = revisions.find(r => r.uid === revisionUid && !r.current);
  const suspend = !resource?.spec?.suspend;
  const title = action === 'drain' ? 'Drain node' : action === 'rollback' ? 'Roll back deployment' : action === 'trigger' ? 'Run CronJob now' : suspend ? 'Suspend CronJob' : 'Resume CronJob';
  const eligible = preview?.pods.filter(p => !p.mirror && !p.daemonSet) ?? [];
  const blocked = action === 'drain' && (!!preview?.pods.some(p => p.daemonSet) && !options.ignoreDaemonSets || eligible.some(p => p.emptyDir) && !options.deleteEmptyDirData || eligible.some(p => p.unmanaged) && !options.force);
  const disabled = loading || !resource?.metadata.uid || !resource.metadata.resourceVersion || !!blocked || action === 'rollback' && (!selected || !!resource.spec?.paused) || action === 'trigger' && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(jobName) || action === 'drain' && (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 30 || options.timeoutSeconds > 1800);
  const apply = () => {
    if (disabled || !resource) return;
    const input: ActionTarget = { ...target, uid: resource.metadata.uid!, resourceVersion: resource.metadata.resourceVersion! };
    const run = () => action === 'drain' ? request('nodes:drain', { ...input, options }) : action === 'rollback' ? request('deployments:rollback', { ...input, revision: selected!.revision, replicaSetUid: selected!.uid }) : action === 'trigger' ? request('cronjobs:trigger', { ...input, jobName }) : request('cronjobs:suspend', { ...input, suspend });
    if (startResourceOperation(target, `${title}: ${target.name} · ${clusterName}`, run)) onClose();
    else setError('An action is already running for this resource.');
  };
  return <div className="modal-backdrop"><section className="resource-action-modal" role="dialog" aria-modal="true" aria-label={title}>
    <header><h2>{title}</h2><button aria-label="Close resource action" onClick={onClose}><X size={18}/></button></header>
    <p>Context: <b>{clusterName}</b> · {target.namespace ? `${target.namespace}/` : ''}{target.name}</p>
    {loading && <p>Loading current resource…</p>}{error && <p className="inline-error" role="alert">{error}</p>}
    {resource && action === 'drain' && <>
      <p>This cordons the node and evicts eligible Pods while respecting PodDisruptionBudgets. The node stays cordoned after completion or failure. This preview is advisory; Pods are checked again when draining.</p>
      <p>{eligible.length} eligible Pod(s); {preview?.pods.filter(p => p.daemonSet).length} DaemonSet Pod(s); {preview?.pods.filter(p => p.mirror).length} mirror Pod(s).</p>
      <div className="drain-pods"><table><thead><tr><th>Pod</th><th>Handling</th></tr></thead><tbody>{preview?.pods.map(p => <tr key={p.uid}><td>{p.namespace}/{p.name}</td><td>{p.mirror ? 'Mirror — leave running' : p.daemonSet ? 'DaemonSet — leave running' : [p.unmanaged && 'Unmanaged', p.emptyDir && 'emptyDir data', !p.unmanaged && !p.emptyDir && 'Evict'].filter(Boolean).join(', ')}</td></tr>)}</tbody></table></div>
      <label className="check-row"><input type="checkbox" checked={options.ignoreDaemonSets} onChange={e => setOptions({ ...options, ignoreDaemonSets: e.target.checked })}/>Leave DaemonSet Pods running</label>
      <label className="check-row"><input type="checkbox" checked={options.deleteEmptyDirData} onChange={e => setOptions({ ...options, deleteEmptyDirData: e.target.checked })}/>Allow deletion of emptyDir data (local data will be lost)</label>
      <label className="check-row"><input type="checkbox" checked={options.force} onChange={e => setOptions({ ...options, force: e.target.checked })}/>Allow unmanaged Pods to be evicted (they may not be recreated)</label>
      <label>Timeout (seconds)<input aria-label="Drain timeout" type="number" min="30" max="1800" value={options.timeoutSeconds} onChange={e => setOptions({ ...options, timeoutSeconds: Number(e.target.value) })}/></label>
      {blocked && <p className="warning-text">Review the blocking Pod types and explicitly enable the required options before draining.</p>}
    </>}
    {resource && action === 'rollback' && <>
      <p>Restore the selected revision’s Pod template. Replica count and other Deployment settings stay unchanged. Kubernetes starts a new rollout.</p>
      <label>Retained revision<select aria-label="Rollback revision" value={revisionUid} onChange={e => setRevisionUid(e.target.value)}><option value="">Select a revision</option>{revisions.map(r => <option key={r.uid} value={r.uid} disabled={r.current}>Revision {r.revision}{r.current ? ' (current)' : ''} — {r.images.join(', ')}</option>)}</select></label>
      {!revisions.some(r => !r.current) && <p>No earlier retained revision is available.</p>}{resource.spec?.paused && <p className="inline-error">This Deployment is paused. Resume it before rollback.</p>}
    </>}
    {resource && action === 'trigger' && <><p>Create one Job from the current Job template. This also works when the CronJob is suspended. Manual Jobs do not obey the CronJob scheduler’s concurrency policy; a run can overlap existing Jobs.</p><label>Job name<input aria-label="Manual Job name" value={jobName} maxLength={63} onChange={e => setJobName(e.target.value)}/></label></>}
    {resource && action === 'suspend' && <p>{suspend ? 'Pause future scheduled Jobs. Already running Jobs continue.' : 'Resume scheduling. Missed executions may start immediately, depending on the starting deadline.'}</p>}
    <footer><button onClick={onClose}>Cancel</button><button className="primary" disabled={disabled} onClick={apply}>Confirm {title.toLowerCase()}</button></footer>
  </section></div>;
}
