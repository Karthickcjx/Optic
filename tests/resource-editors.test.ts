import { expect, it } from 'vitest';
import { editedFields, editorValues, resourceEditSchema, supportsEditor } from '../src/shared/resource-editors';
import type { Resource } from '../src/shared/protocol';
it('preserves probes, environment, volume settings and extended resource limits in workload forms', () => {
  const r: Resource = { kind: 'Deployment', metadata: {}, spec: { replicas: 3, selector: { matchLabels: { app: 'web' } }, template: { spec: { volumes: [{ name: 'data', emptyDir: {} }], containers: [{ name: 'app', image: 'old', envFrom: [{ secretRef: { name: 'private' } }], livenessProbe: { httpGet: { path: '/', port: 80 } }, resources: { limits: { 'nvidia.com/gpu': '1' } } }] } } } };
  const changes = editorValues(r); if (changes.type !== 'workload') throw new Error();
  changes.containers[0].image = 'new'; changes.containers[0].resources.requests.cpu = '250m';
  const spec = editedFields(r, changes).value as any;
  expect(spec.template.spec.containers[0]).toMatchObject({ image: 'new', envFrom: r.spec!.template.spec.containers[0].envFrom, livenessProbe: r.spec!.template.spec.containers[0].livenessProbe, resources: { limits: { 'nvidia.com/gpu': '1' }, requests: { cpu: '250m' } } });
  expect(spec.selector).toEqual(r.spec!.selector); expect(spec.template.spec.volumes).toEqual(r.spec!.template.spec.volumes);
  expect(r.spec!.template.spec.containers[0].image).toBe('old');
});
it('does not expose Secrets or unsupported resources as form editors', () => {
  expect(supportsEditor({ kind: 'Secret', metadata: {} })).toBe(false);
  expect(supportsEditor({ kind: 'Service', metadata: {}, spec: { type: 'ExternalName' } })).toBe(false);
  expect(() => editedFields({ kind: 'Secret', metadata: {} }, { type: 'configmap', data: {} })).toThrow();
  expect(resourceEditSchema.safeParse({ type: 'configmap', data: {}, binaryData: {} }).success).toBe(false);
});
it('preserves CronJob Job templates and suspend state when editing schedules', () => {
  const r: Resource = { kind: 'CronJob', metadata: {}, spec: { suspend: true, schedule: '0 * * * *', timeZone: 'Etc/UTC', startingDeadlineSeconds: 30, jobTemplate: { spec: { backoffLimit: 2 } } } };
  const changes = editorValues(r); if (changes.type !== 'cronjob') throw new Error();
  changes.schedule = '*/15 * * * *'; changes.timeZone = '';
  const spec = editedFields(r, changes).value as any;
  expect(spec).toMatchObject({ schedule: '*/15 * * * *', suspend: true, startingDeadlineSeconds: 30, jobTemplate: r.spec!.jobTemplate });
  expect(spec).not.toHaveProperty('timeZone');
});
it('preserves allocated service identity while removing obsolete external ports', () => {
  const r: Resource = { kind: 'Service', metadata: {}, spec: { type: 'LoadBalancer', clusterIP: '10.0.0.1', clusterIPs: ['10.0.0.1'], healthCheckNodePort: 30001, externalTrafficPolicy: 'Local', ports: [{ name: 'web', port: 80, targetPort: 'http', nodePort: 30002, appProtocol: 'http' }] } };
  const changes = editorValues(r); if (changes.type !== 'service') throw new Error();
  changes.serviceType = 'ClusterIP'; changes.ports[0].port = 8080;
  const spec = editedFields(r, changes).value as any;
  expect(spec).toMatchObject({ clusterIP: '10.0.0.1', clusterIPs: ['10.0.0.1'], ports: [{ name: 'web', port: 8080, targetPort: 'http', appProtocol: 'http' }] });
  expect(spec.ports[0]).not.toHaveProperty('nodePort'); expect(spec).not.toHaveProperty('healthCheckNodePort'); expect(spec).not.toHaveProperty('externalTrafficPolicy');
});
