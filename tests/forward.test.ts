import { it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { ForwardService, forwardArgs } from '../src/main/forward';
import { Streams } from '../src/main/streams';
import { schemas } from '../src/main/validation';
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const input = { id: crypto.randomUUID(), clusterId: 'cluster', namespace: 'default', kind: 'pods' as const, name: 'web', localPort: 0, remotePort: 8080 };
const owner = { id: 1, isDestroyed: () => false, send: vi.fn() } as any;
beforeEach(() => vi.clearAllMocks());
it('restricts forwarding payloads and binds kubectl to loopback without a shell', () => {
  expect(schemas['forward:start'].safeParse({ ...input, localPort: 65536 }).success).toBe(false);
  expect(schemas['forward:start'].safeParse({ ...input, remotePort: 0 }).success).toBe(false);
  expect(schemas['forward:start'].safeParse({ ...input, name: 'web;calc' }).success).toBe(false);
  expect(forwardArgs('C:/path with spaces/config', 'context', input)).toContain('--address=127.0.0.1');
  expect(forwardArgs('config', 'context', input).at(-1)).toBe(':8080');
});
it('resolves only after readiness and kills the process when its owning context closes', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  vi.mocked(spawn).mockReturnValue(child as any);
  const streams = new Streams();
  const service = new ForwardService({ get: () => ({ cluster: { source: 'config', name: 'context' } }) } as any, streams);
  const pending = service.start(owner, input);
  child.stdout.write('Forwarding from 127.0.0.1:'); child.stdout.write('49123 -> 8080\n');
  await expect(pending).resolves.toEqual({ localPort: 49123 });
  expect(spawn).toHaveBeenCalledWith('kubectl', expect.any(Array), expect.objectContaining({ shell: false, windowsHide: true }));
  streams.closeCluster('other'); expect(child.kill).not.toHaveBeenCalled();
  streams.closeCluster('cluster'); expect(child.kill).toHaveBeenCalledOnce();
});
it('reports missing kubectl and releases the stream slot', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  vi.mocked(spawn).mockReturnValue(child as any);
  const streams = new Streams();
  const service = new ForwardService({ get: () => ({ cluster: { source: 'config', name: 'context' } }) } as any, streams);
  const pending = service.start(owner, input); child.emit('error', new Error('ENOENT'));
  await expect(pending).rejects.toThrow('Install kubectl');
  expect(() => streams.get(input.id, owner)).toThrow();
});
