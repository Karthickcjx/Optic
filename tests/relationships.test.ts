import { expect, it } from 'vitest';
import { deploymentRevisions, relatedPods, resourceKind } from '../src/shared/relationships';
import type { Resource } from '../src/shared/protocol';
const deployment: Resource = { kind: 'Deployment', metadata: { name: 'web', namespace: 'team', uid: 'deploy' } };
const rs = (uid: string, revision: string): Resource => ({ kind: 'ReplicaSet', metadata: { uid, namespace: 'team', annotations: { 'deployment.kubernetes.io/revision': revision }, ownerReferences: [{ uid: 'deploy', controller: true }] } });
const pod: Resource = { kind: 'Pod', metadata: { uid: 'pod', namespace: 'team', labels: { app: 'web' }, ownerReferences: [{ uid: 'rs', controller: true }] } };
it('joins deployment Pods through owner UIDs and excludes unrelated or cross-namespace Pods', () => {
  expect(relatedPods(deployment, [pod, { ...pod, metadata: { ...pod.metadata, namespace: 'other' } }, { ...pod, metadata: { ...pod.metadata, ownerReferences: [{ uid: 'unrelated' }] } }], [rs('rs', '1')])).toEqual([pod]);
  expect(relatedPods({ ...deployment, metadata: { ...deployment.metadata, uid: 'recreated' } }, [pod], [rs('rs', '1')])).toEqual([]);
});
it('sorts retained deployment revisions numerically', () => {
  expect(deploymentRevisions(deployment, [rs('one', '1'), rs('ten', '10'), rs('two', '2')]).map(r => r.metadata.uid)).toEqual(['ten', 'two', 'one']);
});
it('does not match all Pods for selectorless Services and respects selector values', () => {
  const service: Resource = { kind: 'Service', metadata: { namespace: 'team' }, spec: {} };
  expect(relatedPods(service, [pod])).toEqual([]);
  expect(relatedPods({ ...service, spec: { selector: { app: 'web' } } }, [pod])).toEqual([pod]);
  expect(resourceKind({ kind: 'ReplicaSet', apiVersion: 'apps/v1' })).toBe('replicasets');
  expect(resourceKind({ kind: 'ReplicaSet', apiVersion: 'unknown/v1' })).toBeUndefined();
});
