import { beforeEach, expect, it, vi } from 'vitest';
import { ResourceService } from '../src/main/resources';
import { kubeJson } from '../src/main/kube-http';
vi.mock('../src/main/kube-http', () => ({ kubeJson: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
const scope = { clusterId: 'c', kind: 'mutatingadmissionpolicies' as const };
function setup() { const config = {}; return new ResourceService({ get: () => ({ config }) } as any); }
const discovery = { resources: [{ name: 'mutatingadmissionpolicies', kind: 'MutatingAdmissionPolicy' }] };
it('uses the stable served API for list, read, YAML, replace and delete', async () => {
  const service = setup();
  const resource = { apiVersion: 'admissionregistration.k8s.io/v1', kind: 'MutatingAdmissionPolicy', metadata: { name: 'policy', resourceVersion: '4' } };
  vi.mocked(kubeJson).mockImplementation(async (_config, path) => path === '/apis/admissionregistration.k8s.io/v1' ? discovery : path.includes('?limit') ? { items: [resource] } : resource);
  expect((await service.list(scope))[0].apiVersion).toBe(resource.apiVersion);
  const target = { ...scope, name: 'policy' };
  expect((await service.get(target)).kind).toBe('MutatingAdmissionPolicy');
  const yaml = await service.yaml(target);
  await service.replace(target, yaml); await service.delete(target);
  expect(vi.mocked(kubeJson).mock.calls.every(([, path]) => !path.includes('v1beta1'))).toBe(true);
  expect(vi.mocked(kubeJson).mock.calls.filter(([, path]) => path === '/apis/admissionregistration.k8s.io/v1')).toHaveLength(1);
});
it('falls back when the kind is absent from stable discovery and preserves beta identity', async () => {
  const service = setup();
  vi.mocked(kubeJson).mockResolvedValueOnce({ resources: [] }).mockResolvedValueOnce(discovery).mockResolvedValueOnce({ items: [{ metadata: { name: 'policy' } }] });
  expect((await service.list(scope))[0].apiVersion).toBe('admissionregistration.k8s.io/v1beta1');
  expect(vi.mocked(kubeJson).mock.calls[2][1]).toContain('/v1beta1/mutatingadmissionpolicies?');
});
it('does not hide permission failures or silently cache unavailable APIs', async () => {
  const service = setup();
  vi.mocked(kubeJson).mockRejectedValueOnce({ statusCode: 403 });
  await expect(service.list(scope)).rejects.toMatchObject({ statusCode: 403 });
  expect(kubeJson).toHaveBeenCalledTimes(1);
  vi.mocked(kubeJson).mockRejectedValue({ statusCode: 404 });
  await expect(service.list(scope)).rejects.toThrow('does not serve');
});
