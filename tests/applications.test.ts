import { expect, it } from 'vitest';
import { groupApplications } from '../src/shared/applications';

it('keeps application instances and namespaces separate and skips unlabelled resources', () => {
  const resource = (namespace: string, labels: Record<string, string>) => ({ metadata: { namespace, labels } });
  const groups = groupApplications([
    resource('a', { 'app.kubernetes.io/name': 'web', 'app.kubernetes.io/instance': 'blue' }),
    resource('a', { 'app.kubernetes.io/instance': 'blue' }),
    resource('a', { 'app.kubernetes.io/name': 'web', 'app.kubernetes.io/instance': 'green' }),
    resource('b', { 'app.kubernetes.io/instance': 'blue' }),
    resource('a', {}),
  ]);
  expect(groups).toHaveLength(3);
  expect(groups.find(group => group.name === 'blue' && group.namespace === 'a')?.resources).toHaveLength(2);
  expect(groups.find(group => group.name === 'blue' && group.namespace === 'b')?.resources).toHaveLength(1);
});
