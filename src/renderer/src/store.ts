import { create } from 'zustand';
import { catalog, type CustomType, type View } from '../../shared/catalog';
import type { Cluster, PodTarget, Resource, ResourceKind, Requests, TerminalOptions } from '../../shared/protocol';
export interface DockTab { id: string; type: 'terminal' | 'logs' | 'forward'; title: string; options: TerminalOptions | PodTarget | Omit<Requests['forward:start']['input'], 'id'> }
export interface WorkspaceTab { id: string; view: View; clusterId: string; namespace: string; custom?: CustomType }
interface State {
  preferences: Record<string, { pinned?: boolean; label?: string; color?: string }>;
  setPreference: (id: string, value: { pinned?: boolean; label?: string; color?: string }) => void;
  clusters: Cluster[]; clusterId: string; namespace: string; kind: ResourceKind; view: View; custom?: CustomType; selected?: Resource;
  pages: WorkspaceTab[]; activePage: string; tabs: DockTab[]; activeTab?: string; error?: string; dockCollapsed: boolean;
  setClusters: (clusters: Cluster[]) => void; selectCluster: (id: string) => void;
  setNamespace: (namespace: string) => void; setKind: (kind: ResourceKind) => void;
  navigate: (view: View, clusterId?: string, custom?: CustomType) => void; activatePage: (id: string) => void; closePage: (id: string) => void;
  select: (resource?: Resource) => void; notify: (message?: string) => void;
  openTab: (tab: Omit<DockTab, 'id'>) => void; closeTab: (id: string) => void; activateTab: (id: string) => void; toggleDock: () => void;
}
const welcome: WorkspaceTab = { id: 'welcome', view: 'welcome', clusterId: '', namespace: '' };
export function pageTitle(page: WorkspaceTab, clusters: Cluster[]) {
  if (page.view === 'welcome') return 'Welcome';
  if (page.view === 'settings') return 'Preferences';
  const title = page.view === 'overview' ? 'Cluster Overview' : page.view === 'custom' ? page.custom?.kind ?? 'Custom Resources' : catalog[page.view].label;
  return `${title} — ${clusters.find(c => c.id === page.clusterId)?.name ?? 'Cluster'}`;
}
function readPreferences(): State['preferences'] { try { const saved = JSON.parse(localStorage.getItem('cluster-preferences') ?? '{}'); return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}; } catch { return {}; } }
export const useStore = create<State>((set, get) => ({
  preferences: readPreferences(), setPreference: (id, value) => { const preferences = { ...get().preferences, [id]: { ...get().preferences[id], ...value } }; set({ preferences }); try { localStorage.setItem('cluster-preferences', JSON.stringify(preferences)); } catch {} },
  clusters: [], clusterId: '', namespace: '', kind: 'pods', view: 'welcome', pages: [welcome], activePage: 'welcome', tabs: [], dockCollapsed: false,
  setClusters: clusters => { const state = get(); let pages = state.pages.filter(p => !p.clusterId || clusters.some(c => c.id === p.clusterId)); if (!pages.length) pages = [welcome]; set({ clusters, clusterId: clusters.some(c => c.id === state.clusterId) ? state.clusterId : clusters[0]?.id ?? '', pages }); if (!pages.some(p => p.id === state.activePage)) get().activatePage(pages[0].id); },
  selectCluster: id => get().navigate('overview', id),
  setNamespace: namespace => set(state => ({ namespace, selected: undefined, pages: state.pages.map(p => p.id === state.activePage ? { ...p, namespace } : p) })),
  setKind: kind => get().navigate(kind),
  navigate: (view, clusterId = get().clusterId, custom) => {
    const global = ['welcome', 'settings'].includes(view); const context = global ? '' : clusterId;
    const id = `${view}:${context}:${custom?.apiVersion ?? ''}:${custom?.plural ?? ''}`;
    const state = get(); const found = view === 'welcome' ? state.pages.find(p => p.view === 'welcome') : state.pages.find(p => p.id === id);
    const page = found ?? { id, view, clusterId: context, namespace: '', custom };
    set({ pages: found ? state.pages : [...state.pages, page] }); get().activatePage(page.id);
  },
  activatePage: id => {
    const page = get().pages.find(p => p.id === id); if (!page) return;
    set({ activePage: id, view: page.view, clusterId: page.clusterId || get().clusterId, namespace: page.namespace, custom: page.custom, kind: page.view in catalog || page.view === 'custom' ? page.view as ResourceKind : 'pods', selected: undefined });
  },
  closePage: id => {
    const state = get(); let pages = state.pages.filter(p => p.id !== id); if (!pages.length) pages = [welcome];
    set({ pages }); if (state.activePage === id) get().activatePage(pages.at(-1)!.id);
  },
  select: selected => set({ selected }), notify: error => set({ error }), toggleDock: () => set(s => ({ dockCollapsed: !s.dockCollapsed })),
  openTab: tab => set(state => { const id = crypto.randomUUID(); return { tabs: [...state.tabs, { ...tab, id }], activeTab: id, dockCollapsed: false }; }),
  closeTab: id => set(state => { const tabs = state.tabs.filter(t => t.id !== id); return { tabs, activeTab: state.activeTab === id ? tabs.at(-1)?.id : state.activeTab }; }),
  activateTab: activeTab => set({ activeTab, dockCollapsed: false })
}));
