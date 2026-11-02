import { useEffect, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, RefreshCw, X } from 'lucide-react';
import { stringify } from 'yaml';
import { catalog, type BuiltinKind, type CustomType } from '../../shared/catalog';
import type { GitOpsDetection, GitOpsType } from '../../shared/gitops';
import type { Resource } from '../../shared/protocol';
import { redactResource } from '../../shared/redaction';
import { request } from './api';
import { useResources } from './hooks';
import { useStore } from './store';

export const MAX_ROWS = 500;
type Watch = ReturnType<typeof useResources>;

// Detection runs once per cluster (and on Refresh); undetected types never open a watch.
export function useDetection(clusterId: string, revision: number) {
  const [state, setState] = useState<{ value?: GitOpsDetection; error?: string; code?: string }>();
  useEffect(() => {
    let active = true; setState(undefined);
    request('gitops:detect', { clusterId }).then(value => { if (active) setState({ value }); }, e => { if (active) setState({ error: (e as Error).message, code: (e as { code?: string }).code }); });
    return () => { active = false; };
  }, [clusterId, revision]);
  return state;
}
export const useTypeWatch = (clusterId: string, detection: GitOpsDetection | undefined, type: GitOpsType, namespace: string) => useResources(detection?.types[type] ? clusterId : '', 'custom', namespace, detection?.types[type]);

// Status colours: green good, amber attention, red failure, grey unknown.
export const tone = (value?: string) => !value ? 'neutral' : /^(Synced|Healthy|True|deployed|Succeeded|ReconciliationSucceeded|Ready)$/.test(value) ? 'good' : /^(Degraded|Missing|False|Failed|Error|failed|SyncFailed|Stalled|error)$/.test(value) ? 'bad' : /^(OutOfSync|Progressing|Suspended|Running|Terminating|Reconciling|warning|Out of sync)$/.test(value) ? 'warn' : 'neutral';
export const Badge = ({ value, label, title }: { value?: string; label?: string; title?: string }) => <span className={`gitops-badge ${tone(value)}`} title={title}>{label ?? value ?? 'Unknown'}</span>;
export const time = (value?: string) => value ? new Date(value).toLocaleString() : '—';
export function age(value?: string, now = Date.now()) {
  if (!value) return '—'; const s = Math.max(0, Math.round((now - Date.parse(value)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}
export const short = (revision?: string) => !revision ? '—' : revision.replace(/@sha(1|256):([0-9a-f]{7})[0-9a-f]+$/, '@$2').replace(/^([0-9a-f]{8})[0-9a-f]{32}$/, '$1');

export function Stat({ label, value, state, active, onClick, title }: { label: string; value: number | string; state?: string; active?: boolean; onClick?: () => void; title?: string }) {
  const body = <><b className={`gitops-stat-value ${tone(state)}`}>{value}</b><span>{label}</span></>;
  return onClick ? <button className={`gitops-stat ${active ? 'active' : ''}`} aria-pressed={active} title={title} onClick={onClick}>{body}</button> : <div className="gitops-stat" title={title}>{body}</div>;
}
export const Card = ({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) => <section className="gitops-card"><header><h2>{title}</h2>{actions}</header>{children}</section>;

// Loading (skeleton), permission-denied, error and empty states shared by every list.
export function ListState({ source, what, namespace, empty, columns = 5 }: { source: Watch; what: string; namespace: string; empty: boolean; columns?: number }) {
  if (source.error) return <div className="inline-error" role="alert">{source.errorCode === 'FORBIDDEN' ? `Permission denied: your Kubernetes identity cannot list ${what} ${namespace ? `in ${namespace}. ` : 'in all namespaces. Select a namespace you can access. '}` : ''}{source.error}<button onClick={source.refresh}>Retry</button></div>;
  if (source.loading) return <div className="gitops-skeleton" role="status" aria-label={`Loading ${what}`}>{Array.from({ length: 4 }, (_, i) => <div key={i}>{Array.from({ length: columns }, (_, j) => <span key={j}/>)}</div>)}</div>;
  if (empty) return <p className="muted">No {what} {namespace ? `in ${namespace}` : 'found'}.</p>;
  return null;
}
export function SortHeader<K extends string>({ label, column, sort, onSort }: { label: string; column: K; sort: { key: K; desc: boolean }; onSort: (key: K) => void }) {
  const active = sort.key === column;
  return <th aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}><button className="gitops-sort" onClick={() => onSort(column)}>{label}{active && (sort.desc ? <ArrowDown size={11}/> : <ArrowUp size={11}/>)}</button></th>;
}
export const useSort = <K extends string>(initial: K) => { const [sort, setSort] = useState({ key: initial, desc: false }); return [sort, (key: K) => setSort(s => ({ key, desc: s.key === key ? !s.desc : false }))] as const; };

export function NamespacePicker({ clusterId, label, onChange }: { clusterId: string; label: string; onChange?: () => void }) {
  const namespace = useStore(s => s.namespace), setNamespace = useStore(s => s.setNamespace), manual = useStore(s => s.clusterSettings[clusterId]?.accessibleNamespaces) ?? [];
  const namespaces = useResources(manual.length ? '' : clusterId, 'namespaces');
  return <select aria-label={label} value={namespace} onChange={e => { setNamespace(e.target.value); onChange?.(); }}>{!manual.length && <option value="">All namespaces</option>}{[...new Set([...manual, ...namespaces.items.map(n => n.metadata.name!), ...(namespace ? [namespace] : [])])].map(n => <option key={n}>{n}</option>)}</select>;
}
export const RefreshButton = ({ onClick }: { onClick: () => void }) => <button className="applications-secondary" title="Reload data from the cluster" onClick={onClick}><RefreshCw size={15} aria-hidden="true"/>Refresh</button>;

export function Drawer({ eyebrow, title, onClose, tabs, tab, onTab, badges, children }: { eyebrow: string; title: string; onClose: () => void; tabs: string[]; tab: string; onTab: (tab: string) => void; badges?: ReactNode; children: ReactNode }) {
  return <aside className="details gitops-details" aria-label={`${eyebrow} ${title}`}>
    <header><span className="eyebrow">{eyebrow}</span><button title="Close details" onClick={onClose}><X size={18}/></button></header>
    <h2>{title}</h2>{badges && <div className="gitops-badges gitops-drawer-badges">{badges}</div>}
    <div className="detail-tabs" role="tablist" aria-label={`${title} sections`}>{tabs.map(t => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => onTab(t)}>{t}</button>)}</div>
    <div className="detail-content">{children}</div>
  </aside>;
}

export function ContextMenu({ x, y, title, items, onClose }: { x: number; y: number; title: string; items: { label: string; run: () => void; disabled?: boolean }[]; onClose: () => void }) {
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); onClose(); } }; document.addEventListener('keydown', key, true); return () => document.removeEventListener('keydown', key, true); }, [onClose]);
  return <div className="context-menu-backdrop" onMouseDown={onClose} onContextMenu={e => { e.preventDefault(); onClose(); }}><div className="cluster-context-menu" role="menu" aria-label={`${title} actions`} style={{ left: Math.max(8, Math.min(x, window.innerWidth - 265)), top: Math.max(36, Math.min(y, window.innerHeight - 200)) }} onMouseDown={e => e.stopPropagation()}>
    <strong>{title}</strong>{items.map(item => <button key={item.label} role="menuitem" disabled={item.disabled} onClick={() => { onClose(); item.run(); }}>{item.label}</button>)}
  </div></div>;
}

// Kubernetes events recorded for one object, narrowed server-side with a field selector.
export function ObjectEvents({ clusterId, namespace, kind, name }: { clusterId: string; namespace?: string; kind: string; name: string }) {
  const events = useResources(clusterId, 'events', namespace, undefined, `involvedObject.kind=${kind},involvedObject.name=${name}`);
  const rows = [...events.items].sort((a, b) => String(b.lastTimestamp ?? b.eventTime ?? '').localeCompare(String(a.lastTimestamp ?? a.eventTime ?? '')));
  return <><ListState source={events} what="events" namespace={namespace ?? ''} empty={!rows.length} columns={4}/>
    {!events.loading && !events.error && !rows.length && <p className="muted">Kubernetes keeps events for about an hour; older activity is in History.</p>}
    {rows.length > 0 && <div className="gitops-scroll"><table className="gitops-table"><thead><tr><th>Type</th><th>Reason</th><th>Message</th><th>Age</th></tr></thead><tbody>{rows.slice(0, 200).map(e => <tr key={e.metadata.uid}><td><Badge value={e.type === 'Warning' ? 'warning' : undefined} label={e.type ?? 'Normal'}/></td><td>{e.reason}</td><td className="gitops-wrap">{e.message}</td><td title={time(e.lastTimestamp ?? e.eventTime)}>{age(e.lastTimestamp ?? e.eventTime)}</td></tr>)}</tbody></table></div>}</>;
}

// Live object as YAML, with Secret payloads and credential-looking values redacted.
export function ObjectYaml({ clusterId, custom, namespace, name }: { clusterId: string; custom: CustomType; namespace?: string; name: string }) {
  const [state, setState] = useState<{ text?: string; error?: string }>();
  useEffect(() => {
    let active = true; setState(undefined);
    request('resources:get', { clusterId, kind: 'custom', custom, namespace, name }).then(o => { if (active) setState({ text: stringify(redactResource(o)) }); }, e => { if (active) setState({ error: (e as Error).message }); });
    return () => { active = false; };
  }, [clusterId, custom.apiVersion, custom.plural, namespace, name]);
  return state?.error ? <div className="inline-error" role="alert">{state.error}</div> : !state ? <p role="status">Loading YAML…</p> : <pre className="gitops-yaml" aria-label="Resource YAML (read-only)">{state.text}</pre>;
}

// Maps a managed object to Optic's resource browser kind: the API group must match the catalog entry.
export const browserKind = (r: { group?: string; kind: string }) => (Object.keys(catalog) as BuiltinKind[]).find(k => catalog[k].kind === r.kind && (r.group ? catalog[k].apiVersion.startsWith(`${r.group}/`) : !catalog[k].apiVersion.includes('/')));
// Opens an object in the resource browser; a lookup that finishes after the user left the page is discarded.
export function useOpenResource(clusterId: string, onNotice: (text: string) => void) {
  return async (r: { group?: string; kind: string; namespace?: string; name: string }) => {
    const kind = browserKind(r), page = useStore.getState().activePage;
    if (!kind) { onNotice(`${r.kind} is not available in the resource browser.`); return; }
    onNotice(`Opening ${r.kind} ${r.name}…`);
    try {
      const target: Resource = await request('resources:get', { clusterId, kind, namespace: r.namespace, name: r.name });
      if (useStore.getState().activePage !== page) return;
      onNotice(''); const store = useStore.getState(); store.navigate(kind, clusterId); store.setNamespace(r.namespace ?? ''); store.select(target);
    } catch (e) { if (useStore.getState().activePage === page) onNotice((e as Error).message); }
  };
}
export const Notice = ({ text }: { text: string }) => !text ? null : <p className={text.startsWith('Opening ') ? 'muted' : 'inline-error'} role={text.startsWith('Opening ') ? 'status' : 'alert'}>{text}</p>;
export function Conditions({ items }: { items: { type: string; status: string; reason?: string; message?: string; at?: string }[] }) {
  return items.length ? <div className="gitops-scroll"><table className="gitops-table"><thead><tr><th>Type</th><th>Status</th><th>Reason</th><th>Message</th><th>Since</th></tr></thead><tbody>{items.map(c => <tr key={c.type}><td>{c.type}</td><td><Badge value={c.type === 'Ready' || c.type === 'ResourcesUpToDate' ? c.status : c.type === 'ErrorOccurred' && c.status === 'True' ? 'Failed' : undefined} label={c.status}/></td><td>{c.reason ?? '—'}</td><td className="gitops-wrap">{c.message ?? '—'}</td><td title={time(c.at)}>{age(c.at)}</td></tr>)}</tbody></table></div> : <p className="muted">No conditions reported.</p>;
}
