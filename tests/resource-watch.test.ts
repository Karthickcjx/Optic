import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResourceService } from '../src/main/resources';
import { kubeJson } from '../src/main/kube-http';

type Call = { path: string; params: Record<string, unknown>; event: (type: string, object: any) => void; done: (error: unknown) => void; controller: AbortController };
const watches: Call[] = [];
// Connection failures are reported synchronously inside watch(), as @kubernetes/client-node does.
let connectError: unknown;
vi.mock('../src/main/kube-http', () => ({ kubeJson: vi.fn() }));
vi.mock('@kubernetes/client-node', async original => ({
  ...await original<typeof import('@kubernetes/client-node')>(),
  Watch: class {
    async watch(path: string, params: Record<string, unknown>, event: Call['event'], done: Call['done']) {
      const controller = new AbortController();
      if (connectError) { done(connectError); return controller; }
      watches.push({ path, params, event, done, controller });
      return controller;
    }
  }
}));

const pod = (name: string, resourceVersion: string) => ({ metadata: { uid: name, name, namespace: 'default', resourceVersion } });
const listed = (name: string, resourceVersion: string) => ({ apiVersion: 'v1', kind: 'Pod', ...pod(name, resourceVersion) });
const lists = () => vi.mocked(kubeJson).mock.calls.length;
const last = () => watches.at(-1)!;
let stop: () => void, items = vi.fn<(items: unknown[]) => void>(), errors = vi.fn<(error: unknown) => void>();
async function open() {
  stop = new ResourceService({ get: () => ({ config: {} }) } as any).watch({ clusterId: 'c', kind: 'pods', namespace: 'default' }, items, errors);
  await vi.advanceTimersByTimeAsync(150);
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); watches.length = 0; connectError = undefined;
  items = vi.fn<(items: unknown[]) => void>(); errors = vi.fn<(error: unknown) => void>();
  vi.mocked(kubeJson).mockResolvedValue({ items: [pod('a', '10')], metadata: { resourceVersion: '10' } });
});
afterEach(() => { stop?.(); vi.useRealTimers(); });

describe('resource watch resilience', () => {
  it('asks the server to end quiet watches before the 30 s client inactivity timeout', async () => {
    await open();
    expect(lists()).toBe(1);
    expect(last().params).toMatchObject({ resourceVersion: '10', allowWatchBookmarks: true, timeoutSeconds: 25 });
    expect(Number(last().params.timeoutSeconds)).toBeLessThan(30);
    expect(items).toHaveBeenCalledWith([listed('a', '10')]);
  });
  it('resumes from the last seen or bookmark version after a normal close, without LIST or error', async () => {
    await open();
    last().event('MODIFIED', pod('a', '11'));
    last().event('BOOKMARK', { metadata: { resourceVersion: '15' } });
    await vi.advanceTimersByTimeAsync(25000);
    last().done(null);
    await vi.advanceTimersByTimeAsync(10);
    expect(watches).toHaveLength(2);
    expect(last().params.resourceVersion).toBe('15');
    expect(lists()).toBe(1);
    expect(errors).not.toHaveBeenCalled();
  });
  it('silently reconnects after an isolated client inactivity timeout', async () => {
    await open();
    for (let i = 0; i < 3; i++) {
      last().done(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(watches).toHaveLength(4);
    expect(watches.every(w => w.params.resourceVersion === '10')).toBe(true);
    expect(lists()).toBe(1);
    expect(errors).not.toHaveBeenCalled();
  });
  it('reports repeated watch failures and clears the error once reconnected', async () => {
    await open();
    connectError = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    last().done(connectError);
    await vi.advanceTimersByTimeAsync(2000);
    expect(errors).toHaveBeenCalledTimes(1);
    connectError = undefined; items.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(watches).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(150);
    expect(items).toHaveBeenCalledWith([listed('a', '10')]);
    expect(lists()).toBe(1);
  });
  it('re-lists only when the resume version has expired (410 event or status)', async () => {
    await open();
    vi.mocked(kubeJson).mockResolvedValue({ items: [pod('b', '20')], metadata: { resourceVersion: '20' } });
    last().event('ERROR', { kind: 'Status', code: 410, reason: 'Expired' });
    await vi.advanceTimersByTimeAsync(150);
    expect(watches[0].controller.signal.aborted).toBe(true);
    expect(lists()).toBe(2);
    expect(last().params.resourceVersion).toBe('20');
    expect(items).toHaveBeenLastCalledWith([listed('b', '20')]);
    last().done(Object.assign(new Error('Gone'), { statusCode: 410 }));
    await vi.advanceTimersByTimeAsync(150);
    expect(lists()).toBe(3);
    expect(errors).not.toHaveBeenCalled();
  });
  it('reports a non-410 watch error event once it repeats', async () => {
    await open();
    last().event('ERROR', { kind: 'Status', code: 500 });
    expect(errors).not.toHaveBeenCalled();
    connectError = Object.assign(new Error('Internal'), { statusCode: 500 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0][0]).toMatchObject({ statusCode: 500 });
  });
  it('treats an error event followed by a successful reconnect as recovered', async () => {
    await open();
    last().event('ERROR', { kind: 'Status', code: 500 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(watches).toHaveLength(2);
    expect(watches[0].controller.signal.aborted).toBe(true);
    expect(errors).not.toHaveBeenCalled();
  });
  it('reports LIST failures immediately', async () => {
    vi.mocked(kubeJson).mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { statusCode: 403 }));
    await open();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(watches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(watches).toHaveLength(1);
    expect(items).toHaveBeenCalledWith([listed('a', '10')]);
  });
  it('stops all activity when disposed', async () => {
    await open();
    stop();
    expect(last().controller.signal.aborted).toBe(true);
    last().done(null);
    await vi.advanceTimersByTimeAsync(60000);
    expect(watches).toHaveLength(1);
    expect(lists()).toBe(1);
  });
});
