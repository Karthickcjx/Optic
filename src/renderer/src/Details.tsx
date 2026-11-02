import { ResourceActionDialog, type ResourceAction } from './ResourceActionDialog';
import { ResourceEditor } from './ResourceEditor';
import { supportsEditor } from '../../shared/resource-editors';
import { ResourceMetrics } from './ResourceMetrics';
import { metricWorkloads } from '../../shared/resource-metrics';
import { RelatedResources } from './RelatedResources';
import { resourceSeverity } from '../../shared/severity';
import { ResourceProperties, ContainerProperties } from './ResourceProperties';
import { useEffect, useMemo, useState } from 'react';
import { FileText, GitCompare, Play, RotateCw, Save, ShieldCheck, TerminalSquare, Trash2, Undo2, X } from 'lucide-react';
import { diffLines } from '../../shared/yaml-diff';
import { YamlDiff } from './YamlDiff';
import type { Resource, Target } from '../../shared/protocol';
import { request } from './api';
import { discardYaml, useStore } from './store';
import { Status } from './Table';
import { useResources } from './hooks';

export function Details({ resource }: { resource: Resource }) {
  const clusterId = useStore(s => s.clusterId), kind = useStore(s => s.kind), select = useStore(s => s.select), openTab = useStore(s => s.openTab), notify = useStore(s => s.notify);
  const [tab, setTab] = useState('Overview'); const [yaml, setYaml] = useState(''); const [busy, setBusy] = useState(false); const [confirm, setConfirm] = useState<'delete' | 'restart' | 'save' | 'scale' | 'cordon' | 'nodeshell'>();
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(''); const setDetailsDirty = useStore(s => s.setDetailsDirty);
  const dirty = tab === 'YAML' && yaml !== loaded;
  const [showDiff, setShowDiff] = useState(false), [validation, setValidation] = useState<{ ok: boolean; message: string }>();
  const changes = useMemo(() => { const lines = dirty ? diffLines(loaded, yaml) : []; return lines && { added: lines.filter(l => l.type === 'add').length, removed: lines.filter(l => l.type === 'remove').length }; }, [dirty, loaded, yaml]);
  const edit = (value: string) => { setYaml(value); setValidation(undefined); if (value === loaded) setShowDiff(false); };
  // Server-side dry run: admission, schema and conflict checks without saving.
  const validate = async () => {
    setBusy(true); setValidation(undefined);
    try { await request('resources:replace', { ...target, yaml, dryRun: true }); setValidation({ ok: true, message: 'The API server accepted these changes (dry run). Nothing was saved.' }); }
    catch (e) { setValidation({ ok: false, message: (e as Error).message }); } finally { setBusy(false); }
  };
  useEffect(() => { setDetailsDirty(dirty); }, [dirty]);
  useEffect(() => () => setDetailsDirty(false), []);
  const [action, setAction] = useState<ResourceAction>();
  const [editor, setEditor] = useState(false);
  const [forward, setForward] = useState(false), [localPort, setLocalPort] = useState(0), [remotePort, setRemotePort] = useState<number>(resource.spec?.ports?.[0]?.port ?? resource.spec?.containers?.[0]?.ports?.[0]?.containerPort ?? 8080);
  const custom = useStore(s => s.custom), navigate = useStore(s => s.navigate);
  const [replicas, setReplicas] = useState(resource.spec?.replicas ?? 1);
  const target: Target = { clusterId, kind, custom, namespace: resource.metadata.namespace, name: resource.metadata.name! };
  const events = useResources(tab === 'Events' ? clusterId : '', 'events', resource.metadata.namespace);
  useEffect(() => {
    let active = true; setYaml(''); setLoaded(''); setError(''); setShowDiff(false); setValidation(undefined);
    if (tab === 'YAML') void request('resources:yaml', target).then(value => { if (active) { setYaml(value); setLoaded(value); } }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [resource.metadata.uid, tab, clusterId]);
  const run = async () => {
    setBusy(true);
    try {
      if (confirm === 'nodeshell') openTab({ type: 'terminal', title: `Node / ${target.name}`, options: { clusterId, node: target.name, cols: 100, rows: 24 } });
      if (confirm === 'scale') await request('resources:scale', { ...target, replicas: Number(replicas) });
      if (confirm === 'cordon') await request('nodes:cordon', { clusterId, name: target.name, unschedulable: !resource.spec?.unschedulable });
      if (confirm === 'save') { await request('resources:replace', { ...target, yaml }); setLoaded(yaml); setShowDiff(false); setValidation(undefined); }
      if (confirm === 'delete') { await request('resources:delete', target); setDetailsDirty(false); select(undefined); }
      if (confirm === 'restart') await request('resources:restart', target);
      setConfirm(undefined);
    } catch (e) { notify((e as Error).message); } finally { setBusy(false); }
  };
  const open = (type: 'logs' | 'terminal', container: string) => openTab({ type, title: `${resource.metadata.name} / ${container}`, options: { clusterId, namespace: resource.metadata.namespace!, pod: resource.metadata.name!, container, cols: 100, rows: 24 } });
  return <aside className="details"><header><span className="eyebrow">{resource.kind} DETAILS</span><button title="Close details" onClick={() => select(undefined)}><X size={18}/></button></header><h2>{resource.metadata.name}</h2><Status resource={resource}/><div className="detail-tabs">{['Overview', 'Related', ...((metricWorkloads as readonly string[]).includes(kind) ? ['Metrics'] : []), 'YAML', ...(kind !== 'events' ? ['Events'] : [])].map(name => <button className={tab === name ? 'active' : ''} key={name} onClick={() => { if (name !== tab && dirty && !window.confirm(discardYaml)) return; setTab(name); }}>{name}</button>)}</div>
    <div className="detail-content">{error && <div className="inline-error">{error}</div>}
    {tab === 'Overview' && <><dl><dt>Namespace</dt><dd>{resource.metadata.namespace ?? 'Cluster-wide'}</dd><dt>Created</dt><dd>{resource.metadata.creationTimestamp ? new Date(resource.metadata.creationTimestamp).toLocaleString() : '—'}</dd><dt>UID</dt><dd className="mono">{resource.metadata.uid}</dd></dl>{kind === 'nodes' && <dl><dt>Scheduling</dt><dd>{resource.spec?.unschedulable ? 'Cordoned' : 'Enabled'}</dd><dt>Kubelet</dt><dd>{resource.status?.nodeInfo?.kubeletVersion}</dd><dt>Addresses</dt><dd>{resource.status?.addresses?.map((a: any) => a.address).join(', ')}</dd></dl>}{kind === 'services' && <dl><dt>Cluster IP</dt><dd>{resource.spec?.clusterIP}</dd><dt>Ports</dt><dd>{resource.spec?.ports?.map((p: any) => `${p.port}/${p.protocol} to ${p.targetPort}`).join(', ')}</dd></dl>}{kind === 'customresourcedefinitions' && <><h3>Browse custom resources</h3>{resource.spec?.versions?.filter((v: any) => v.served).map((v: any) => <button key={v.name} onClick={() => navigate('custom', clusterId, { apiVersion: `${resource.spec?.group}/${v.name}`, kind: resource.spec?.names.kind, plural: resource.spec?.names.plural, namespaced: resource.spec?.scope === 'Namespaced' })}>{resource.spec?.names.kind} / {v.name}</button>)}</>}<ResourceProperties resource={resource}/><h3>Labels</h3><div className="labels">{Object.entries(resource.metadata.labels ?? {}).map(([key, value]) => <span key={key}>{key}: {value}</span>)}</div>{kind === 'pods' && <><h3>Containers</h3>{[...(resource.spec?.containers ?? []), ...(resource.spec?.initContainers ?? []), ...(resource.spec?.ephemeralContainers ?? [])].map((container: any) => <div className="container-card" key={container.name}><strong><Play size={13}/>{container.name}</strong><code>{container.image}</code><ContainerProperties container={container} category={resource.spec?.initContainers?.some((c: any) => c.name === container.name) ? 'Init' : resource.spec?.ephemeralContainers?.some((c: any) => c.name === container.name) ? 'Ephemeral' : 'Application'} status={[...(resource.status?.containerStatuses ?? []), ...(resource.status?.initContainerStatuses ?? []), ...(resource.status?.ephemeralContainerStatuses ?? [])].find((s: any) => s.name === container.name)}/><div><button onClick={() => open('logs', container.name)}><FileText size={14}/>Logs</button><button onClick={() => open('terminal', container.name)}><TerminalSquare size={14}/>Shell</button></div></div>)}</>}</>}
    {tab === 'Metrics' && <ResourceMetrics resource={resource} target={target}/>}
    {tab === 'Related' && <RelatedResources resource={resource} clusterId={clusterId}/>}
    {tab === 'YAML' && <><div className="yaml-toolbar"><span role="status">{!dirty ? 'No unsaved changes' : changes ? `${changes.added} added, ${changes.removed} removed` : 'Many lines changed'}</span><button aria-pressed={showDiff} disabled={!dirty} onClick={() => setShowDiff(v => !v)}><GitCompare size={13}/>{showDiff ? 'Edit YAML' : 'Show changes'}</button><button disabled={!dirty || busy} title="Restore the YAML loaded from the cluster" onClick={() => edit(loaded)}><Undo2 size={13}/>Revert</button><button disabled={!yaml || busy} title="Check these changes with the API server without saving" onClick={() => void validate()}><ShieldCheck size={13}/>Validate</button></div>{validation && <div className={validation.ok ? 'validation-result' : 'inline-error'} role="alert">{validation.message}</div>}{showDiff && dirty ? <YamlDiff before={loaded} after={yaml}/> : <textarea aria-label="Resource YAML" spellCheck={false} className="yaml-editor" value={yaml} onChange={e => edit(e.target.value)}/>}</>}
    {tab === 'Events' && <>{events.error && <div className="inline-error">{events.error}</div>}{events.items.filter(e => e.involvedObject?.uid === resource.metadata.uid).map(e => <div className={`event-card severity-${resourceSeverity(e)}`} key={e.metadata.uid}><strong>{e.reason}</strong><p>{e.message}</p><small>{e.count ?? 1} occurrence(s)</small></div>)}{!events.loading && !events.items.some(e => e.involvedObject?.uid === resource.metadata.uid) && <p className="muted">No events recorded for this resource.</p>}</>}
    </div><footer>{supportsEditor(resource) && <button onClick={() => setEditor(true)}>Edit resource</button>}{kind === 'nodes' && <button onClick={() => setAction('drain')}>Drain</button>}{kind === 'deployments' && <button onClick={() => setAction('rollback')}>Rollback</button>}{kind === 'cronjobs' && <><button onClick={() => setAction('trigger')}>Run now</button><button onClick={() => setAction('suspend')}>{resource.spec?.suspend ? 'Resume' : 'Suspend'}</button></>}{['pods', 'services'].includes(kind) && <button onClick={() => setForward(true)}>Port forward</button>}{tab === 'YAML' && <button disabled={!yaml || busy} onClick={() => setConfirm('save')}><Save size={14}/>Save YAML</button>}{['deployments','statefulsets','daemonsets'].includes(kind) && <button onClick={() => setConfirm('restart')}><RotateCw size={14}/>Restart</button>}{['deployments','statefulsets','replicasets','replicationcontrollers'].includes(kind) && <button onClick={() => setConfirm('scale')}>Scale</button>}{kind === 'nodes' && <button onClick={() => setConfirm('nodeshell')}>Node shell</button>}{kind === 'nodes' && <button onClick={() => setConfirm('cordon')}>{resource.spec?.unschedulable ? 'Uncordon' : 'Cordon'}</button>}<button className="danger" onClick={() => setConfirm('delete')}><Trash2 size={14}/>Delete</button></footer>
    {forward && <div className="confirm-box" role="dialog" aria-label="Port forward"><strong>Forward a local port</strong><p>{target.namespace}/{target.name}. Requires kubectl on PATH.</p><label>Local port (0 = automatic)<input aria-label="Local port" type="number" min="0" max="65535" value={localPort} onChange={e => setLocalPort(Number(e.target.value))}/></label><label>Remote TCP port<input aria-label="Remote port" type="number" min="1" max="65535" value={remotePort} onChange={e => setRemotePort(Number(e.target.value))}/></label><div><button onClick={() => setForward(false)}>Cancel</button><button className="primary" disabled={!Number.isInteger(localPort) || localPort < 0 || localPort > 65535 || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535} onClick={() => { openTab({ type: 'forward', title: `Forward / ${target.name}`, options: { clusterId, namespace: target.namespace!, kind: kind as 'pods' | 'services', name: target.name, localPort, remotePort } }); setForward(false); }}>Start forwarding</button></div></div>}
    {confirm && <div className="confirm-box"><strong>{confirm === 'delete' ? 'Delete this resource?' : confirm === 'restart' ? 'Restart this workload?' : confirm === 'scale' ? 'Scale this workload?' : confirm === 'cordon' ? 'Change node scheduling?' : confirm === 'nodeshell' ? 'Open privileged node shell?' : 'Apply YAML changes?'}</strong><p>This changes <b>{resource.metadata.name}</b> in the selected cluster.</p>{confirm === 'nodeshell' && <p>This creates a privileged pod in kube-system with host PID and network access. It allows administrative access to the node. Closing the terminal requests pod deletion.</p>}{confirm === 'scale' && <label>Replicas<input aria-label="Replicas" type="number" min="0" max="10000" value={replicas} onChange={e => setReplicas(e.target.value)}/></label>}<div><button disabled={busy} onClick={() => setConfirm(undefined)}>Cancel</button><button disabled={busy} className={confirm === 'delete' ? 'danger' : 'primary'} onClick={() => void run()}>{busy ? 'Working…' : 'Confirm'}</button></div></div>}
    {action && <ResourceActionDialog target={target} action={action} onClose={() => setAction(undefined)}/>}
    {editor && <ResourceEditor target={target} onClose={() => setEditor(false)}/>}
  </aside>;
}
