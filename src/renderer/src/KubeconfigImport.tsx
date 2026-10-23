import { useState } from 'react';
import { request } from './api';
export function KubeconfigImport({ onClose, onImported }: { onClose: () => void; onImported: () => Promise<void> }) {
  const [yaml, setYaml] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submit = async () => {
    setBusy(true); setError('');
    try { await request('clusters:import-clipboard', { yaml }); setYaml(''); await onImported(); onClose(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <div className="modal-backdrop"><section className="manifest-modal" role="dialog" aria-modal="true" aria-labelledby="kubeconfig-import-title" onKeyDown={e => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose(); } }}><header><h2 id="kubeconfig-import-title">Add Clusters from Kubeconfig</h2></header><p>Paste your kubeconfig YAML below. It will be saved in your Optic profile, without merging into ~/.kube/config. Import only trusted configurations; authentication plugins may execute locally.</p><textarea autoFocus aria-label="Kubeconfig YAML" className="kubeconfig-paste-editor" spellCheck={false} autoComplete="off" placeholder="Paste kubeconfig here (Ctrl+V)" value={yaml} disabled={busy} onChange={e => { setYaml(e.target.value); setError(''); }}/>{error && <div className="inline-error" role="alert">{error}</div>}<footer><button disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !yaml.trim()} onClick={() => void submit()}>{busy ? 'Adding clusters...' : 'Add Clusters'}</button></footer></section></div>;
}
