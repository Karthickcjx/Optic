import { beforeEach, it, expect, vi } from 'vitest';
import { Providers } from '../src/main/providers';
import { kubeJson } from '../src/main/kube-http';
import { defaultClusterSettings } from '../src/shared/cluster-settings';
vi.mock('../src/main/kube-http', () => ({ kubeJson: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
it('queries configured Prometheus through the Kubernetes service proxy and normalizes units', async () => {
  const settings = { ...defaultClusterSettings, prometheus: { namespace: 'monitoring', service: 'prometheus', port: 9090 } };
  const providers = new Providers({ get: () => ({ config: {} }), settings: () => settings } as any);
  vi.mocked(kubeJson).mockResolvedValueOnce({ status: 'success', data: { result: [{ metric: { node: 'worker' }, value: [1, '0.25'] }] } }).mockResolvedValueOnce({ status: 'success', data: { result: [{ metric: { node: 'worker' }, value: [1, '1048576'] }] } });
  const result = await providers.prometheus('c'); expect(result.nodes[0].usage).toEqual({ cpu: '0.25', memory: '1048576' });
  expect(vi.mocked(kubeJson).mock.calls[0][1]).toContain('/api/v1/namespaces/monitoring/services/prometheus%3A9090/proxy/api/v1/query?');
});
it('does not report empty or malformed Prometheus responses as healthy', async () => {
  const providers = new Providers({ get: () => ({ config: {} }), settings: () => ({ ...defaultClusterSettings, prometheus: { namespace: 'm', service: 'p', port: 9090 } }) } as any);
  vi.mocked(kubeJson).mockResolvedValue({ status: 'success', data: { result: [] } });
  await expect(providers.prometheus('c')).rejects.toThrow('No readable Prometheus');
});
it('aggregates cost allocations through the shared report service', async () => {
  const providers = new Providers({ get: () => ({ config: {} }), settings: () => ({ ...defaultClusterSettings, costSource: 'opencost', costEndpoint: { namespace: 'cost', service: 'cost', port: 9003 } }) } as any);
  vi.mocked(kubeJson).mockResolvedValue({ data: [{ team: { totalCost: 2 } }, { team: { totalCost: 3 } }] });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 0, 2));
  try { expect((await providers.cost('c')).total).toBe(5); } finally { clock.mockRestore(); }

});
it('does not issue cost requests when disabled', async () => {
  const providers = new Providers({ get: () => ({ config: {} }), settings: () => ({ ...defaultClusterSettings, costSource: 'off' }) } as any);
  expect((await providers.cost('c')).source).toBe('off'); expect(kubeJson).not.toHaveBeenCalled();
});
