import { useEffect, useRef, useState } from 'react';
import type { PodTarget } from '../../shared/protocol';
import type { LogOptions } from '../../shared/logs';
import { maxLogCharacters, maxLogLines } from '../../shared/logs';
import { logSeverity } from '../../shared/severity';
import type { DockTab } from './store';
import { LogStreams, exportLogText, type LogSnapshot } from './log-streams';
import { request } from './api';

export function LogsPane({ tab, visible }: { tab: DockTab; visible: boolean }) {
  const [snapshot, setSnapshot] = useState<LogSnapshot>({ lines: [], sources: [], dropped: 0 });
  const [previous, setPrevious] = useState(false), [auto, setAuto] = useState(true), [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState(''), [sourceFilter, setSourceFilter] = useState(''), [message, setMessage] = useState(''), [exporting, setExporting] = useState(false);
  const output = useRef<HTMLPreElement>(null), controller = useRef<LogStreams | null>(null);
  useEffect(() => {
    const options = tab.options as PodTarget | LogOptions;
    const sources = 'sources' in options ? options.sources : [options];
    setSnapshot({ lines: [], sources: [], dropped: 0 }); setMessage('');
    let logs: LogStreams;
    try { logs = new LogStreams(window.desktop, sources, previous, setSnapshot); controller.current = logs; logs.setAutoRetry(auto); logs.start(); }
    catch (e) { setMessage((e as Error).message); return; }
    return () => { logs.dispose(); if (controller.current === logs) controller.current = null; };
  }, [tab, previous]);
  useEffect(() => { controller.current?.setAutoRetry(auto); }, [auto]);
  useEffect(() => { if (follow && output.current) output.current.scrollTop = output.current.scrollHeight; }, [snapshot.lines, follow, visible]);
  const filtered = snapshot.lines.filter(line => (!sourceFilter || line.source === sourceFilter) && (!filter || line.text.toLowerCase().includes(filter.toLowerCase()) || line.source.toLowerCase().includes(filter.toLowerCase())));
  const exportLines = async (onlyFiltered: boolean) => {
    setExporting(true); setMessage('');
    try { const result = await request('logs:export', { text: exportLogText(onlyFiltered ? filtered : snapshot.lines) }); setMessage(result.saved ? 'Logs exported.' : 'Export cancelled.'); }
    catch (e) { setMessage((e as Error).message); } finally { setExporting(false); }
  };
  return <div className="stream-pane logs-pane" style={{ display: visible ? 'flex' : 'none' }}>
    <div className="log-toolbar"><button onClick={() => controller.current?.reconnect()}>Reconnect logs</button><button onClick={() => controller.current?.stop()}>Stop logs</button>
      <label><input type="checkbox" checked={previous} onChange={e => setPrevious(e.target.checked)}/>Previous container</label>
      <label><input type="checkbox" checked={auto} disabled={previous} onChange={e => setAuto(e.target.checked)}/>Auto reconnect</label>
      <label><input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)}/>Follow</label>
      <input aria-label="Filter log lines" placeholder="Filter log lines" value={filter} onChange={e => setFilter(e.target.value)}/>
      <select aria-label="Filter log source" value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}><option value="">All sources</option>{snapshot.sources.map(source => <option key={source.key} value={source.key}>{source.key}</option>)}</select>
      <button disabled={exporting || !snapshot.lines.length} onClick={() => void exportLines(false)}>Export retained</button><button disabled={exporting || !filtered.length} onClick={() => void exportLines(true)}>Export filtered</button><button onClick={() => controller.current?.clear()}>Clear</button>
    </div>
    <details className="log-source-status" open={snapshot.sources.some(s => s.phase === 'error' || s.phase === 'retrying')}><summary>{snapshot.sources.filter(s => s.phase === 'live').length}/{snapshot.sources.length} sources live · {filtered.length} retained lines shown{snapshot.dropped ? ` · ${snapshot.dropped} older lines discarded` : ''}</summary>
      {snapshot.sources.map(source => <div key={source.key} className={`log-source-row ${source.phase === 'error' ? 'severity-error' : ''}`}><code>{source.key}</code><span>{source.message}</span><button aria-label={`Reconnect ${source.key}`} onClick={() => controller.current?.reconnect(source.key)}>Reconnect</button><button aria-label={`Stop ${source.key}`} onClick={() => controller.current?.stop(source.key)}>Stop</button></div>)}
      <p>Retains up to {maxLogLines.toLocaleString()} lines / {(maxLogCharacters / 1_000_000).toFixed(0)}M characters. Reconnect resumes by timestamp when available; rotated logs and unavailable Pods can leave gaps. Exports include source labels and only retained lines.</p>
    </details>
    {message && <div className="log-message" role="status">{message}</div>}
    <pre ref={output} className="logs">{filtered.length ? filtered.map(line => <span key={line.id} className={`log-line severity-${logSeverity(line.text)}`}><span className="log-line-source">[{line.source}] </span>{line.text}{'\n'}</span>) : 'Waiting for container output or no matching retained lines.'}</pre>
  </div>;
}
