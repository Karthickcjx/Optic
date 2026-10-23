import { describe, it, expect, vi } from 'vitest';
import { schemas } from '../src/main/validation';
import { resourcePath, validateReplacement } from '../src/main/resources';
import { Streams } from '../src/main/streams';
import { fault } from '../src/main/errors';
import { resourceStatus } from '../src/shared/status';
import { quantity } from '../src/shared/quantities';
import type { Resource, Target } from '../src/shared/protocol';
describe('boundary validation', () => {
  it('rejects traversal names, oversized writes and incomplete pod targets', () => {
    expect(schemas['resources:delete'].safeParse({ clusterId: 'c', kind: 'pods', namespace: 'default', name: '../secrets' }).success).toBe(false);
    expect(schemas['terminal:write'].safeParse({ id: crypto.randomUUID(), data: 'a'.repeat(65537) }).success).toBe(false);
    expect(schemas['terminal:open'].safeParse({ id: crypto.randomUUID(), pod: 'api', cols: 80, rows: 24 }).success).toBe(false);
  });
  it('prevents redirected YAML writes and requires optimistic concurrency', () => {
    const target: Target = { clusterId: 'c', kind: 'pods', name: 'api', namespace: 'default' };
    const document: Resource = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'api', namespace: 'default', resourceVersion: '2' } };
    expect(() => validateReplacement(target, document)).not.toThrow();
    expect(() => validateReplacement(target, { ...document, metadata: { ...document.metadata, name: 'other' } })).toThrow();
    expect(() => validateReplacement(target, { ...document, metadata: { ...document.metadata, resourceVersion: undefined } })).toThrow();
  });
  it('ignores namespace for cluster-scoped resource paths', () => {
    expect(resourcePath({ clusterId: 'c', kind: 'nodes', namespace: 'default' })).toBe('/api/v1/nodes');
    expect(resourcePath({ clusterId: 'c', kind: 'deployments', namespace: 'default' })).toBe('/apis/apps/v1/namespaces/default/deployments');
  });
  it('routes custom resources by served API version and scope', () => {
    const custom = { apiVersion: 'example.io/v1beta1', kind: 'Widget', plural: 'widgets', namespaced: true };
    expect(resourcePath({ clusterId: 'c', kind: 'custom', namespace: 'team', custom })).toBe('/apis/example.io/v1beta1/namespaces/team/widgets');
    expect(resourcePath({ clusterId: 'c', kind: 'custom', namespace: 'team', custom: { ...custom, namespaced: false } })).toBe('/apis/example.io/v1beta1/widgets');
    expect(() => resourcePath({ clusterId: 'c', kind: 'custom' })).toThrow();
    expect(schemas['resources:list'].safeParse({ clusterId: 'c', kind: 'custom', custom: { ...custom, apiVersion: '../v1' } }).success).toBe(false);
  });
  it('rejects unsafe scale values and requires an explicit apply mode', () => {
    const target = { clusterId: 'c', kind: 'deployments', namespace: 'default', name: 'web' };
    for (const replicas of [-1, 1.5, 10001]) expect(schemas['resources:scale'].safeParse({ ...target, replicas }).success).toBe(false);
    expect(schemas['resources:apply'].safeParse({ clusterId: 'c', yaml: 'kind: Pod' }).success).toBe(false);
  });
});
it('converts Kubernetes CPU and memory quantities', () => {
  expect(quantity('500m')).toBe(.5);
  expect(quantity('250000000n')).toBe(.25);
  expect(quantity('2Gi')).toBe(2 * 1024 ** 3);
  expect(quantity('100M')).toBe(100000000);
  expect(quantity(undefined)).toBe(0);
});
describe('stream ownership', () => {
  it('prevents cross-window access and disposes exactly once', () => {
    const streams = new Streams(); const dispose = vi.fn();
    const owner = { id: 1, isDestroyed: () => false, send: vi.fn() } as any;
    streams.add('session', { owner, dispose });
    expect(() => streams.get('session', { id: 2 } as any)).toThrow();
    expect(() => streams.add('session', { owner, dispose })).toThrow();
    streams.closeOwner(owner); streams.closeAll(); expect(dispose).toHaveBeenCalledTimes(1);
    expect(() => streams.get('session', owner)).toThrow();
  });
  it('bounds sessions per renderer', () => {
    const streams = new Streams(); const owner = { id: 1 } as any;
    for (let i = 0; i < 24; i++) streams.add(String(i), { owner, dispose: () => {} });
    expect(() => streams.add('overflow', { owner, dispose: () => {} })).toThrow(); streams.closeAll();
  });
});
it('redacts credential-bearing SDK errors', () => {
  expect(JSON.stringify(fault(new Error('Authorization: Bearer sensitive')))).not.toContain('sensitive');
  expect(fault({ code: 409 }).code).toBe('CONFLICT');
});
it('prioritizes container crashes over pod phase', () => {
  expect(resourceStatus({ metadata: {}, status: { phase: 'Running', containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }] } })).toBe('CrashLoopBackOff');
});
