import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { TerminalOptions } from '../../shared/protocol';
import { shellPresets, validContainerShell } from '../../shared/logs';
import { useStore, type DockTab } from './store';
import { closeStream, request } from './api';
import '@xterm/xterm/css/xterm.css';

export function TerminalPane({ tab, visible }: { tab: DockTab; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null), fitRef = useRef<FitAddon | null>(null), termRef = useRef<Terminal | null>(null);
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const [hasSelection, setHasSelection] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const clipboardActions = useRef<{ copy: () => void; paste: () => void } | null>(null);
  const options = tab.options as TerminalOptions;
  const [shell, setShell] = useState(() => options.shell ?? useStore.getState().clusterSettings[options.clusterId ?? '']?.containerShell ?? '/bin/sh');
  const [status, setStatus] = useState('Connecting'), [error, setError] = useState(''), [confirmNode, setConfirmNode] = useState(false);
  const controls = useRef<{ connect: (shell: string) => void; disconnect: () => void } | null>(null);
  useEffect(() => {
    let active = true, id: string | undefined, ready = false;
    const terminal = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'Cascadia Code, Consolas, monospace', scrollback: 5000, theme: { background: '#202224', foreground: '#c8d0da', cursor: '#65b1e3' } });
    const fit = new FitAddon(); fitRef.current = fit; termRef.current = terminal; terminal.loadAddon(fit); terminal.open(host.current!); fit.fit();
    const copy = () => {
      const text = terminal.getSelection(); if (!text) return;
      void request('terminal:clipboard-write', { text }).catch(e => { if (active) setError(e.message); });
    };
    let pasting = false;
    const paste = () => {
      if (!ready || !id || pasting) return;
      const current = id; pasting = true;
      void request('terminal:clipboard-read', undefined).then(text => {
        if (active && ready && id === current && visibleRef.current) { terminal.paste(text); terminal.focus(); }
      }).catch(e => { if (active && id === current) setError(e.message); }).finally(() => { pasting = false; });
    };
    clipboardActions.current = { copy, paste };
    const selection = terminal.onSelectionChange(() => { if (active) setHasSelection(terminal.hasSelection()); });
    terminal.attachCustomKeyEventHandler(event => {
      const key = event.key.toLowerCase();
      const copyKey = !event.altKey && ((key === 'c' && (event.metaKey || (event.ctrlKey && (event.shiftKey || terminal.hasSelection())))) || (key === 'insert' && event.ctrlKey));
      const pasteKey = !event.altKey && ((key === 'v' && (event.ctrlKey || event.metaKey)) || (key === 'insert' && event.shiftKey));
      if (!copyKey && !pasteKey) return true;
      event.preventDefault(); event.stopPropagation();
      if (event.type === 'keydown' && !event.repeat) { if (copyKey) copy(); else paste(); }
      return false;
    });
    const disconnect = () => { const old = id; id = undefined; ready = false; if (old) closeStream(old); if (active) setStatus('Disconnected'); };
    const connect = (selectedShell: string) => {
      disconnect(); if (!active) return;
      const current = crypto.randomUUID(); id = current; setError(''); setStatus('Connecting'); terminal.writeln('\r\n[Starting a new session — commands are not replayed]');
      const pending = options.node ? request('nodeshell:open', { clusterId: options.clusterId!, node: options.node, id: current, cols: terminal.cols, rows: terminal.rows }) : request('terminal:open', { ...options, ...(options.pod ? { shell: selectedShell } : {}), id: current, cols: terminal.cols, rows: terminal.rows });
      void pending.then(() => { if (!active || id !== current) { closeStream(current); return; } ready = true; setStatus('Connected'); fit.fit(); terminal.focus(); }).catch(e => { if (active && id === current) { disconnect(); setStatus('Failed'); setError(e.message); } });
    };
    const unsubscribe = window.desktop.subscribe(event => {
      if (!active || event.id !== id) return;
      if (event.type === 'data') { const current = id; terminal.write(event.data, () => { if (active && id === current) void request('stream:ack', { id: current!, seq: event.seq }).catch(() => {}); }); }
      if (event.type === 'error') { setError(event.error.message); ready = false; setStatus('Failed'); }
      if (event.type === 'end') { ready = false; id = undefined; setStatus(event.reason === 'closed' ? 'Disconnected' : 'Ended'); terminal.writeln(`\r\n[Session ended${event.exitCode !== undefined ? ` · exit ${event.exitCode}` : ''}]`); }
    });
    const input = terminal.onData(data => { const current = id; if (ready && current) void request('terminal:write', { id: current, data }).catch(e => { if (active && id === current) { setError(e.message); ready = false; setStatus('Failed'); } }); });
    const resize = terminal.onResize(({ cols, rows }) => { if (ready && id) void request('terminal:resize', { id, cols, rows }).catch(() => {}); });
    const observer = new ResizeObserver(() => { if (host.current?.clientWidth) fit.fit(); }); observer.observe(host.current!);
    controls.current = { connect, disconnect }; connect(shell);
    return () => { active = false; unsubscribe(); disconnect(); controls.current = null; clipboardActions.current = null; selection.dispose(); observer.disconnect(); input.dispose(); resize.dispose(); terminal.dispose(); termRef.current = null; fitRef.current = null; };
  }, [tab]);
  useEffect(() => { if (visible) requestAnimationFrame(() => { try { fitRef.current?.fit(); } catch {} }); }, [visible]);
  useEffect(() => { if (!visible) setMenu(undefined); }, [visible]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(undefined); const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close(); termRef.current?.focus(); } };
    window.addEventListener('pointerdown', close); window.addEventListener('blur', close); document.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('blur', close); document.removeEventListener('keydown', key, true); };
  }, [menu]);
  const invalidShell = !!options.pod && !validContainerShell(shell);
  return <div className="stream-pane terminal-pane" style={{ display: visible ? 'flex' : 'none' }}>
    <div className="terminal-toolbar"><span role="status">{status}</span>{options.pod && !options.node && <label>Container shell<input aria-label="Container shell" list={`shell-${tab.id}`} value={shell} onChange={e => setShell(e.target.value)}/><datalist id={`shell-${tab.id}`}>{shellPresets.map(value => <option key={value} value={value}/>)}</datalist></label>}
      <button disabled={!hasSelection} title="Copy selection (Ctrl+Shift+C)" onMouseDown={e => e.preventDefault()} onClick={() => clipboardActions.current?.copy()}>Copy</button><button disabled={status !== 'Connected'} title="Paste (Ctrl+Shift+V or Ctrl+V)" onClick={() => clipboardActions.current?.paste()}>Paste</button><button disabled={invalidShell} onClick={() => options.node ? setConfirmNode(true) : controls.current?.connect(shell)}>Reconnect terminal</button><button onClick={() => controls.current?.disconnect()}>Disconnect terminal</button><button onClick={() => termRef.current?.clear()}>Clear terminal</button>
      <span className="muted">Reconnect starts a new process; existing commands are not resumed.</span>
    </div>{invalidShell && <div className="inline-error">Enter one shell executable without arguments or shell operators.</div>}{error && <div className="inline-error">{error}</div>}
    {confirmNode && <div className="terminal-reconnect-confirm"><p>Reconnect creates a new privileged node-shell Pod and requests deletion of the old helper.</p><button onClick={() => setConfirmNode(false)}>Cancel</button><button onClick={() => { setConfirmNode(false); controls.current?.connect(shell); }}>Confirm node shell reconnect</button></div>}
    <div className="terminal-host" ref={host} onContextMenu={event => { event.preventDefault(); setMenu({ x: Math.max(4, Math.min(event.clientX, window.innerWidth - 230)), y: Math.max(4, Math.min(event.clientY, window.innerHeight - 120)) }); }}/>
    {menu && <div className="terminal-context-menu" role="menu" aria-label="Terminal clipboard" style={{ left: menu.x, top: menu.y }} onPointerDown={e => e.stopPropagation()}><button role="menuitem" disabled={!hasSelection} onClick={() => { clipboardActions.current?.copy(); setMenu(undefined); }}>Copy selection <small>Ctrl+Shift+C</small></button><button role="menuitem" disabled={status !== 'Connected'} onClick={() => { clipboardActions.current?.paste(); setMenu(undefined); }}>Paste <small>Ctrl+Shift+V</small></button><button role="menuitem" onClick={() => { termRef.current?.selectAll(); setMenu(undefined); }}>Select all</button></div>}
  </div>;
}
