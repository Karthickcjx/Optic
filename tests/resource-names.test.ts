import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schemas } from '../src/main/validation';
import { ResourceService } from '../src/main/resources';
import { kubeJson } from '../src/main/kube-http';
vi.mock('../src/main/kube-http', () => ({ kubeJson: vi.fn() }));
beforeEach(() => { vi.clearAllMocks(); });

const rbacNames = [
  { kind: 'clusterroles', name: 'system:controller:attachdetach-controller' },
  { kind: 'clusterroles', name: 'eks:podsecuritypolicy:privileged' },
  { kind: 'clusterrolebindings', name: 'system:node-proxier' },
  { kind: 'clusterrolebindings', name: 'eks:addon-cluster-admin' },
  { kind: 'roles', name: 'system:controller:bootstrap-signer', namespace: 'kube-system' },
  { kind: 'rolebindings', name: 'eks:addon-manager', namespace: 'kube-system' }
] as const;
// Every channel whose input is the shared resource target (directly or by extension).
const targetChannels = ['resources:get', 'resources:yaml', 'resources:delete', 'resources:restart'] as const;
const valid = (channel: keyof typeof schemas, input: object) => schemas[channel].safeParse({ clusterId: 'c', ...input }).success;

describe('resource name validation', () => {
  it('accepts system:* and eks:* RBAC names on every resource target channel', () => {
    for (const resource of rbacNames) {
      for (const channel of targetChannels) expect(valid(channel, resource), `${channel} ${resource.name}`).toBe(true);
      expect(valid('resources:replace', { ...resource, yaml: 'kind: ClusterRole' })).toBe(true);
    }
  });
  it('rejects RBAC names that Kubernetes path-segment validation forbids', () => {
    for (const name of ['', '.', '..', 'system/controller', 'system%3Acontroller', 'system:\ncontroller', 'tab\tname', 'x'.repeat(254)]) {
      for (const channel of targetChannels) expect(valid(channel, { kind: 'clusterroles', name }), `${channel} ${JSON.stringify(name)}`).toBe(false);
    }
  });
  it('keeps the existing name rules for non-RBAC kinds', () => {
    for (const channel of ['resources:yaml', 'resources:delete', 'resources:restart'] as const) {
      expect(valid(channel, { kind: 'configmaps', namespace: 'default', name: 'app.config-1' })).toBe(true);
      expect(valid(channel, { kind: 'configmaps', namespace: 'default', name: 'system:app' })).toBe(false);
      expect(valid(channel, { kind: 'configmaps', namespace: 'default', name: '-flag' })).toBe(false);
      expect(valid(channel, { kind: 'configmaps', namespace: 'default', name: '../secrets' })).toBe(false);
    }
    expect(valid('resources:scale', { kind: 'deployments', namespace: 'default', name: 'web:1', replicas: 1 })).toBe(false);
    expect(valid('nodes:drain-preview', { kind: 'nodes', name: 'node:1' })).toBe(false);
    expect(valid('nodes:drain-preview', { kind: 'nodes', name: 'ip-10-0-0-1.ec2.internal' })).toBe(true);
    // resources:get previously accepted colons for every kind; that behaviour is preserved.
    expect(valid('resources:get', { kind: 'configmaps', namespace: 'default', name: 'system:app' })).toBe(true);
    expect(valid('resources:get', { kind: 'configmaps', namespace: 'default', name: '-flag' })).toBe(false);
  });
  it('applies the kind-specific rule to schemas derived from the target', () => {
    expect(valid('deployments:revisions', { kind: 'deployments', namespace: 'default', name: 'system:web' })).toBe(false);
    expect(valid('resources:edit', { kind: 'configmaps', namespace: 'default', name: 'system:app', uid: 'u', resourceVersion: '1', changes: { type: 'configmap', data: {} }, dryRun: true })).toBe(false);
    expect(valid('metrics:resource', { kind: 'pods', namespace: 'default', name: 'api:1', uid: 'u', minutes: 15 })).toBe(false);
  });
  it('URL-encodes colon names when calling the Kubernetes API', async () => {
    vi.mocked(kubeJson).mockResolvedValue({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: 'system:controller:test' } });
    const service = new ResourceService({ get: () => ({ config: {} }) } as any);
    await service.yaml({ clusterId: 'c', kind: 'clusterroles', name: 'system:controller:test' });
    await service.delete({ clusterId: 'c', kind: 'rolebindings', namespace: 'kube-system', name: 'eks:addon-manager' });
    expect(vi.mocked(kubeJson).mock.calls[0][1]).toBe('/apis/rbac.authorization.k8s.io/v1/clusterroles/system%3Acontroller%3Atest');
    expect(vi.mocked(kubeJson).mock.calls[1][1]).toBe('/apis/rbac.authorization.k8s.io/v1/namespaces/kube-system/rolebindings/eks%3Aaddon-manager');
  });
});
