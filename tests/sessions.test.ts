import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { utilityProcess } from 'electron';
import { SessionService } from '../src/main/sessions';
import { Streams } from '../src/main/streams';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

it('starts a pod PTY with a native executable and separate scoped arguments, then cleans up', async () => {
  const worker = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() });
  vi.mocked(utilityProcess.fork).mockReturnValue(worker as any);
  const cleanup = vi.fn();
  const lease = { path: 'C:/path with spaces/config', settings: {}, cleanup };
  const streams = new Streams();
  const service = new SessionService({ cliConfig: () => lease, get: () => ({ cluster: { name: 'selected-context' } }) } as any, streams);
  const owner = { id: 1, isDestroyed: () => false, send: vi.fn() } as any;
  const input = { id: crypto.randomUUID(), clusterId: 'cluster', namespace: 'team', pod: 'web', container: 'app', cols: 80, rows: 24 };
  const pending = service.terminal(owner, input);
  worker.emit('spawn');
  expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
    type: 'open', file: process.platform === 'win32' ? 'kubectl.exe' : 'kubectl',
    args: ['--kubeconfig', lease.path, '--context', 'selected-context', '--namespace', 'team', 'exec', '-it', 'web', '-c', 'app', '--', '/bin/sh']
  }));
  worker.emit('message', { type: 'ready' });
  await pending;
  streams.close(input.id);
  expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'close' });
  expect(cleanup).toHaveBeenCalledOnce();
});
