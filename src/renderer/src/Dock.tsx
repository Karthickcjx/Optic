import { useState } from 'react';
import { FileText, Network, TerminalSquare, X } from 'lucide-react';
import { useStore } from './store';
import { ForwardPane } from './ForwardPane';
import { TerminalPane } from './TerminalPane';
import { LogsPane } from './LogsPane';

export function Dock() {
  const tabs = useStore(s => s.tabs), active = useStore(s => s.activeTab), activate = useStore(s => s.activateTab), close = useStore(s => s.closeTab);
  const collapsed = useStore(s => s.dockCollapsed); const [height, setHeight] = useState(250);
  if (!tabs.length) return null;
  return <section className="dock" style={{ height, display: collapsed ? 'none' : 'flex' }}><div className="dock-resize" role="separator" aria-label="Resize terminal dock" onPointerDown={e => { const start = e.clientY, initial = height; e.currentTarget.setPointerCapture(e.pointerId); const element = e.currentTarget; const move = (event: PointerEvent) => setHeight(Math.max(120, Math.min(window.innerHeight * .65, initial + start - event.clientY))); const end = () => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', end); }; element.addEventListener('pointermove', move); element.addEventListener('pointerup', end); }}/><div className="dock-tabs">{tabs.map(tab => <div key={tab.id} className={active === tab.id ? 'dock-tab active' : 'dock-tab'}><button onClick={() => activate(tab.id)}>{tab.type === 'logs' ? <FileText size={14}/> : tab.type === 'forward' ? <Network size={14}/> : <TerminalSquare size={14}/>} {tab.title}</button><button title="Close session" onClick={() => close(tab.id)}><X size={13}/></button></div>)}</div><div className="dock-content">{tabs.map(tab => tab.type === 'terminal' ? <TerminalPane key={tab.id} tab={tab} visible={!collapsed && active === tab.id}/> : tab.type === 'forward' ? <ForwardPane key={tab.id} tab={tab} visible={!collapsed && active === tab.id}/> : <LogsPane key={tab.id} tab={tab} visible={!collapsed && active === tab.id}/>)}</div></section>;
}
