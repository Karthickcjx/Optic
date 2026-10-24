import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { catalog, type BuiltinKind } from '../src/shared/catalog';
import { manifestTemplate } from '../src/shared/manifest-templates';

it('provides parseable templates with matching kind, API version and scope for every resource', () => {
  for (const [kind, descriptor] of Object.entries(catalog)) {
    const document = parse(manifestTemplate(kind as BuiltinKind, 'team-a'));
    expect(document.apiVersion).toBe(descriptor.apiVersion);
    expect(document.kind).toBe(descriptor.kind);
    expect(document.metadata.name).toBeTruthy();
    expect(document.metadata.namespace).toBe(descriptor.namespaced ? 'team-a' : undefined);
  }
});

it('provides workload containers and consistent selectors rather than ConfigMap data', () => {
  const pod = parse(manifestTemplate('pods', 'team-b'));
  expect(pod.spec.containers[0].image).toBeTruthy();
  expect(pod.data).toBeUndefined();
  for (const kind of ['deployments', 'daemonsets', 'statefulsets', 'replicasets'] as const) {
    const { spec } = parse(manifestTemplate(kind));
    expect(spec.selector.matchLabels).toEqual(spec.template.metadata.labels);
    expect(spec.template.spec.containers).toHaveLength(1);
  }
  expect(parse(manifestTemplate('cronjobs')).spec.jobTemplate.spec.template.spec.restartPolicy).toBe('Never');
});

it('uses custom API identity and does not guess schema requirements', () => {
  const custom = { kind: 'Widget', apiVersion: 'example.com/v2', plural: 'widgets', namespaced: true };
  expect(parse(manifestTemplate('custom', 'team', custom))).toMatchObject({ apiVersion: 'example.com/v2', kind: 'Widget', metadata: { namespace: 'team' }, spec: {} });
  expect(parse(manifestTemplate('custom', 'team', { ...custom, namespaced: false })).metadata.namespace).toBeUndefined();
  expect(parse(manifestTemplate('custom'))).toBeNull();
});

it('keeps namespace references on cluster-scoped RBAC subjects without adding metadata namespace', () => {
  const binding = parse(manifestTemplate('clusterrolebindings', 'team-c'));
  expect(binding.metadata.namespace).toBeUndefined();
  expect(binding.subjects[0].namespace).toBe('team-c');
  expect(binding.roleRef.kind).toBe('ClusterRole');
});
