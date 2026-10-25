import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { PodTarget, Resource } from '../../shared/protocol';
import { logSourceKey, maxLogSources } from '../../shared/logs';
import { useStore } from './store';

export function LogSourceDialog({ pods, clusterId, onClose }: { pods: Resource[]; clusterId: string; onClose: () => void }) {
  const [sources] = useState(() => pods.flatMap(p => [
    ...(p.spec?.containers ?? []).map((c: any) => ({ c, category: 'application' })),
    ...(p.spec?.initContainers ?? []).map((c: any) => ({ c, category: 'init' })),
    ...(p.spec?.ephemeralContainers ?? []).map((c: any) => ({ c, category: 'ephemeral' }))
  ].map(({ c, category }) => ({ target: { clusterId, namespace: p.metadata.namespace!, pod: p.metadata.name!, container: c.name } as PodTarget, category }))));
  const [selected, setSelected] = useState(() => sources.filter(s => s.category === 'application').slice(0, maxLogSources).map(s => logSourceKey(s.target)));
  const openTab = useStore(s => s.openTab);
  const clusterName = useStore(s => s.clusters.find(c => c.id === clusterId)?.name ?? clusterId);
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); onClose(); } }; document.addEventListener('keydown', key, true); return () => document.removeEventListener('keydown', key, true); }, [onClose]);
  return <div className="modal-backdrop"><section className="resource-action-modal" role="dialog" aria-modal="true" aria-label="Choose log sources"><header><h2>Choose log sources</h2><button aria-label="Close log sources" onClick={onClose}><X size={18}/></button></header>
    <p>Context: <b>{clusterName}</b>. Select up to {maxLogSources} Pod/container streams. New or replacement Pods are not automatically added to this selection.</p>
    <p>{selected.length} / {maxLogSources} sources selected</p><div className="log-source-picker">{sources.map(({ target, category }) => {
      const key = logSourceKey(target); return <label className="check-row" key={key}><input type="checkbox" checked={selected.includes(key)} disabled={!selected.includes(key) && selected.length >= maxLogSources} onChange={e => setSelected(old => e.target.checked ? [...old, key] : old.filter(s => s !== key))}/><span>{target.namespace}/{target.pod} · {target.container} <small>({category})</small></span></label>;
    })}{!sources.length && <p>No container sources are available.</p>}</div>
    <footer><button onClick={onClose}>Cancel</button><button className="primary" disabled={!selected.length} onClick={() => { const targets = sources.filter(s => selected.includes(logSourceKey(s.target))).map(s => s.target); openTab({ type: 'logs', title: `Logs / ${targets.length} sources`, options: { clusterId, sources: targets } }); onClose(); }}>Open log streams</button></footer>
  </section></div>;
}
