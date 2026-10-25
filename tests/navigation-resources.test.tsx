import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { resourcePath, validateReplacement } from '../src/main/resources';
import { schemas } from '../src/main/validation';
import { ResourceProperties } from '../src/renderer/src/ResourceProperties';
import type { BuiltinKind } from '../src/shared/catalog';

it('routes configuration resources with the correct API group and namespace scope', () => {
  const cases = [
    ['priorityclasses', '/apis/scheduling.k8s.io/v1/priorityclasses'],
    ['runtimeclasses', '/apis/node.k8s.io/v1/runtimeclasses'],
    ['leases', '/apis/coordination.k8s.io/v1/namespaces/team/leases'],
    ['mutatingwebhookconfigurations', '/apis/admissionregistration.k8s.io/v1/mutatingwebhookconfigurations'],
    ['validatingwebhookconfigurations', '/apis/admissionregistration.k8s.io/v1/validatingwebhookconfigurations'],
    ['validatingadmissionpolicies', '/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicies'],
    ['validatingadmissionpolicybindings', '/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicybindings'],
    ['mutatingadmissionpolicies', '/apis/admissionregistration.k8s.io/v1/mutatingadmissionpolicies'],
    ['mutatingadmissionpolicybindings', '/apis/admissionregistration.k8s.io/v1/mutatingadmissionpolicybindings']
  ];
  for (const [kind, path] of cases) {
    const scope = { clusterId: 'c', kind: kind as BuiltinKind, namespace: 'team' };
    expect(schemas['resources:list'].safeParse(scope).success).toBe(true);
    expect(resourcePath(scope)).toBe(path);
  }
});

it('preserves concurrency and identity checks when editing admission policies', () => {
  const target = { clusterId: 'c', kind: 'validatingadmissionpolicies' as const, name: 'require-label' };
  const document = { apiVersion: 'admissionregistration.k8s.io/v1', kind: 'ValidatingAdmissionPolicy', metadata: { name: 'require-label', resourceVersion: '3' } };
  expect(() => validateReplacement(target, document)).not.toThrow();
  expect(() => validateReplacement(target, { ...document, kind: 'ValidatingWebhookConfiguration' })).toThrow();
  expect(() => validateReplacement(target, { ...document, metadata: { name: 'require-label' } })).toThrow();
});

it('renders fields outside spec for runtime and priority classes and webhook configurations', () => {
  for (const [resource, expected] of [
    [{ kind: 'RuntimeClass', metadata: {}, handler: 'sandbox-runtime', overhead: { podFixed: { memory: '64Mi' } } }, ['sandbox-runtime', '64Mi']],
    [{ kind: 'PriorityClass', metadata: {}, value: 10000, description: 'critical-app' }, ['10000', 'critical-app']],
    [{ kind: 'ValidatingWebhookConfiguration', metadata: {}, webhooks: [{ name: 'validate.example.com', failurePolicy: 'Ignore', clientConfig: { service: { name: 'admission-server' } } }] }, ['validate.example.com', 'Ignore', 'admission-server']],
    [{ kind: 'ValidatingAdmissionPolicyBinding', metadata: {}, spec: { policyName: 'require-label', validationActions: ['Deny'] } }, ['require-label', 'Deny']]
  ] as const) {
    const html = renderToStaticMarkup(<ResourceProperties resource={resource}/>);
    for (const value of expected) expect(html).toContain(value);
  }
});
