import { logSeverity } from '../../shared/severity';
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { FileText, Network, TerminalSquare, X } from 'lucide-react';
import type { PodTarget, TerminalOptions } from '../../shared/protocol';
import { useStore, type DockTab } from './store';
import { closeStream, request } from './api';
import { ForwardPane } from './ForwardPane';
import '@xterm/xterm/css/xterm.css';

function TerminalPane({ tab, visible }: { tab: DockTab; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null); const fitRef = useRef<FitAddon>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    // A fresh stream ID per mount makes StrictMode cleanup and reloads safe.
    const id = crypto.randomUUID(); let active = true, ready = false;
    const terminal = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'Cascadia Code, Consolas, monospace', scrollback: 5000, theme: { background: '#202224', foreground: '#c8d0da', cursor: '#65b1e3' } });
    const fit = new FitAddon(); fitRef.current = fit; terminal.loadAddon(fit); terminal.open(host.current!); fit.fit();
    const unsubscribe = window.desktop.subscribe(event => {
      if (!active || event.id !== id) return;
      if (event.type === 'data') terminal.write(event.data, () => { if (active) void request('stream:ack', { id, seq: event.seq }).catch(() => {}); });
      if (event.type === 'error') setError(event.error.message);
      if (event.type === 'end') terminal.writeln(`\r\n[Session ended${event.exitCode !== undefined ? ` · exit ${event.exitCode}` : ''}]`);
    });
    const input = terminal.onData(data => { if (ready) void request('terminal:write', { id, data }).catch(e => setError(e.message)); });
    const resize = terminal.onResize(({ cols, rows }) => { if (ready) void request('terminal:resize', { id, cols, rows }).catch(() => {}); });
    const observer = new ResizeObserver(() => { if (host.current?.clientWidth) fit.fit(); }); observer.observe(host.current!);
    void ((tab.options as TerminalOptions).node ? request('nodeshell:open', { clusterId: (tab.options as TerminalOptions).clusterId!, node: (tab.options as TerminalOptions).node!, id, cols: terminal.cols, rows: terminal.rows }) : request('terminal:open', { ...tab.options as TerminalOptions, id, cols: terminal.cols, rows: terminal.rows })).then(() => { if (!active) { closeStream(id); return; } ready = true; fit.fit(); terminal.focus(); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; unsubscribe(); observer.disconnect(); input.dispose(); resize.dispose(); closeStream(id); terminal.dispose(); };
  }, [tab]);
  useEffect(() => { if (visible) requestAnimationFrame(() => { try { fitRef.current?.fit(); } catch {} }); }, [visible]);
  return <div className="stream-pane" style={{ display: visible ? 'flex' : 'none' }}>{error && <div className="inline-error">{error}</div>}<div className="terminal-host" ref={host}/></div>;
}
function LogsPane({ tab, visible }: { tab: DockTab; visible: boolean }) {
  const [text, setText] = useState(''); const [status, setStatus] = useState('Connecting'); const [follow, setFollow] = useState(true);
  const [revision, setRevision] = useState(0), [previous, setPrevious] = useState(false);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState(''); const output = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const id = crypto.randomUUID(); let active = true, failed = false; setFailed(false); setText(''); setStatus('Connecting');
    const unsubscribe = window.desktop.subscribe(event => {
      if (!active || event.id !== id) return;
      if (event.type === 'data') {
        setStatus('Live'); setText(previous => (previous + event.data).slice(-1_000_000));
        void request('stream:ack', { id, seq: event.seq }).catch(() => {});
      }
      if (event.type === 'error') { failed = true; setFailed(true); setStatus(event.error.message); }
      if (event.type === 'end' && !failed) setStatus('Stream ended');
    });
    void request('logs:start', { ...tab.options as PodTarget, id, tailLines: 500, previous }).catch(e => { if (active) { setFailed(true); setStatus(e.message); } });
    return () => { active = false; unsubscribe(); closeStream(id); };
  }, [tab, revision, previous]);
  useEffect(() => { if (follow && output.current) output.current.scrollTop = output.current.scrollHeight; }, [text, follow, visible]);
  return <div className="stream-pane" style={{ display: visible ? 'flex' : 'none' }}><div className={`log-toolbar ${failed ? "severity-error" : ""}`}><span className={status === 'Live' ? 'live-dot' : ''}/>{status}<button onClick={() => setRevision(v => v + 1)}>Reconnect logs</button><label><input type="checkbox" checked={previous} onChange={e => setPrevious(e.target.checked)}/>Previous container</label><input placeholder="Filter log lines" value={filter} onChange={e => setFilter(e.target.value)}/><label><input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)}/> Follow</label><button onClick={() => setText('')}>Clear</button></div><pre ref={output} className="logs">{text ? text.split('\n').filter(line => !filter || line.toLowerCase().includes(filter.toLowerCase())).map((line, index, lines) => <span key={index} className={`log-line severity-${logSeverity(line)}`}>{line}{index < lines.length - 1 ? '\n' : ''}</span>) : 'Waiting for container output?'}</pre></div>;
}
export function Dock() {
  const tabs = useStore(s => s.tabs), active = useStore(s => s.activeTab), activate = useStore(s => s.activateTab), close = useStore(s => s.closeTab);
  const collapsed = useStore(s => s.dockCollapsed); const [height, setHeight] = useState(250);
  if (!tabs.length) return null;
  return <section className="dock" style={{ height, display: collapsed ? 'none' : 'flex' }}><div className="dock-resize" role="separator" aria-label="Resize terminal dock" onPointerDown={e => { const start = e.clientY, initial = height; e.currentTarget.setPointerCapture(e.pointerId); const element = e.currentTarget; const move = (event: PointerEvent) => setHeight(Math.max(120, Math.min(window.innerHeight * .65, initial + start - event.clientY))); const end = () => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', end); }; element.addEventListener('pointermove', move); element.addEventListener('pointerup', end); }}/><div className="dock-tabs">{tabs.map(tab => <div key={tab.id} className={active === tab.id ? 'dock-tab active' : 'dock-tab'}><button onClick={() => activate(tab.id)}>{tab.type === 'logs' ? <FileText size={14}/> : tab.type === 'forward' ? <Network size={14}/> : <TerminalSquare size={14}/>} {tab.title}</button><button title="Close session" onClick={() => close(tab.id)}><X size={13}/></button></div>)}</div><div className="dock-content">{tabs.map(tab => tab.type === 'terminal' ? <TerminalPane key={tab.id} tab={tab} visible={!collapsed && active === tab.id}/> : tab.type === 'forward' ? <ForwardPane key={tab.id} tab={tab} visible={!collapsed && active === tab.id}/> : <LogsPane key={tab.id} tab={tab} visible={!collapsed && active === tab.id}/>)}</div></section>;
}
