import { useEffect } from 'react';
import { create } from 'zustand';
import { RefreshCw, TerminalSquare } from 'lucide-react';
import type { LocalShellId, LocalShellProfile } from '../../shared/terminal';
import { request } from './api';
import { useStore } from './store';
export const useTerminalProfiles = create<{ profiles: LocalShellProfile[]; selected: LocalShellId; error: string; loading: boolean; choose: (id: LocalShellId) => void; refresh: () => Promise<void> }>((set) => ({
  profiles: [], selected: 'system', error: '', loading: false,
  choose: selected => set({ selected }),
  refresh: async () => { set({ loading: true, error: '' }); try { set({ profiles: await request('terminal:profiles', undefined) }); } catch (error) { set({ error: (error as Error).message }); } finally { set({ loading: false }); } },
}));
export function startLocalTerminal(clusterId?: string) {
  const { selected, profiles } = useTerminalProfiles.getState();
  useStore.getState().openTab({ type: 'terminal', title: selected === 'system' ? 'Terminal' : profiles.find(p => p.id === selected)?.label ?? selected, options: { clusterId, localShell: selected, cols: 100, rows: 24 } });
}
export function TerminalLauncher({ clusterId }: { clusterId?: string }) {
  const { profiles, selected, choose, refresh, error, loading } = useTerminalProfiles();
  useEffect(() => { void refresh(); }, []);
  return <div className="terminal-launcher-controls"><button onClick={() => startLocalTerminal(clusterId)} disabled={profiles.find(p => p.id === selected)?.available === false} title="Open selected terminal"><TerminalSquare size={13}/>Terminal</button><select aria-label="Local terminal profile" title="Shell for new local terminals" value={selected} onChange={e => choose(e.target.value as LocalShellId)}>{!profiles.length && <option value="system">System shell</option>}{profiles.map(p => <option key={p.id} value={p.id} disabled={!p.available}>{p.label}{p.available ? '' : ' (not installed)'}</option>)}</select><button title={error || 'Refresh terminal profiles'} aria-label="Refresh terminal profiles" disabled={loading} onClick={() => void refresh()}><RefreshCw size={12} className={loading ? 'spin' : undefined}/></button>{error && <span role="alert" title={error}>Profiles unavailable</span>}</div>;
}
