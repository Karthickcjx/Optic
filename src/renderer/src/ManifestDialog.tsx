import { useEffect, useState } from 'react';
import { openImportDeploy } from './ImportDeployDialog';
import { CheckCircle2, FileCode2, X } from 'lucide-react';
import { catalog, type BuiltinKind } from '../../shared/catalog';
import { manifestTemplate } from '../../shared/manifest-templates';
import { request } from './api';
import { useStore } from './store';
export function ManifestDialog({ onClose }: { onClose: () => void }) {
  const store = useStore();
  // Keep the target context stable throughout validation and application.
  const [target] = useState(() => ({ clusterId: store.clusterId, namespace: store.namespace || store.clusterSettings[store.clusterId]?.accessibleNamespaces[0] || 'default', custom: store.view === 'custom' ? store.custom : undefined }));
  const { clusterId, namespace } = target;
  const { clusters } = store;
  const [templateKind, setTemplateKind] = useState<BuiltinKind | 'custom'>(() => store.view === 'custom' ? 'custom' : store.view in catalog ? store.view as BuiltinKind : 'configmaps');
  const [yaml, setYaml] = useState(() => manifestTemplate(templateKind, namespace, target.custom));
  const [preview, setPreview] = useState<{ name: string; kind: string; namespace?: string }>(); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); if (!busy) onClose(); } }; document.addEventListener('keydown', key, true); return () => document.removeEventListener('keydown', key, true); }, [busy]);
  const submit = async (dryRun: boolean) => {
    setBusy(true); setError('');
    try { const result = await request('resources:apply', { clusterId, namespace: namespace || undefined, yaml, dryRun }); if (dryRun) setPreview(result); else onClose(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <div className="modal-backdrop"><section className="manifest-modal" role="dialog" aria-modal="true" aria-label="Apply manifest"><header><FileCode2 size={18}/><h2>Create or apply resource</h2><button title="Close manifest" disabled={busy} onClick={onClose}><X size={17}/></button></header><p>Context: <b>{clusters.find(c => c.id === clusterId)?.name}</b>. The server validates your manifest before you apply it.</p><label>Resource template <select aria-label="Resource template" disabled={busy} value={templateKind} onChange={e => { const kind = e.target.value as BuiltinKind | 'custom'; if (yaml !== manifestTemplate(templateKind, namespace, target.custom) && !window.confirm('Replace your edited YAML with a new resource template?')) return; setTemplateKind(kind); setYaml(manifestTemplate(kind, namespace, target.custom)); setPreview(undefined); setError(''); }}>{Object.entries(catalog).map(([key, entry]) => <option key={key} value={key}>{entry.label}</option>)}{target.custom && <option value="custom">{target.custom.kind}</option>}</select></label><div className="code-editor"><div className="line-numbers">{yaml.split('\n').map((_, i) => <span key={i}>{i + 1}</span>)}</div><textarea aria-label="Manifest YAML" disabled={busy} spellCheck={false} value={yaml} onChange={e => { setYaml(e.target.value); setPreview(undefined); }}/></div>{error && <div className="inline-error">{error}</div>}{preview && <div className="validation-result"><CheckCircle2 size={16}/>Validated {preview.kind} <b>{preview.name}</b>{preview.namespace && ` in ${preview.namespace}`}. Applying will create or update this resource.</div>}<footer><button disabled={busy} onClick={() => { onClose(); openImportDeploy(); }}>Import files / chart…</button><button disabled={busy} onClick={onClose}>Cancel</button><button disabled={busy || !clusterId} onClick={() => void submit(true)}>Validate manifest</button><button className="primary" disabled={busy || !preview} onClick={() => void submit(false)}>{busy ? 'Working…' : 'Apply to cluster'}</button></footer></section></div>;
}
