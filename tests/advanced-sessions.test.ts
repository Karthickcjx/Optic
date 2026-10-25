import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { utilityProcess } from 'electron';
import { fetch } from 'undici';
import { SessionService } from '../src/main/sessions';
import { Streams } from '../src/main/streams';
import { schemas } from '../src/main/validation';
import { clusterSettingsSchema } from '../src/main/cluster-settings';
import { defaultClusterSettings } from '../src/shared/cluster-settings';
vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
vi.mock('undici', () => ({ fetch: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());
it('migrates old cluster settings and rejects shell command strings while accepting executable names', () => {
  const { containerShell: _shell, ...legacy } = defaultClusterSettings;
  expect(clusterSettingsSchema.parse(legacy).containerShell).toBe('/bin/sh');
  const input = { id: crypto.randomUUID(), clusterId: 'c', namespace: 'team', pod: 'web', cols: 80, rows: 24 };
  for (const shell of ['/bin/bash', '/busybox/sh', 'powershell.exe']) expect(schemas['terminal:open'].safeParse({ ...input, shell }).success).toBe(true);
  for (const shell of ['/bin/sh -c whoami', 'sh;evil', '', 'bash\n']) expect(schemas['terminal:open'].safeParse({ ...input, shell }).success).toBe(false);
  expect(schemas['logs:start'].safeParse({ ...input, sinceTime: '2026-10-25T10:00:00.123456789Z' }).success).toBe(true);
  expect(schemas['logs:start'].safeParse({ ...input, sinceTime: 'invalid' }).success).toBe(false);
});
it('uses a per-session shell or cluster default as a single argv value and notifies on cluster disconnect', async () => {
  const streams = new Streams(), cleanup = vi.fn(), owner = { id: 1, isDestroyed: () => false, send: vi.fn() } as any;
  const service = new SessionService({ get: () => ({ cluster: { name: 'context' } }), cliConfig: () => ({ path: 'private-config', settings: { containerShell: '/bin/ash' }, cleanup }) } as any, streams);
  for (const shell of [undefined, '/bin/bash']) {
    const worker = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() }); vi.mocked(utilityProcess.fork).mockReturnValue(worker as any);
    const id = crypto.randomUUID(); const opened = service.terminal(owner, { id, clusterId: 'c', namespace: 'team', pod: 'web', container: 'app', shell, cols: 80, rows: 24 });
    worker.emit('spawn'); expect(worker.postMessage.mock.calls[0][0].args.slice(-2)).toEqual(['--', shell ?? '/bin/ash']);
    worker.emit('message', { type: 'ready' }); await opened; streams.closeCluster('c');
    expect(owner.send).toHaveBeenCalledWith('stream:event', { id, type: 'end', exitCode: undefined, reason: 'closed' });
  }
  expect(cleanup).toHaveBeenCalledTimes(2);
});
it('resumes logs with sinceTime without tail truncation, decodes split UTF-8 and aborts on close', async () => {
  const streams = new Streams(); let body!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream({ start(controller) { body = controller; } }));
  vi.mocked(fetch).mockResolvedValue(response as any);
  const config = { getCurrentCluster: () => ({ server: 'https://cluster.example' }), applySecurityAuthentication: async () => {} };
  const owner = { id: 1, isDestroyed: () => false, send: vi.fn() } as any;
  const service = new SessionService({ get: () => ({ config }) } as any, streams);
  const id = crypto.randomUUID(); await service.logs(owner, { id, clusterId: 'c', namespace: 'team', pod: 'web', container: 'app', sinceTime: '2026-10-25T10:00:00.123456789Z' });
  const url = new URL(String(vi.mocked(fetch).mock.calls[0][0]));
  expect(url.searchParams.get('sinceTime')).toBe('2026-10-25T10:00:00.123456789Z'); expect(url.searchParams.has('tailLines')).toBe(false);
  const bytes = new TextEncoder().encode('é\n'); body.enqueue(bytes.slice(0, 1)); body.enqueue(bytes.slice(1));
  await vi.waitFor(() => expect(owner.send).toHaveBeenCalledWith('stream:event', expect.objectContaining({ type: 'data', data: 'é\n' })));
  streams.get(id, owner).ack!(1); streams.close(id);
  expect(vi.mocked(fetch).mock.calls[0][1]!.signal!.aborted).toBe(true);
});
