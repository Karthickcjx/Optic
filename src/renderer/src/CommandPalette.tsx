import { useEffect, useMemo, useState } from 'react';
import { Box, FolderOpen, GitBranch, Hexagon, Search, TerminalSquare } from 'lucide-react';
import { catalog, type BuiltinKind, type CustomType } from '../../shared/catalog';
import { fluxTypesAll, gitopsTypes, type GitOpsType } from '../../shared/gitops';
import { request } from './api';
import { useStore } from './store';

// Searchable kinds. Secrets are matched by name only; their payloads never reach the renderer.
const resourceKinds: BuiltinKind[] = ['namespaces', 'pods', 'deployments', 'services', 'configmaps', 'secrets'];
export interface PaletteItem { kind: BuiltinKind | GitOpsType; label: string; name: string; namespace?: string; custom?: CustomType }
type Cached = { at: number; items: PaletteItem[]; failed: string[] };
// Names only, cached briefly per cluster and namespace so typing filters locally instead of re-listing.
const cache = new Map<string, Cached>();
const TTL = 60_000;

export async function loadPaletteItems(clusterId: string, namespace: string): Promise<Cached> {
  const key = `${clusterId}|${namespace}`, hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit;
  const failed: string[] = [], items: PaletteItem[] = [];
  const names = (kind: PaletteItem['kind'], label: string, list: { metadata: { name?: string; namespace?: string } }[], custom?: CustomType) => { for (const r of list) if (r.metadata.name) items.push({ kind, label, name: r.metadata.name, namespace: r.metadata.namespace, custom }); };
  const builtin = resourceKinds.map(async kind => { try { names(kind, catalog[kind].label.replace(/s$/, ''), await request('resources:list', { clusterId, kind, namespace: kind === 'namespaces' ? undefined : namespace || undefined })); } catch { failed.push(catalog[kind].label); } });
  // GitOps objects are few and live in controller namespaces, so they are searched cluster-wide; workloads stay namespace-scoped.
  const gitops = (async () => {
    try {
      const { types } = await request('gitops:detect', { clusterId });
      await Promise.all((['applications', ...fluxTypesAll] as GitOpsType[]).filter(t => types[t]).map(async t => { try { names(t, gitopsTypes[t].kind, await request('resources:list', { clusterId, kind: 'custom', custom: types[t] }), types[t]); } catch { failed.push(gitopsTypes[t].label); } }));
    } catch { /* GitOps detection unavailable: no GitOps results */ }
  })();
  await Promise.all([...builtin, gitops]);
  const value = { at: Date.now(), items, failed: failed.sort() }; cache.set(key, value); return value;
}
// Prefix matches first, then substring matches; at most `limit` results.
export function matchItems(items: PaletteItem[], query: string, limit = 40) {
  const q = query.trim().toLowerCase(); if (q.length < 2) return [];
  const scored = items.map(i => ({ i, n: i.name.toLowerCase() })).filter(x => x.n.includes(q)).sort((a, b) => Number(!a.n.startsWith(q)) - Number(!b.n.startsWith(q)) || a.n.length - b.n.length || a.n.localeCompare(b.n));
  return scored.slice(0, limit).map(x => x.i);
}

export function CommandPalette({ onClose, onTerminal, onImport }: { onClose: () => void; onTerminal: () => void; onImport: () => void }) {
  const clusterId = useStore(s => s.clusterId), namespace = useStore(s => s.namespace), clusters = useStore(s => s.clusters), navigate = useStore(s => s.navigate);
  const cluster = clusters.find(c => c.id === clusterId);
  const [query, setQuery] = useState(''), [data, setData] = useState<Cached>(), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const wantsResources = query.trim().length >= 2 && !!cluster && cluster.connected !== false;
  useEffect(() => {
    if (!wantsResources || data) return; let active = true; setLoading(true);
    loadPaletteItems(clusterId, namespace).then(v => { if (active) setData(v); }, e => { if (active) setError((e as Error).message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [wantsResources, clusterId, namespace]);
  const views = useMemo(() => ([['security', 'Security Overview'], ['security-images', 'Security Images'], ['security-resources', 'Security Resources'], ['security-roles', 'Security Roles'], ['cost', 'Cost dashboard'], ['applications', 'Applications'], ['gitops-argo', 'Argo CD'], ['gitops-flux', 'Flux'], ['overview', 'Cluster overview'], ['helm-charts', 'Helm Charts'], ['helm-releases', 'Helm Releases'], ...Object.entries(catalog).map(([key, item]) => [key, item.label])] as [string, string][]).filter(([, label]) => label.toLowerCase().includes(query.toLowerCase())), [query]);
  const clusterMatches = query.trim().length >= 2 ? clusters.filter(c => c.name.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 10) : [];
  const results = data ? matchItems(data.items, query) : [];
  const close = () => { setQuery(''); onClose(); };
  const open = async (item: PaletteItem) => {
    close();
    const store = useStore.getState();
    if (item.kind in gitopsTypes) { store.navigate(item.kind === 'applications' ? 'gitops-argo' : 'gitops-flux', clusterId); store.setNamespace(item.namespace ?? ''); store.setGitOpsFocus({ type: item.kind as GitOpsType, name: item.name, namespace: item.namespace }); return; }
    try { const target = await request('resources:get', { clusterId, kind: item.kind as BuiltinKind, namespace: item.namespace, name: item.name }); store.navigate(item.kind as BuiltinKind, clusterId); if (item.kind !== 'namespaces') store.setNamespace(item.namespace ?? ''); store.select(target); }
    catch (e) { store.notify((e as Error).message); }
  };
  const first = () => { if (results[0]) void open(results[0]); else if (views[0] && cluster) { navigate(views[0][0] as any); close(); } };
  return <div className="modal-backdrop" onClick={close}><section className="command-palette" role="dialog" aria-label="Command palette" onClick={e => e.stopPropagation()}>
    <input autoFocus aria-label="Command search" placeholder="Search resources and commands…" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') first(); }}/>
    <div>
      {clusterMatches.map(c => <button key={c.id} onClick={() => { useStore.getState().selectCluster(c.id); close(); }}><Hexagon size={15}/>{c.name}<small>Cluster</small></button>)}
      {wantsResources && loading && !data && <p className="muted palette-note" role="status"><Search size={13}/> Searching {cluster?.name}{namespace ? ` / ${namespace}` : ''}…</p>}
      {results.map(item => <button key={`${item.kind}/${item.namespace}/${item.name}`} onClick={() => void open(item)}>{item.kind in gitopsTypes ? <GitBranch size={15}/> : <Box size={15}/>}{item.name}<small>{item.label}{item.namespace ? ` · ${item.namespace}` : ''}</small></button>)}
      {data && !!data.failed.length && query.trim().length >= 2 && <p className="muted palette-note">Not searched (no permission or unavailable): {data.failed.join(', ')}</p>}
      {error && <p className="inline-error palette-note">{error}</p>}
      {views.map(([key, label]) => <button key={key} disabled={!cluster} onClick={() => { navigate(key as any); close(); }}><Box size={15}/>{label}<small>{cluster?.name}</small></button>)}
      <button disabled={!cluster} onClick={() => { window.dispatchEvent(new Event('optic-import-deploy')); close(); }}>Import and deploy</button>
      <button onClick={() => { onTerminal(); close(); }}><TerminalSquare size={15}/>Open local terminal</button>
      <button onClick={() => { onImport(); close(); }}><FolderOpen size={15}/>Import kubeconfig</button>
    </div>
  </section></div>;
}
