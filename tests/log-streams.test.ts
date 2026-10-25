import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DesktopAPI, PodTarget, StreamEvent } from '../src/shared/protocol';
import { LogStreams, exportLogText } from '../src/renderer/src/log-streams';
import { maxLogCharacters, maxLogLines } from '../src/shared/logs';
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const source = (pod: string): PodTarget => ({ clusterId: 'cluster', namespace: 'team', pod, container: 'app' });
function setup(targets = [source('web')], previous = false) {
  let listener!: (e: StreamEvent) => void;
  const request = vi.fn(async (_channel: string, _input: any): Promise<any> => ({ ok: true }));
  const unsubscribe = vi.fn();
  const api = { request, subscribe: (fn: typeof listener) => { listener = fn; return unsubscribe; } } as DesktopAPI;
  const changed = vi.fn();
  const logs = new LogStreams(api, targets, previous, changed);
  const starts = () => request.mock.calls.filter(([channel]) => channel === 'logs:start').map(([, input]) => input);
  return { logs, request, changed, unsubscribe, starts, event: (e: StreamEvent) => listener(e) };
}
it('frames split lines separately for each source, labels export and acknowledges chunks', async () => {
  const { logs, starts, event, request } = setup([source('a'), source('b')]); logs.start(); await vi.advanceTimersByTimeAsync(40);
  const [a, b] = starts();
  event({ id: a.id, type: 'data', seq: 1, data: '2026-10-25T10:00:00Z hel' });
  event({ id: b.id, type: 'data', seq: 1, data: '2026-10-25T10:00:01Z world\n' });
  event({ id: a.id, type: 'data', seq: 2, data: 'lo\n' });
  expect(logs.snapshot().lines.map(l => l.text)).toEqual(['2026-10-25T10:00:01Z world', '2026-10-25T10:00:00Z hello']);
  expect(exportLogText(logs.snapshot().lines)).toContain('[team/a/app] 2026-10-25T10:00:00Z hello\n');
  expect(request.mock.calls.filter(([channel]) => channel === 'stream:ack')).toHaveLength(3);
  logs.dispose();
});
it('resumes with nanosecond timestamps and only deduplicates already seen boundary copies', async () => {
  const { logs, starts, event } = setup(); logs.start(); await vi.advanceTimersByTimeAsync(40);
  const first = starts()[0].id, stamp = '2026-10-25T10:00:00.123456789Z';
  event({ id: first, type: 'data', seq: 1, data: `${stamp} same\n${stamp} same\n` });
  event({ id: first, type: 'error', error: { code: 'TIMEOUT', message: 'Temporary timeout', retryable: true } });
  await vi.advanceTimersByTimeAsync(1000);
  expect(starts()[1]).toMatchObject({ sinceTime: stamp }); expect(starts()[1]).not.toHaveProperty('tailLines');
  event({ id: starts()[1].id, type: 'data', seq: 1, data: `${stamp} same\n${stamp} same\n${stamp} same\n2026-10-25T10:00:00.123456790Z next\n` });
  expect(logs.snapshot().lines).toHaveLength(4); // Two old copies, one new identical line, then next.
  logs.dispose();
});
it('does not retry permission failures or cluster disconnects and keeps healthy sources alive', async () => {
  const { logs, starts, event } = setup([source('a'), source('b')]); logs.start(); await vi.advanceTimersByTimeAsync(40);
  event({ id: starts()[0].id, type: 'error', error: { code: 'FORBIDDEN', message: 'Denied', retryable: false } });
  expect(logs.snapshot().sources.map(s => s.phase)).toEqual(['error', 'live']);
  event({ id: starts()[1].id, type: 'end', reason: 'closed' });
  await vi.advanceTimersByTimeAsync(60000); expect(starts()).toHaveLength(2);
  expect(logs.snapshot().sources[1].phase).toBe('stopped'); logs.dispose();
});
it('bounds consecutive automatic retries, supports manual recovery and cancels timers on stop', async () => {
  const { logs, starts, event } = setup(); logs.start(); await vi.advanceTimersByTimeAsync(40);
  for (let n = 0; n < 6; n++) {
    event({ id: starts().at(-1).id, type: 'end' });
    await vi.advanceTimersByTimeAsync(n < 5 ? 1000 * 2 ** n : 20000);
  }
  expect(starts()).toHaveLength(6); expect(logs.snapshot().sources[0].message).toContain('exhausted');
  logs.reconnect(); await vi.advanceTimersByTimeAsync(40); expect(starts()).toHaveLength(7);
  event({ id: starts().at(-1).id, type: 'end' }); logs.stop(); await vi.advanceTimersByTimeAsync(60000);
  expect(starts()).toHaveLength(7); expect(logs.snapshot().sources[0].phase).toBe('stopped'); logs.dispose();
});
it('does not follow or auto-retry a previous-container snapshot', async () => {
  const { logs, starts, event } = setup([source('web')], true); logs.start(); await vi.advanceTimersByTimeAsync(40);
  expect(starts()[0].previous).toBe(true); event({ id: starts()[0].id, type: 'end' });
  await vi.advanceTimersByTimeAsync(60000); expect(starts()).toHaveLength(1); logs.dispose();
});
it('bounds complete lines and unterminated output, and retains history on manual reconnect', async () => {
  const { logs, starts, event } = setup(); logs.start(); await vi.advanceTimersByTimeAsync(40);
  const id = starts()[0].id;
  event({ id, type: 'data', seq: 1, data: Array.from({ length: 6000 }, (_, i) => `line-${i}`).join('\n') + '\n' });
  expect(logs.snapshot().lines).toHaveLength(maxLogLines); expect(logs.snapshot().dropped).toBe(1000);
  event({ id, type: 'data', seq: 2, data: 'x'.repeat(maxLogCharacters + 1) });
  expect(logs.snapshot().lines.at(-1)!.text).toContain('[partial line]');
  expect(logs.snapshot().lines.reduce((n, l) => n + l.text.length, 0)).toBeLessThanOrEqual(maxLogCharacters);
  logs.reconnect(); expect(logs.snapshot().lines.length).toBeGreaterThan(0);
  logs.clear(); expect(logs.snapshot().lines).toEqual([]); logs.dispose();
});
it('closes late starts after disposal and ignores stale events from a replaced session', async () => {
  const { logs, request, starts, event, unsubscribe, changed } = setup();
  let complete!: (value: any) => void;
  request.mockImplementation(async (channel) => channel === 'logs:start' ? new Promise(resolve => { complete = resolve; }) : { ok: true });
  logs.start(); const id = starts()[0].id; logs.dispose(); complete({ ok: true });
  event({ id, type: 'data', seq: 1, data: 'late\n' }); await vi.advanceTimersByTimeAsync(1000);
  expect(logs.snapshot().lines).toEqual([]); expect(changed).not.toHaveBeenCalled(); expect(unsubscribe).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith('stream:close', { id });
});
