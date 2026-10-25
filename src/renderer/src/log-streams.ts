import type { DesktopAPI, Fault, PodTarget, StreamEvent } from '../../shared/protocol';
import { logSourceKey, maxLogCharacters, maxLogLines, maxLogSources } from '../../shared/logs';

export interface LogLine { id: number; source: string; text: string; timestamp?: string }
export interface LogSourceState { key: string; phase: 'connecting' | 'live' | 'retrying' | 'ended' | 'error' | 'stopped'; message: string; attempts: number }
export interface LogSnapshot { lines: LogLine[]; sources: LogSourceState[]; dropped: number }
interface Source {
  target: PodTarget; state: LogSourceState; id?: string; partial: string; cursor?: string; cursorKey?: string;
  replay: Map<string, number>; replayTime?: string; timer?: ReturnType<typeof setTimeout>; started: number;
}
function timestamp(text: string) { return text.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z) /)?.[1]; }
function timeKey(time: string) { const [seconds, fraction = ''] = time.slice(0, -1).split('.'); return `${seconds}.${fraction.padEnd(9, '0')}`; }
const maxLineCharacters = 16_384;

// Each source has its own transport, cursor and retry budget. A failed Pod does
// not tear down streams for the other Pods in the same viewer.
export class LogStreams {
  private sources: Source[];
  private lines: LogLine[] = [];
  private size = 0;
  private dropped = 0;
  private sequence = 0;
  private disposed = false;
  private autoRetry = true;
  private updateTimer?: ReturnType<typeof setTimeout>;
  private unsubscribe: () => void;
  constructor(private api: DesktopAPI, targets: PodTarget[], private previous: boolean, private changed: (snapshot: LogSnapshot) => void) {
    if (!targets.length || targets.length > maxLogSources || new Set(targets.map(logSourceKey)).size !== targets.length || new Set(targets.map(t => t.clusterId)).size !== 1) throw new Error(`Choose 1–${maxLogSources} unique sources from one cluster.`);
    this.sources = targets.map(target => ({ target, state: { key: logSourceKey(target), phase: 'connecting', message: 'Connecting', attempts: 0 }, partial: '', replay: new Map(), started: 0 }));
    this.unsubscribe = api.subscribe(event => this.event(event));
  }
  start() { for (const source of this.sources) void this.connect(source); }
  snapshot(): LogSnapshot { return { lines: [...this.lines], sources: this.sources.map(s => ({ ...s.state })), dropped: this.dropped }; }
  private publish() {
    if (this.disposed || this.updateTimer) return;
    this.updateTimer = setTimeout(() => { this.updateTimer = undefined; if (!this.disposed) this.changed(this.snapshot()); }, 40);
  }
  private close(source: Source) {
    clearTimeout(source.timer); source.timer = undefined;
    const id = source.id; source.id = undefined;
    if (id) void this.api.request('stream:close', { id }).catch(() => {});
  }
  private async connect(source: Source) {
    this.close(source);
    if (this.disposed) return;
    const id = crypto.randomUUID(); source.id = id; source.started = Date.now(); source.partial = '';
    source.replay = new Map(); source.replayTime = source.cursor;
    if (source.cursor) for (const line of this.lines) if (line.source === source.state.key && line.timestamp === source.cursor) source.replay.set(line.text, (source.replay.get(line.text) ?? 0) + 1);
    source.state.phase = 'connecting'; source.state.message = 'Connecting'; this.publish();
    try {
      const result = await this.api.request('logs:start', { ...source.target, id, previous: this.previous, ...(source.cursor && !this.previous ? { sinceTime: source.cursor } : { tailLines: 500 }) });
      if (this.disposed || source.id !== id) { void this.api.request('stream:close', { id }).catch(() => {}); return; }
      if (!result.ok) { this.failed(source, result.error); return; }
      source.state.phase = 'live'; source.state.message = this.previous ? 'Reading previous container' : 'Live'; this.publish();
    } catch { if (!this.disposed && source.id === id) this.failed(source, { code: 'IPC_FAILED', message: 'Could not open the log stream.', retryable: true }); }
  }
  private append(source: Source, raw: string, incomplete = false) {
    const stamp = incomplete ? undefined : timestamp(raw);
    const text = raw.length > maxLineCharacters ? `${raw.slice(0, maxLineCharacters)} [line truncated]` : raw;
    if (stamp && source.replayTime) {
      const compared = timeKey(stamp).localeCompare(timeKey(source.replayTime));
      if (compared < 0) return;
      const repeats = source.replay.get(text) ?? 0;
      if (compared === 0 && repeats > 0) { source.replay.set(text, repeats - 1); return; }
      if (compared > 0) { source.replay.clear(); source.replayTime = undefined; }
    }
    if (stamp && (!source.cursorKey || timeKey(stamp) >= source.cursorKey)) { source.cursor = stamp; source.cursorKey = timeKey(stamp); }
    this.lines.push({ id: ++this.sequence, source: source.state.key, text: incomplete ? `${text} [partial line]` : text, timestamp: stamp });
    this.size += this.lines.at(-1)!.text.length;
    while (this.lines.length > maxLogLines || this.size > maxLogCharacters) { this.size -= this.lines.shift()!.text.length; this.dropped++; }
    this.publish();
  }
  private flush(source: Source) { if (source.partial) this.append(source, source.partial, true); source.partial = ''; }
  private failed(source: Source, fault?: Fault) {
    if (Date.now() - source.started >= 30000) source.state.attempts = 0;
    this.flush(source); this.close(source);
    const message = fault?.message ?? 'Stream ended';
    if (this.autoRetry && !this.previous && (!fault || fault.retryable) && source.state.attempts < 5) {
      const wait = 1000 * 2 ** source.state.attempts++;
      source.state.phase = 'retrying'; source.state.message = `${message}. Retry ${source.state.attempts}/5 in ${wait / 1000}s`;
      source.timer = setTimeout(() => { source.timer = undefined; void this.connect(source); }, wait);
    } else { source.state.phase = fault ? 'error' : 'ended'; source.state.message = source.state.attempts >= 5 ? `${message}. Automatic retries exhausted; reconnect manually.` : message; }
    this.publish();
  }
  private event(event: StreamEvent) {
    const source = this.sources.find(s => s.id === event.id);
    if (this.disposed || !source) return;
    if (event.type === 'data') {
      source.state.phase = 'live'; source.state.message = this.previous ? 'Reading previous container' : 'Live';
      const parts = (source.partial + event.data).split('\n'); source.partial = parts.pop() ?? '';
      for (const line of parts) this.append(source, line.replace(/\r$/, ''));
      // Bound a source that never writes a newline as well as the rendered buffer.
      if (source.partial.length > maxLineCharacters) { this.append(source, source.partial, true); source.partial = ''; }
      void this.api.request('stream:ack', { id: event.id, seq: event.seq }).catch(() => {}); this.publish();
    } else if (event.type === 'error') this.failed(source, event.error);
    else if (event.type === 'end') {
      if (event.reason === 'closed') { this.flush(source); this.close(source); source.state.phase = 'stopped'; source.state.message = 'Closed by cluster settings or disconnect'; this.publish(); }
      else this.failed(source);
    }
  }
  reconnect(key?: string) { for (const source of this.sources) if (!key || source.state.key === key) { source.state.attempts = 0; this.flush(source); void this.connect(source); } }
  stop(key?: string) { for (const source of this.sources) if (!key || source.state.key === key) { this.flush(source); this.close(source); source.state.phase = 'stopped'; source.state.message = 'Stopped'; } this.publish(); }
  setAutoRetry(enabled: boolean) {
    this.autoRetry = enabled;
    if (!enabled) for (const source of this.sources) if (source.state.phase === 'retrying') { clearTimeout(source.timer); source.timer = undefined; source.state.phase = 'ended'; source.state.message = 'Automatic reconnect disabled'; }
    this.publish();
  }
  clear() { this.lines = []; this.size = 0; this.dropped = 0; this.publish(); }
  dispose() { this.disposed = true; this.unsubscribe(); clearTimeout(this.updateTimer); for (const source of this.sources) this.close(source); }
}

export function exportLogText(lines: LogLine[]) { return lines.map(line => `[${line.source}] ${line.text}`).join('\n') + (lines.length ? '\n' : ''); }
