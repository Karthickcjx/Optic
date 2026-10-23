import { useState } from 'react';
import { Activity, Box, ChevronDown, ChevronRight, Database, FileCode2, Folder, Hexagon, LayoutDashboard, Network, Search, Server, Shield, Plus, RefreshCw, MoreHorizontal } from 'lucide-react';
import { catalog, type BuiltinKind } from '../../shared/catalog';
import { ClusterMenu } from './ClusterMenu';
import type { Cluster } from '../../shared/protocol';
import { useStore } from './store';
const groupIcons = { Workloads: Box, Config: FileCode2, Network, Storage: Database, 'Access Control': Shield };
export function Navigator({ onImport, onReload }: { onImport: () => void; onReload: () => void }) {
  const [menu, setMenu] = useState<{ cluster: Cluster; x: number; y: number }>();
  const state = useStore(); const [filter, setFilter] = useState(''); const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (key: string) => setCollapsed(s => ({ ...s, [key]: !s[key] }));
  const leaf = (kind: BuiltinKind | 'overview', clusterId: string, Icon = Box) => {
    const label = kind === 'overview' ? 'Overview' : catalog[kind].label;
    if (filter && !label.toLowerCase().includes(filter.toLowerCase())) return null;
    return <button key={kind} className={`tree-leaf ${state.clusterId === clusterId && state.view === kind ? 'active' : ''}`} onClick={() => state.navigate(kind, clusterId)}><Icon size={14}/><span>{label}</span></button>;
  };
  return <aside className="navigator"><header>Navigator<div><button title="Reload kubeconfig" onClick={onReload}><RefreshCw size={13}/></button><button title="Add kubeconfig" onClick={onImport}><Plus size={15}/></button></div></header><div className="navigator-search"><Search size={13}/><input placeholder="Find in Navigator" aria-label="Find in Navigator" value={filter} onChange={e => setFilter(e.target.value)}/></div><nav><div className="tree-heading"><ChevronDown size={12}/>KUBERNETES CLUSTERS</div><div className="tree-source"><ChevronDown size={13}/><Folder size={14}/>Local Kubeconfigs</div>{state.clusters.map(cluster => <section className="cluster-tree" key={cluster.id}><div onContextMenu={e => { e.preventDefault(); setMenu({ cluster, x: e.clientX, y: e.clientY }); }} className={`cluster-tree-header ${state.clusterId === cluster.id ? 'selected' : ''}`}><button aria-label={`Expand ${cluster.name}`} onClick={() => toggle(cluster.id)}>{collapsed[cluster.id] ? <ChevronRight size={13}/> : <ChevronDown size={13}/>}</button><button title={cluster.server} onClick={() => { state.selectCluster(cluster.id); setCollapsed(s => ({ ...s, [cluster.id]: false })); }}><Hexagon size={16} style={{ color: state.preferences[cluster.id]?.color }}/><span>{state.preferences[cluster.id]?.label || cluster.name}</span></button><button title={`Cluster actions: ${cluster.name}`} onClick={e => { const rect = e.currentTarget.getBoundingClientRect(); setMenu({ cluster, x: rect.right, y: rect.top }); }}><MoreHorizontal size={14}/></button></div>{(!collapsed[cluster.id] || filter) && <div className="cluster-tree-children">{leaf('overview', cluster.id, LayoutDashboard)}{leaf('nodes', cluster.id, Server)}{Object.entries(groupIcons).map(([group, Icon]) => {
      const key = `${cluster.id}:${group}`, open = !(collapsed[key] ?? group !== 'Workloads') || !!filter;
      const entries = (Object.entries(catalog) as [BuiltinKind, typeof catalog[BuiltinKind]][]).filter(([, entry]) => entry.group === group);
      if (filter && !entries.some(([, entry]) => entry.label.toLowerCase().includes(filter.toLowerCase()))) return null;
      return <div key={group}><button className="tree-group" aria-expanded={open} onClick={() => setCollapsed(s => ({ ...s, [key]: open }))}>{open ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}<Icon size={14}/>{group}</button>{open && <div className="tree-group-children">{entries.map(([kind]) => leaf(kind, cluster.id))}</div>}</div>;
    })}{leaf('namespaces', cluster.id, Folder)}{leaf('events', cluster.id, Activity)}{leaf('customresourcedefinitions', cluster.id, Hexagon)}</div>}</section>)}{!state.clusters.length && <p className="navigator-empty">No contexts found.<br/><button onClick={onImport}>Add a kubeconfig</button></p>}</nav><footer><span>Cluster Workbench</span><small>Local workspace · v0.2</small></footer>{menu && <ClusterMenu {...menu} onClose={() => setMenu(undefined)} onReload={onReload}/>}</aside>;
}
