import { EksDialog } from './EksDialog';
import { ExternalToolsPage } from './ExternalToolsPage';
import { ExtensionsPage } from './ExtensionsPage';
import { SecurityDashboard } from './SecurityDashboard';
import { CostDashboard } from './CostDashboard';
import { Applications } from './Applications';
import { KubeconfigSourceDialog } from './KubeconfigSourceDialog';
import { ResizableNavigator } from './ResizableNavigator';
import { TerminalLauncher, startLocalTerminal } from './TerminalLauncher';
import { ImportDeployHost } from './ImportDeployDialog';
import { HelmPage } from './HelmPage';
import { HelmNotifications } from './HelmNotifications';
import { KubeconfigImport } from './KubeconfigImport';
import { ClusterSettingsPage } from './ClusterSettingsPage';
import { useEffect, useState } from 'react';
import appLogo from '../../../resources/logo.png';
import { Puzzle, ArrowLeft, ArrowRight, Box, ChevronDown, FileCode2, FolderOpen, Hexagon, Home, LayoutDashboard, Menu, Plus, RefreshCw, Search, Settings, TerminalSquare, X } from 'lucide-react';
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

function Welcome({ onImport, onClipboard }: { onImport: () => void; onClipboard: () => void }) {
  const { clusters, navigate, selectCluster, openTab } = useStore();
  return <div className="welcome-page"><div className="welcome-brand"><img className="welcome-logo" src={appLogo} alt="Application logo"/><h1>Optic</h1></div><h2>Your Kubernetes workspace</h2><div className="welcome-columns"><section><h3>Start</h3><button onClick={onClipboard}><FileCode2 size={17}/>Add kubeconfig from clipboard…</button><button onClick={onImport}><FolderOpen size={17}/>Add kubeconfig from filesystem…</button><button onClick={() => navigate('settings')}><Settings size={17}/>Manage cluster connections…</button><button onClick={() => openTab({ type: 'terminal', title: 'Terminal', options: { cols: 100, rows: 24 } })}><TerminalSquare size={17}/>Open a local terminal…</button>{!!clusters.length && <button onClick={() => selectCluster(clusters[0].id)}><LayoutDashboard size={17}/>Open cluster overview…</button>}</section><section><h3>Recent contexts</h3>{clusters.length ? clusters.slice(0, 6).map(c => <button key={c.id} onClick={() => selectCluster(c.id)}><Hexagon size={15}/>{c.name}</button>) : <p>Import your kubeconfig to connect.<br/>Files in <code>~/.kube/config</code> and <code>KUBECONFIG</code> are discovered automatically.</p>}</section></div><div className="welcome-note"><ShieldNote/> Credentials are kept on your computer. Resource changes always use the selected context.</div></div>;
}
function ShieldNote() { return <span className="small-dot"/>; }
function Preferences({ onImport, onClipboard }: { onImport: () => void; onClipboard: () => void }) {
  const [section, setSection] = useState('connections');
  const clusters = useStore(s => s.clusters); const navigate = useStore(s => s.navigate);
  return <div className="global-preferences"><nav aria-label="Preferences sections"><h3>Preferences</h3><button className={section === 'connections' ? 'active' : ''} onClick={() => setSection('connections')}>Connections</button><button className={section === 'tools' ? 'active' : ''} onClick={() => setSection('tools')}>External Tools</button><button onClick={() => navigate('extensions')}>Extensions</button></nav>{section === 'tools' ? <ExternalToolsPage/> : <div className="preferences-page"><h1>Preferences</h1><h2>Cluster connections</h2><p>Add multiple kubeconfig files with Ctrl/Shift selection in the file picker, or paste each config separately. Every context appears in the Navigator and stays available across restarts. Files and their current contexts are not merged or modified.</p><button className="primary" onClick={onImport}><Plus size={15}/>Add kubeconfig from filesystem</button><button onClick={onClipboard}><FileCode2 size={15}/>Add kubeconfig from clipboard</button><div className="connection-list">{clusters.map(c => <section key={c.id}><Hexagon size={24}/><div><strong>{c.name}</strong><span>{c.server}</span><code>{c.source}</code></div><button onClick={() => navigate('overview', c.id)}>Open</button></section>)}</div><h2>Terminal</h2><p>Local terminals use your system shell. Pod terminals run <code>kubectl exec</code> using the exact selected kubeconfig and context. Install kubectl on PATH to enable pod shells.</p><h2>Access and privacy</h2><p>All Kubernetes operations respect the selected credentials and RBAC permissions. Secret values are redacted in resource tables. Import only trusted kubeconfigs: authentication plugins can execute local commands.</p></div>}</div>;
}
function ResourcePage({ onCreate }: { onCreate: () => void }) {
  const store = useStore(); const manual = store.clusterSettings[store.clusterId]?.accessibleNamespaces ?? [];
  const namespace = store.namespace || manual[0] || '';
  const data = useResources(store.clusterId, store.kind, namespace, store.custom);
  const namespaces = useResources(manual.length ? '' : store.clusterId, 'namespaces');
  const namespaceNames = [...new Set([...manual, ...namespaces.items.map(n => n.metadata.name!)])];
  const selected = store.selected && (data.items.find(r => r.metadata.uid === store.selected?.metadata.uid) ?? (data.loading ? store.selected : undefined));
  const label = store.kind === 'custom' ? store.custom?.kind ?? 'Resources' : catalog[store.kind].label;
  return <div className="resource-area"><section className="resource-panel">{data.error && <div className="inline-error">{data.error}<button onClick={data.refresh}>Retry</button></div>}<ResourceTable key={store.activePage} items={data.items} loading={data.loading} onSelect={store.select} selectedId={store.selected?.metadata.uid} kind={store.kind} label={label} controls={<><select aria-label="Namespace" value={namespace} onChange={e => store.setNamespace(e.target.value)}>{!manual.length && <option value="">All namespaces</option>}{namespaceNames.map(name => <option key={name} value={name}>{name}</option>)}</select>{namespaces.error && <span title={namespaces.error} className="warning-text">!</span>}</>} actions={<><button title="Refresh resources" onClick={data.refresh}><RefreshCw size={15} className={data.loading ? 'spin' : ''}/></button><button title="Create resource" onClick={onCreate}><Plus size={17}/></button></>}/></section>{selected && <Details key={`${store.activePage}:${selected.metadata.uid}`} resource={selected}/>}</div>;
}
export function App() {
  const store = useStore(); const [warnings, setWarnings] = useState<string[]>([]); const [health, setHealth] = useState('');
  const [navigatorVisible, setNavigatorVisible] = useState(true); const [manifest, setManifest] = useState(false); const [palette, setPalette] = useState(false); const [query, setQuery] = useState('');
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [eksProfile, setEksProfile] = useState('');
  const [eksOpen, setEksOpen] = useState(false);
  const [importChoice, setImportChoice] = useState(false), [pasteConfig, setPasteConfig] = useState(false);
  const reload = async (importFile = false) => { try { const result = await request(importFile ? 'clusters:import' : 'clusters:list', undefined); store.setClusters(result.clusters); setWarnings(result.warnings); await Promise.all(result.clusters.map(async cluster => { const settings = await request('settings:get', { clusterId: cluster.id }); store.setClusterSettings(cluster.id, settings); })); setConnectionRevision(v => v + 1); } catch (e) { store.notify((e as Error).message); } };
  useEffect(() => { void reload(); }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(v => !v); } if (e.key === 'Escape') { setPalette(false); setManifest(false); store.select(undefined); } };
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    let active = true, running = false; setHealth('Connecting…'); if (store.clusters.find(c => c.id === store.clusterId)?.connected === false) { setHealth('Disconnected'); return; } if (!store.clusterId) { setHealth('No cluster selected'); return; }
    const check = async () => { if (running) return; running = true; try { const result = await request('clusters:health', { clusterId: store.clusterId }); if (active) setHealth(result.version); } catch { if (active) setHealth('Connection unavailable'); } finally { running = false; } };
    void check(); const interval = setInterval(check, 30000); return () => { active = false; clearInterval(interval); };
  }, [store.clusterId, connectionRevision, store.revision]);
  const cluster = store.clusters.find(c => c.id === store.clusterId); const index = store.pages.findIndex(p => p.id === store.activePage);
  const openTerminal = () => startLocalTerminal(cluster?.connected === false ? undefined : cluster?.id);
  return <div className="ide-shell"><div className="ide-titlebar"><button title="Toggle Navigator" onClick={() => setNavigatorVisible(v => !v)}><Menu size={15}/></button><button title="Previous tab" disabled={index <= 0} onClick={() => store.activatePage(store.pages[index - 1].id)}><ArrowLeft size={15}/></button><button title="Next tab" disabled={index >= store.pages.length - 1} onClick={() => store.activatePage(store.pages[index + 1].id)}><ArrowRight size={15}/></button><span className="app-caption"><img className="titlebar-logo" src={appLogo} alt=""/>Optic</span><button className="command-trigger" onClick={() => setPalette(true)}><Search size={13}/>Search resources and commands <kbd>Ctrl K</kbd></button></div>
    <div className="ide-body"><aside className="activity-rail"><button title="Welcome" className={store.view === 'welcome' ? 'active' : ''} onClick={() => store.navigate('welcome')}><Home size={21}/></button><button title="Cluster overview" disabled={!cluster} onClick={() => store.navigate('overview')}><Hexagon size={23}/></button>{store.clusters.filter(c => store.preferences[c.id]?.pinned).map((c, i) => <button className={c.id === store.clusterId && !['welcome','settings'].includes(store.view) ? 'active context-icon' : 'context-icon'} key={c.id} style={{ backgroundColor: store.preferences[c.id]?.color }} title={store.preferences[c.id]?.label || c.name} onClick={() => store.selectCluster(c.id)}>{(store.preferences[c.id]?.label || c.name).slice(0, 2).toUpperCase()}<small>{i + 1}</small></button>)}<button title="Add cluster" onClick={() => setImportChoice(true)}><Plus size={21}/></button><button title="Extensions" className={store.view === 'extensions' ? 'active' : ''} onClick={() => store.navigate('extensions')}><Puzzle size={21}/></button><div className="rail-spacer"/><button title="Local terminal" onClick={openTerminal}><TerminalSquare size={21}/></button><button title="Preferences" onClick={() => store.navigate('settings')}><Settings size={21}/></button></aside>
    {navigatorVisible && <ResizableNavigator><Navigator onEks={profile => { setEksProfile(profile); setEksOpen(true); }} onImport={() => setImportChoice(true)} onReload={() => void reload()}/></ResizableNavigator>}
    <main className="workspace"><div className="workspace-tabs" role="tablist">{store.pages.map(page => <div key={page.id} className={`workspace-tab ${page.id === store.activePage ? 'active' : ''}`}><button role="tab" aria-selected={page.id === store.activePage} onClick={() => store.activatePage(page.id)}>{page.view === 'welcome' ? <Home size={14}/> : <Hexagon size={14}/>}<span>{pageTitle(page, store.clusters)}</span></button><button title={`Close ${pageTitle(page, store.clusters)}`} onClick={() => store.closePage(page.id)}><X size={13}/></button></div>)}</div>
    {!!warnings.length && <div className="warning">{warnings.join(' · ')}<button title="Dismiss warnings" onClick={() => setWarnings([])}><X size={13}/></button></div>}{store.error && <div className="error-banner">{store.error}<button onClick={() => store.notify(undefined)}><X size={15}/></button></div>}
    <div className="page-body" key={`${store.activePage}:${connectionRevision}:${store.view === 'cluster-settings' ? 0 : store.revision}`}>{store.view === 'extensions' ? <ExtensionsPage/> : store.view === 'welcome' ? <Welcome onImport={() => void reload(true)} onClipboard={() => setPasteConfig(true)}/> : store.view === 'settings' ? <Preferences onImport={() => void reload(true)} onClipboard={() => setPasteConfig(true)}/> : !cluster ? <div className="empty"><h2>Context unavailable</h2><p>Import or choose a kubeconfig to continue.</p></div> : store.view === 'cluster-settings' ? <ClusterSettingsPage/> : cluster.connected === false ? <div className="empty"><h2>Cluster disconnected</h2><p>Watches and sessions are stopped for this context.</p><button className="primary" onClick={() => void request('clusters:connect', { clusterId: cluster.id }).then(() => store.setConnected(cluster.id, true)).catch(e => store.notify(e.message))}>Connect cluster</button><button onClick={() => store.navigate('cluster-settings')}>Cluster settings</button></div> : store.view === 'helm-charts' ? <HelmPage mode="charts"/> : store.view === 'helm-releases' ? <HelmPage mode="releases"/> : store.view === 'security-images' ? <SecurityDashboard page="images"/> : store.view === 'security-resources' ? <SecurityDashboard page="resources"/> : store.view === 'security-roles' ? <SecurityDashboard page="roles"/> : store.view === 'security' ? <SecurityDashboard/> : store.view === 'cost' ? <CostDashboard/> : store.view === 'applications' ? <Applications/> : store.view === 'overview' ? <Overview/> : <ResourcePage onCreate={() => setManifest(true)}/>}</div>
    <Dock/><div className="dock-launcher"><TerminalLauncher clusterId={cluster?.connected === false ? undefined : cluster?.id}/><button title="Create resource from YAML" disabled={!cluster} onClick={() => setManifest(true)}><Plus size={16}/></button><span/><button title="Collapse or expand dock" onClick={store.toggleDock}><ChevronDown size={15}/></button></div></main></div>
    <footer className="statusbar"><span><Hexagon size={13}/>{cluster ? `${cluster.name} (${health})` : 'No cluster selected'}</span><span>{store.namespace || 'All namespaces'}<span className="status-divider"/>Local workspace</span></footer>
    <HelmNotifications/>
    <ImportDeployHost/>
    {manifest && <ManifestDialog onClose={() => setManifest(false)}/>}
    {pasteConfig && <KubeconfigImport onClose={() => setPasteConfig(false)} onImported={() => reload()}/>}
    {eksOpen && <EksDialog initialProfile={eksProfile} onClose={() => setEksOpen(false)} onAdded={() => void reload()}/>}
    {importChoice && <KubeconfigSourceDialog onEks={() => { setImportChoice(false); setEksProfile(''); setEksOpen(true); }} onClose={() => setImportChoice(false)} onFiles={() => { setImportChoice(false); void reload(true); }} onPaste={() => { setImportChoice(false); setPasteConfig(true); }}/>}
    {palette && <div className="modal-backdrop" onClick={() => setPalette(false)}><section className="command-palette" onClick={e => e.stopPropagation()}><input autoFocus aria-label="Command search" placeholder="Search resources and commands…" value={query} onChange={e => setQuery(e.target.value)}/><div>{[['security', 'Security Overview'], ['security-images', 'Security Images'], ['security-resources', 'Security Resources'], ['security-roles', 'Security Roles'], ['cost', 'Cost dashboard'], ['applications', 'Applications'], ['overview','Cluster overview'], ['helm-charts','Helm Charts'], ['helm-releases','Helm Releases'], ...Object.entries(catalog).map(([key, item]) => [key, item.label])].filter(([, label]) => label.toLowerCase().includes(query.toLowerCase())).map(([key, label]) => <button key={key} disabled={!cluster} onClick={() => { store.navigate(key as any); setPalette(false); setQuery(''); }}><Box size={15}/>{label}<small>{cluster?.name}</small></button>)}<button disabled={!cluster} onClick={() => { window.dispatchEvent(new Event('optic-import-deploy')); setPalette(false); }}>Import and deploy</button><button onClick={() => { openTerminal(); setPalette(false); }}><TerminalSquare size={15}/>Open local terminal</button><button onClick={() => { setImportChoice(true); setPalette(false); }}><FolderOpen size={15}/>Import kubeconfig</button></div></section></div>}
  </div>;
}
