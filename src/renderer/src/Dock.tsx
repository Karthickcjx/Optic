import { useState } from 'react';
import { Columns2, Rows2, FileText, Network, TerminalSquare, X } from 'lucide-react';
import type { TerminalOptions } from '../../shared/protocol';
import { useStore } from './store';
import { startLocalTerminal } from './TerminalLauncher';
import { ForwardPane } from './ForwardPane';
import { TerminalPane } from './TerminalPane';
import { LogsPane } from './LogsPane';

export function Dock() {
  const tabs = useStore(s => s.tabs), active = useStore(s => s.activeTab), activate = useStore(s => s.activateTab), close = useStore(s => s.closeTab);
  const collapsed = useStore(s => s.dockCollapsed); const [height, setHeight] = useState(250);
  const [pair, setPair] = useState<string[]>([]); const [direction, setDirection] = useState<'columns' | 'rows'>('columns'); const [ratio, setRatio] = useState(50);
  const selected = tabs.find(t => t.id === active);
  const split = pair.length === 2 && pair.every(id => tabs.some(t => t.id === id)) && pair.includes(active ?? '');
  const makeSplit = (axis: 'columns' | 'rows') => {
    if (!selected || selected.type !== 'terminal' || (selected.options as TerminalOptions).node) return;
    setDirection(axis); setRatio(50);
    if (!split) {
      const options = selected.options as TerminalOptions;
      if (options.pod) useStore.getState().openTab({ type: 'terminal', title: selected.title, options: { ...options } });
      else startLocalTerminal(options.clusterId);
      setPair([selected.id, useStore.getState().activeTab!]);
    }
    setHeight(h => Math.max(h, Math.min(window.innerHeight * .65, axis === 'rows' ? 480 : 340)));
  };
  if (!tabs.length) return null;
  return <section className="dock" style={{ height, display: collapsed ? 'none' : 'flex' }}>
    <div className="dock-resize" role="separator" aria-label="Resize terminal dock" onPointerDown={e => { const start = e.clientY, initial = height; e.currentTarget.setPointerCapture(e.pointerId); const element = e.currentTarget; const move = (event: PointerEvent) => setHeight(Math.max(120, Math.min(window.innerHeight * .65, initial + start - event.clientY))); const end = () => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', end); element.removeEventListener('pointercancel', end); }; element.addEventListener('pointermove', move); element.addEventListener('pointerup', end); element.addEventListener('pointercancel', end); }}/>
    <div className="dock-tabbar"><div className="dock-tabs">{tabs.map(tab => <div key={tab.id} className={active === tab.id ? 'dock-tab active' : 'dock-tab'}><button onClick={() => activate(tab.id)}>{tab.type === 'logs' ? <FileText size={14}/> : tab.type === 'forward' ? <Network size={14}/> : <TerminalSquare size={14}/>} {tab.title}</button><button title="Close session" onClick={() => close(tab.id)}><X size={13}/></button></div>)}</div><div className="dock-layout-actions"><button aria-label="Split terminal side by side" title="Split side by side (uses selected local profile)" disabled={selected?.type !== 'terminal' || !!(selected.options as TerminalOptions).node} onClick={() => makeSplit('columns')}><Columns2 size={15}/></button><button aria-label="Split terminal stacked" title="Split stacked (uses selected local profile)" disabled={selected?.type !== 'terminal' || !!(selected.options as TerminalOptions).node} onClick={() => makeSplit('rows')}><Rows2 size={15}/></button>{split && <button onClick={() => setPair([])} title="Keep both sessions as tabs">Unsplit</button>}</div></div>
    <div className={`dock-content dock-panes ${split ? `split-${direction}` : ''}`}>{tabs.map(tab => {
      const shown = split ? pair.includes(tab.id) : active === tab.id;
      return <div key={tab.id} className={`dock-pane-slot ${active === tab.id ? 'focused' : ''}`} style={{ display: shown ? 'flex' : 'none', order: split && pair[1] === tab.id ? 2 : 0, flex: split ? `0 0 calc(${pair[0] === tab.id ? ratio : 100 - ratio}% - 3px)` : '1 1 100%' }} onFocusCapture={() => { if (active !== tab.id) activate(tab.id); }}>
        {split && <div className="split-pane-heading"><button onClick={() => activate(tab.id)}>{tab.title}</button><button title="Close split pane" onClick={() => { close(tab.id); activate(pair.find(id => id !== tab.id)!); setPair([]); }}><X size={13}/></button></div>}
        {tab.type === 'terminal' ? <TerminalPane tab={tab} visible={!collapsed && shown}/> : tab.type === 'forward' ? <ForwardPane tab={tab} visible={!collapsed && shown}/> : <LogsPane tab={tab} visible={!collapsed && shown}/>}
      </div>;
    })}{split && <div className="terminal-split-divider" role="separator" aria-label="Resize split terminals" aria-orientation={direction === 'columns' ? 'vertical' : 'horizontal'} aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(ratio)} tabIndex={0} style={{ order: 1 }} onKeyDown={e => { if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(e.key)) { e.preventDefault(); setRatio(r => Math.max(20, Math.min(80, r + (['ArrowLeft', 'ArrowUp'].includes(e.key) ? -5 : 5)))); } }} onPointerDown={e => { const element = e.currentTarget; const bounds = element.parentElement!.getBoundingClientRect(); element.setPointerCapture(e.pointerId); const move = (event: PointerEvent) => setRatio(Math.max(20, Math.min(80, direction === 'columns' ? (event.clientX - bounds.left) / bounds.width * 100 : (event.clientY - bounds.top) / bounds.height * 100))); const end = () => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', end); element.removeEventListener('pointercancel', end); }; element.addEventListener('pointermove', move); element.addEventListener('pointerup', end); element.addEventListener('pointercancel', end); }}/>}</div>
  </section>;
}
