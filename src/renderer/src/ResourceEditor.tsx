import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Resource, Target } from '../../shared/protocol';
import { editorValues, resourceEditSchema, type ResourceEdit } from '../../shared/resource-editors';
import { request } from './api';
import { useStore } from './store';
import { startResourceOperation } from './resource-operations';

function KeyValues({ label, value, onChange, multiline = false }: { label: string; value: Record<string, string>; onChange: (value: Record<string, string>) => void; multiline?: boolean }) {
  const [rows, setRows] = useState(() => Object.entries(value).map(([key, text]) => ({ id: crypto.randomUUID(), key, text })));
  const element = useRef<HTMLFieldSetElement>(null);
  const update = (next: typeof rows) => { setRows(next); onChange(Object.fromEntries(next.map(r => [r.key, r.text]))); };
  useEffect(() => { element.current?.querySelectorAll<HTMLInputElement>('[data-map-key]').forEach((input, i) => input.setCustomValidity(rows.some((r, j) => i !== j && r.key === rows[i].key) ? 'Keys must be unique.' : '')); }, [rows]);
  return <fieldset className="key-value-editor" ref={element}><legend>{label}</legend>{rows.map((row, i) => <div className="key-value-row" key={row.id}>
    <input data-map-key required aria-label={`${label} key ${i + 1}`} placeholder="Key" value={row.key} onChange={e => update(rows.map(r => r.id === row.id ? { ...r, key: e.target.value } : r))}/>
    {multiline ? <textarea aria-label={`${label} value ${i + 1}`} value={row.text} rows={3} onChange={e => update(rows.map(r => r.id === row.id ? { ...r, text: e.target.value } : r))}/> : <input aria-label={`${label} value ${i + 1}`} value={row.text} onChange={e => update(rows.map(r => r.id === row.id ? { ...r, text: e.target.value } : r))}/>}
    <button type="button" aria-label={`Remove ${label} ${i + 1}`} onClick={() => update(rows.filter(r => r.id !== row.id))}><X size={15}/></button>
  </div>)}<button type="button" onClick={() => update([...rows, { id: crypto.randomUUID(), key: '', text: '' }])}>Add {label.toLowerCase()} entry</button></fieldset>;
}

export function ResourceEditor({ target: original, onClose }: { target: Target; onClose: () => void }) {
  const [target] = useState(original), [resource, setResource] = useState<Resource>(), [changes, setChanges] = useState<ResourceEdit>();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [validated, setValidated] = useState(false), [confirm, setConfirm] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const clusterName = useStore(s => s.clusters.find(c => c.id === target.clusterId)?.name ?? target.clusterId);
  useEffect(() => {
    let active = true;
    void request('resources:get', target).then(r => { if (active) { setResource(r); setChanges(editorValues(r)); } }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [target]);
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); onClose(); } }; document.addEventListener('keydown', key, true); return () => document.removeEventListener('keydown', key, true); }, [onClose]);
  const update = (next: ResourceEdit) => { setChanges(next); setValidated(false); setConfirm(false); setError(''); };
  const input = resource && changes && { ...target, uid: resource.metadata.uid!, resourceVersion: resource.metadata.resourceVersion!, changes };
  const validate = async () => {
    if (!input || !form.current?.reportValidity()) return;
    const parsed = resourceEditSchema.safeParse(input.changes);
    if (!parsed.success) { setError('Check required fields, port numbers and resource quantities.'); return; }
    setBusy(true); setError(''); setValidated(false);
    try { await request('resources:edit', { ...input, dryRun: true }); setValidated(true); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const save = () => {
    if (!input || !validated) return;
    if (startResourceOperation(target, `Edit ${target.name} · ${clusterName}`, () => request('resources:edit', { ...input, dryRun: false }))) onClose();
    else setError('An action is already running for this resource.');
  };
  return <div className="modal-backdrop"><section className="resource-action-modal resource-editor-modal" role="dialog" aria-modal="true" aria-label="Edit resource">
    <header><h2>Edit {resource?.kind ?? 'resource'} — {target.name}</h2><button aria-label="Close resource editor" onClick={onClose}><X size={18}/></button></header>
    <p>Context: <b>{clusterName}</b> · {target.namespace}/{target.name}. Other fields are preserved. Saving requires server validation and the reviewed resource version.</p>
    {!changes && !error && <p>Loading current fields…</p>}{error && <p className="inline-error" role="alert">{error}</p>}
    <form ref={form} onSubmit={e => e.preventDefault()}><fieldset disabled={busy || confirm} className="editor-fields">
      {changes?.type === 'configmap' && <><p className="muted">Text entries only. Existing binaryData is preserved. Immutable ConfigMaps cannot be changed.</p><KeyValues label="Data" value={changes.data} multiline onChange={data => update({ ...changes, data })}/></>}
      {changes?.type === 'workload' && <>
        {changes.replicas !== undefined && <label>Replicas<input aria-label="Editor replicas" required type="number" min="0" max="10000" value={changes.replicas} onChange={e => update({ ...changes, replicas: Number(e.target.value) })}/></label>}
        {changes.containers.map((c, i) => <fieldset className="container-editor" key={c.name}><legend>Container: {c.name}</legend>
          <label>Image<input aria-label={`Image ${c.name}`} required value={c.image} onChange={e => update({ ...changes, containers: changes.containers.map((item, j) => j === i ? { ...item, image: e.target.value } : item) })}/></label>
          <p className="muted">Quantities use Kubernetes units, for example CPU 250m and memory 256Mi.</p>
          {(['requests', 'limits'] as const).map(key => <KeyValues key={key} label={`${c.name} ${key}`} value={c.resources[key]} onChange={value => update({ ...changes, containers: changes.containers.map((item, j) => j === i ? { ...item, resources: { ...item.resources, [key]: value } } : item) })}/>)}
        </fieldset>)}
      </>}
      {changes?.type === 'cronjob' && <div className="editor-grid">
        <label>Schedule<input aria-label="CronJob schedule" required value={changes.schedule} placeholder="0 * * * *" onChange={e => update({ ...changes, schedule: e.target.value })}/></label>
        <label>Time zone<input aria-label="CronJob time zone" value={changes.timeZone} placeholder="Controller default" onChange={e => update({ ...changes, timeZone: e.target.value })}/></label>
        <label>Concurrency policy<select aria-label="Concurrency policy" value={changes.concurrencyPolicy} onChange={e => update({ ...changes, concurrencyPolicy: e.target.value as 'Allow' | 'Forbid' | 'Replace' })}>{['Allow', 'Forbid', 'Replace'].map(v => <option key={v}>{v}</option>)}</select></label>
        <label>Successful Jobs to retain<input aria-label="Successful Jobs history" type="number" min="0" max="10000" required value={changes.successfulJobsHistoryLimit} onChange={e => update({ ...changes, successfulJobsHistoryLimit: Number(e.target.value) })}/></label>
        <label>Failed Jobs to retain<input aria-label="Failed Jobs history" type="number" min="0" max="10000" required value={changes.failedJobsHistoryLimit} onChange={e => update({ ...changes, failedJobsHistoryLimit: Number(e.target.value) })}/></label>
      </div>}
      {changes?.type === 'service' && <>
        <label>Service type<select aria-label="Service type" value={changes.serviceType} onChange={e => update({ ...changes, serviceType: e.target.value as typeof changes.serviceType })}>{['ClusterIP', 'NodePort', 'LoadBalancer'].map(t => <option key={t}>{t}</option>)}</select></label>
        <KeyValues label="Selector" value={changes.selector} onChange={selector => update({ ...changes, selector })}/>
        <h3>Ports</h3>{changes.ports.map((p, i) => {
          const port = (patch: Partial<typeof p>) => update({ ...changes, ports: changes.ports.map((v, j) => j === i ? { ...v, ...patch } : v) });
          return <fieldset className="service-port-editor" key={i}><legend>Port {i + 1}</legend><div className="editor-grid">
            <label>Name<input aria-label={`Port name ${i + 1}`} value={p.name} onChange={e => port({ name: e.target.value })}/></label>
            <label>Port<input aria-label={`Service port ${i + 1}`} type="number" required min="1" max="65535" value={p.port} onChange={e => port({ port: Number(e.target.value) })}/></label>
            <label>Target port<input aria-label={`Target port ${i + 1}`} required value={p.targetPort} onChange={e => port({ targetPort: /^\d+$/.test(e.target.value) ? Number(e.target.value) : e.target.value })}/></label>
            <label>Protocol<select aria-label={`Protocol ${i + 1}`} value={p.protocol} onChange={e => port({ protocol: e.target.value as typeof p.protocol })}>{['TCP', 'UDP', 'SCTP'].map(t => <option key={t}>{t}</option>)}</select></label>
            {changes.serviceType !== 'ClusterIP' && <label>Node port (blank = automatic)<input aria-label={`Node port ${i + 1}`} type="number" min="1" max="65535" value={p.nodePort ?? ''} onChange={e => port({ nodePort: e.target.value ? Number(e.target.value) : undefined })}/></label>}
          </div><button type="button" onClick={() => update({ ...changes, ports: changes.ports.filter((_, j) => i !== j) })}>Remove port {i + 1}</button></fieldset>;
        })}<button type="button" onClick={() => update({ ...changes, ports: [...changes.ports, { name: '', port: 80, targetPort: 80, protocol: 'TCP' }] })}>Add port</button>
      </>}
    </fieldset></form>
    {validated && <p className="validation-result">API-server validation passed. Concurrent changes will require reopening this editor.</p>}
    {confirm && <p className="warning-text">Save these changes to {target.name} in {clusterName}? Workload template changes can replace running Pods.</p>}
    <footer><button onClick={onClose}>Cancel</button>{confirm ? <><button onClick={() => setConfirm(false)}>Back to editing</button><button className="primary" onClick={save}>Confirm save changes</button></> : <><button disabled={busy || !changes} onClick={() => void validate()}>{busy ? 'Validating…' : 'Validate changes'}</button><button className="primary" disabled={!validated || busy} onClick={() => setConfirm(true)}>Save changes</button></>}</footer>
  </section></div>;
}
