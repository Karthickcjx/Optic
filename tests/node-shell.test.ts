import { it, expect, vi, beforeEach } from 'vitest';
import { NodeShell, nodeShellManifest } from '../src/main/node-shell';
import { Streams } from '../src/main/streams';
import { kubeJson } from '../src/main/kube-http';
import { defaultClusterSettings } from '../src/shared/cluster-settings';
import { monitoringArgs } from '../src/main/monitoring';
vi.mock('../src/main/kube-http', () => ({ kubeJson: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
it('creates bounded node helpers without service-account credentials', () => {
  const pod = nodeShellManifest('worker', 'optic-test', 'alpine:3.21', 'private-registry');
  expect(pod.spec.automountServiceAccountToken).toBe(false); expect(pod.spec.activeDeadlineSeconds).toBe(3600);
  expect(pod.spec.hostPID).toBe(true); expect(pod.spec.nodeName).toBe('worker'); expect(pod.spec.imagePullSecrets).toEqual([{ name: 'private-registry' }]);
});
it('deletes the exact helper UID after terminal closure', async () => {
  const streams = new Streams(); let close: (() => void) | undefined;
  const sessions = { terminal: vi.fn(async (_owner, _options, onClosed) => { close = onClosed; }) };
  const service = new NodeShell({ get: () => ({ config: {} }), settings: () => defaultClusterSettings } as any, streams, sessions as any);
  vi.mocked(kubeJson).mockResolvedValueOnce({ metadata: { uid: 'helper-uid' } }).mockResolvedValueOnce({ status: { phase: 'Running' } }).mockResolvedValue({});
  await service.open({ id: 1, isDestroyed: () => false, send: vi.fn() } as any, { id: crypto.randomUUID(), clusterId: 'c', node: 'worker', cols: 80, rows: 24 });
  expect(sessions.terminal).toHaveBeenCalled(); close!();
  await vi.waitFor(() => expect(vi.mocked(kubeJson).mock.calls.at(-1)?.[2]?.body).toMatchObject({ preconditions: { uid: 'helper-uid' } }));
});
it('builds pinned opt-in monitoring commands scoped to Optic releases', () => {
  const args = monitoringArgs({ component: 'prometheus', action: 'install', version: '27.0.0' });
  expect(args).toContain('optic-prometheus'); expect(args).toContain('27.0.0'); expect(args).toContain('optic-monitoring');
  expect(args.join(' ')).toContain('kube-state-metrics.enabled=false');
  expect(monitoringArgs({ component: 'prometheus-node-exporter', action: 'uninstall', version: '' })).toContain('optic-prometheus-node-exporter');
});
