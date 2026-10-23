import { useEffect, useState } from 'react';
import appLogo from '../../../resources/logo.png';
import { ArrowLeft, ArrowRight, Box, ChevronDown, FileCode2, FolderOpen, Hexagon, Home, LayoutDashboard, Menu, Plus, RefreshCw, Search, Settings, TerminalSquare, X } from 'lucide-react';
import { catalog } from '../../shared/catalog';
import { request } from './api';
import { pageTitle, useStore } from './store';
import { useResources } from './hooks';
import { ResourceTable } from './Table';
import { Details } from './Details';
import { Dock } from './Dock';
import { Navigator } from './Navigator';
import { Overview } from './Overview';
import { ManifestDialog } from './ManifestDialog';

function Welcome({ onImport }: { onImport: () => void }) {
  const { clusters, navigate, selectCluster, openTab } = useStore();
  return <div className="welcome-page"><div className="welcome-brand"><img className="welcome-logo" src={appLogo} alt="Application logo"/><h1>Optic</h1></div><h2>Your Kubernetes workspace</h2><div className="welcome-columns"><section><h3>Start</h3><button onClick={onImport}><FolderOpen size={17}/>Add kubeconfig from filesystem…</button><button onClick={() => navigate('settings')}><Settings size={17}/>Manage cluster connections…</button><button onClick={() => openTab({ type: 'terminal', title: 'Terminal', options: { cols: 100, rows: 24 } })}><TerminalSquare size={17}/>Open a local terminal…</button>{!!clusters.length && <button onClick={() => selectCluster(clusters[0].id)}><LayoutDashboard size={17}/>Open cluster overview…</button>}</section><section><h3>Recent contexts</h3>{clusters.length ? clusters.slice(0, 6).map(c => <button key={c.id} onClick={() => selectCluster(c.id)}><Hexagon size={15}/>{c.name}</button>) : <p>Import your kubeconfig to connect.<br/>Files in <code>~/.kube/config</code> and <code>KUBECONFIG</code> are discovered automatically.</p>}</section></div><div className="welcome-note"><ShieldNote/> Credentials are kept on your computer. Resource changes always use the selected context.</div></div>;
}
function ShieldNote() { return <span className="small-dot"/>; }
function Preferences({ onImport }: { onImport: () => void }) {
  const clusters = useStore(s => s.clusters); const navigate = useStore(s => s.navigate);
  return <div className="preferences-page"><h1>Preferences</h1><h2>Cluster connections</h2><p>Contexts are discovered from local kubeconfig files. Importing adds a file reference without changing its current context or contents.</p><button className="primary" onClick={onImport}><Plus size={15}/>Add kubeconfig</button><div className="connection-list">{clusters.map(c => <section key={c.id}><Hexagon size={24}/><div><strong>{c.name}</strong><span>{c.server}</span><code>{c.source}</code></div><button onClick={() => navigate('overview', c.id)}>Open</button></section>)}</div><h2>Terminal</h2><p>Local terminals use your system shell. Pod terminals run <code>kubectl exec</code> using the exact selected kubeconfig and context. Install kubectl on PATH to enable pod shells.</p><h2>Access and privacy</h2><p>All Kubernetes operations respect the selected credentials and RBAC permissions. Secret values are redacted in resource tables. Import only trusted kubeconfigs: authentication plugins can execute local commands.</p></div>;
}
function ResourcePage({ onCreate }: { onCreate: () => void }) {
  const store = useStore(); const data = useResources(store.clusterId, store.kind, store.namespace, store.custom);
  const namespaces = useResources(store.clusterId, 'namespaces');
  const selected = store.selected && data.items.find(r => r.metadata.uid === store.selected?.metadata.uid);
  const label = store.kind === 'custom' ? store.custom?.kind ?? 'Resources' : catalog[store.kind].label;
  return <div className="resource-area"><section className="resource-panel">{data.error && <div className="inline-error">{data.error}<button onClick={data.refresh}>Retry</button></div>}<ResourceTable key={store.activePage} items={data.items} loading={data.loading} onSelect={store.select} selectedId={store.selected?.metadata.uid} kind={store.kind} label={label} controls={<><select aria-label="Namespace" value={store.namespace} onChange={e => store.setNamespace(e.target.value)}><option value="">All namespaces</option>{namespaces.items.map(n => <option key={n.metadata.name} value={n.metadata.name}>{n.metadata.name}</option>)}</select>{namespaces.error && <span title={namespaces.error} className="warning-text">!</span>}</>} actions={<><button title="Refresh resources" onClick={data.refresh}><RefreshCw size={15} className={data.loading ? 'spin' : ''}/></button><button title="Create resource" onClick={onCreate}><Plus size={17}/></button></>}/></section>{selected && <Details key={`${store.activePage}:${selected.metadata.uid}`} resource={selected}/>}</div>;
}
export function App() {
  const store = useStore(); const [warnings, setWarnings] = useState<string[]>([]); const [health, setHealth] = useState('');
  const [navigatorVisible, setNavigatorVisible] = useState(true); const [manifest, setManifest] = useState(false); const [palette, setPalette] = useState(false); const [query, setQuery] = useState('');
  const [connectionRevision, setConnectionRevision] = useState(0);
  const reload = async (importFile = false) => { try { const result = await request(importFile ? 'clusters:import' : 'clusters:list', undefined); store.setClusters(result.clusters); setWarnings(result.warnings); setConnectionRevision(v => v + 1); } catch (e) { store.notify((e as Error).message); } };
  useEffect(() => { void reload(); }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(v => !v); } if (e.key === 'Escape') { setPalette(false); setManifest(false); store.select(undefined); } };
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    let active = true, running = false; setHealth('Connecting…'); if (!store.clusterId) { setHealth('No cluster selected'); return; }
    const check = async () => { if (running) return; running = true; try { const result = await request('clusters:health', { clusterId: store.clusterId }); if (active) setHealth(result.version); } catch { if (active) setHealth('Connection unavailable'); } finally { running = false; } };
    void check(); const interval = setInterval(check, 30000); return () => { active = false; clearInterval(interval); };
  }, [store.clusterId, connectionRevision]);
  const cluster = store.clusters.find(c => c.id === store.clusterId); const index = store.pages.findIndex(p => p.id === store.activePage);
  const openTerminal = () => store.openTab({ type: 'terminal', title: 'Terminal', options: { cols: 100, rows: 24 } });
  return <div className="ide-shell"><div className="ide-titlebar"><button title="Toggle Navigator" onClick={() => setNavigatorVisible(v => !v)}><Menu size={15}/></button><button title="Previous tab" disabled={index <= 0} onClick={() => store.activatePage(store.pages[index - 1].id)}><ArrowLeft size={15}/></button><button title="Next tab" disabled={index >= store.pages.length - 1} onClick={() => store.activatePage(store.pages[index + 1].id)}><ArrowRight size={15}/></button><span className="app-caption"><img className="titlebar-logo" src={appLogo} alt=""/>Optic</span><button className="command-trigger" onClick={() => setPalette(true)}><Search size={13}/>Search resources and commands <kbd>Ctrl K</kbd></button></div>
    <div className="ide-body"><aside className="activity-rail"><button title="Welcome" className={store.view === 'welcome' ? 'active' : ''} onClick={() => store.navigate('welcome')}><Home size={21}/></button><button title="Cluster overview" disabled={!cluster} onClick={() => store.navigate('overview')}><Hexagon size={23}/></button>{store.clusters.filter(c => store.preferences[c.id]?.pinned).map((c, i) => <button className={c.id === store.clusterId && !['welcome','settings'].includes(store.view) ? 'active context-icon' : 'context-icon'} key={c.id} style={{ backgroundColor: store.preferences[c.id]?.color }} title={store.preferences[c.id]?.label || c.name} onClick={() => store.selectCluster(c.id)}>{(store.preferences[c.id]?.label || c.name).slice(0, 2).toUpperCase()}<small>{i + 1}</small></button>)}<button title="Add cluster" onClick={() => void reload(true)}><Plus size={21}/></button><div className="rail-spacer"/><button title="Local terminal" onClick={openTerminal}><TerminalSquare size={21}/></button><button title="Preferences" onClick={() => store.navigate('settings')}><Settings size={21}/></button></aside>
    {navigatorVisible && <Navigator onImport={() => void reload(true)} onReload={() => void reload()}/>}
    <main className="workspace"><div className="workspace-tabs" role="tablist">{store.pages.map(page => <div key={page.id} className={`workspace-tab ${page.id === store.activePage ? 'active' : ''}`}><button role="tab" aria-selected={page.id === store.activePage} onClick={() => store.activatePage(page.id)}>{page.view === 'welcome' ? <Home size={14}/> : <Hexagon size={14}/>}<span>{pageTitle(page, store.clusters)}</span></button><button title={`Close ${pageTitle(page, store.clusters)}`} onClick={() => store.closePage(page.id)}><X size={13}/></button></div>)}</div>
    {!!warnings.length && <div className="warning">{warnings.join(' · ')}<button title="Dismiss warnings" onClick={() => setWarnings([])}><X size={13}/></button></div>}{store.error && <div className="error-banner">{store.error}<button onClick={() => store.notify(undefined)}><X size={15}/></button></div>}
    <div className="page-body" key={`${store.activePage}:${connectionRevision}`}>{store.view === 'welcome' ? <Welcome onImport={() => void reload(true)}/> : store.view === 'settings' ? <Preferences onImport={() => void reload(true)}/> : !cluster ? <div className="empty"><h2>Context unavailable</h2><p>Import or choose a kubeconfig to continue.</p></div> : store.view === 'overview' ? <Overview/> : <ResourcePage onCreate={() => setManifest(true)}/>}</div>
    <Dock/><div className="dock-launcher"><button onClick={openTerminal}><TerminalSquare size={13}/>Terminal</button><button title="Create resource from YAML" disabled={!cluster} onClick={() => setManifest(true)}><Plus size={16}/></button><span/><button title="Collapse or expand dock" onClick={store.toggleDock}><ChevronDown size={15}/></button></div></main></div>
    <footer className="statusbar"><span><Hexagon size={13}/>{cluster ? `${cluster.name} (${health})` : 'No cluster selected'}</span><span>{store.namespace || 'All namespaces'}<span className="status-divider"/>Local workspace</span></footer>
    {manifest && <ManifestDialog onClose={() => setManifest(false)}/>}
    {palette && <div className="modal-backdrop" onClick={() => setPalette(false)}><section className="command-palette" onClick={e => e.stopPropagation()}><input autoFocus aria-label="Command search" placeholder="Search resources and commands…" value={query} onChange={e => setQuery(e.target.value)}/><div>{[['overview','Cluster overview'], ...Object.entries(catalog).map(([key, item]) => [key, item.label])].filter(([, label]) => label.toLowerCase().includes(query.toLowerCase())).map(([key, label]) => <button key={key} disabled={!cluster} onClick={() => { store.navigate(key as any); setPalette(false); setQuery(''); }}><Box size={15}/>{label}<small>{cluster?.name}</small></button>)}<button onClick={() => { openTerminal(); setPalette(false); }}><TerminalSquare size={15}/>Open local terminal</button><button onClick={() => { void reload(true); setPalette(false); }}><FolderOpen size={15}/>Import kubeconfig</button></div></section></div>}
  </div>;
}
