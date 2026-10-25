import { beforeEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { ResourceActions, drainArgs, drainFailure } from '../src/main/resource-actions';
import { kubeJson } from '../src/main/kube-http';
import { schemas } from '../src/main/validation';
import type { ActionTarget } from '../src/shared/resource-actions';
import type { Resource } from '../src/shared/protocol';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('../src/main/kube-http', () => ({ kubeJson: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
const target: ActionTarget = { clusterId: 'cluster', kind: 'deployments', namespace: 'team', name: 'web', uid: 'dep-uid', resourceVersion: '10' };
const deployment: Resource = { kind: 'Deployment', apiVersion: 'apps/v1', metadata: { name: 'web', namespace: 'team', uid: 'dep-uid', resourceVersion: '10', annotations: { 'deployment.kubernetes.io/revision': '2' } }, spec: { replicas: 4, template: { spec: { containers: [{ name: 'app', image: 'new' }] } } } };
const revision: Resource = { kind: 'ReplicaSet', metadata: { name: 'web-old', namespace: 'team', uid: 'rs-old', annotations: { 'deployment.kubernetes.io/revision': '1' }, ownerReferences: [{ kind: 'Deployment', uid: 'dep-uid', controller: true }] }, spec: { template: { metadata: { labels: { app: 'web', 'pod-template-hash': 'old-hash' } }, spec: { containers: [{ name: 'app', image: 'old', env: [{ name: 'KEEP', value: 'yes' }] }] } } } };
function setup(resource: Resource = structuredClone(deployment), items: Resource[] = [structuredClone(revision)]) {
  const resources = { get: vi.fn(async () => resource), list: vi.fn(async () => items) };
  const cleanup = vi.fn();
  const clusters = { get: () => ({ config: {}, cluster: { name: 'selected-context' } }), cliConfig: () => ({ path: 'C:/private path/config', cleanup }) };
  return { actions: new ResourceActions(clusters as any, resources as any), resources, cleanup };
}
it('rolls back only an owned retained template and preserves unrelated deployment fields', async () => {
  const { actions } = setup();
  expect(await actions.revisions(target)).toEqual([{ revision: 1, uid: 'rs-old', name: 'web-old', images: ['old'], current: false }]);
  await actions.rollback(target, 1, 'rs-old');
  const options = vi.mocked(kubeJson).mock.calls[0][2]!;
  expect(options.contentType).toBe('application/json-patch+json');
  const body = options.body as any[];
  expect(body.slice(0, 2)).toEqual([{ op: 'test', path: '/metadata/uid', value: 'dep-uid' }, { op: 'test', path: '/metadata/resourceVersion', value: '10' }]);
  expect(body[2]).toMatchObject({ path: '/spec/template', value: { metadata: { labels: { app: 'web' } }, spec: { containers: [{ image: 'old', env: [{ name: 'KEEP', value: 'yes' }] }] } } });
  expect(body[2].value.metadata.labels).not.toHaveProperty('pod-template-hash');
  expect(body.some(op => op.path === '/spec/replicas')).toBe(false);
  expect(revision.spec!.template.metadata.labels['pod-template-hash']).toBe('old-hash');
});
it('rejects stale identities, paused deployments and revisions belonging to another owner', async () => {
  await expect(setup().actions.rollback({ ...target, resourceVersion: '9' }, 1, 'rs-old')).rejects.toThrow('changed since review');
  await expect(setup({ ...deployment, spec: { ...deployment.spec, paused: true } }).actions.rollback(target, 1, 'rs-old')).rejects.toThrow('Resume');
  const foreign = structuredClone(revision); foreign.metadata.ownerReferences = [{ uid: 'different-deployment', controller: true }];
  await expect(setup(deployment, [foreign]).actions.rollback(target, 1, 'rs-old')).rejects.toThrow('no longer available');
  expect(kubeJson).not.toHaveBeenCalled();
});
it('turns a resourceVersion race during JSON patch into a conflict', async () => {
  const { actions, resources } = setup();
  resources.get.mockResolvedValueOnce(deployment).mockResolvedValueOnce({ ...deployment, metadata: { ...deployment.metadata, resourceVersion: '11' } });
  vi.mocked(kubeJson).mockRejectedValueOnce({ statusCode: 422 });
  await expect(actions.rollback(target, 1, 'rs-old')).rejects.toMatchObject({ code: 'CONFLICT' });
});
const cronjob: Resource = { kind: 'CronJob', metadata: { name: 'backup', uid: 'cron-uid', resourceVersion: '4', namespace: 'team' }, spec: { suspend: true, schedule: '0 * * * *', concurrencyPolicy: 'Forbid', jobTemplate: { metadata: { labels: { app: 'backup' } }, spec: { backoffLimit: 2, template: { spec: { restartPolicy: 'Never', containers: [{ name: 'backup', image: 'busybox', args: ['true'] }] } } } } } };
const cronTarget: ActionTarget = { ...target, kind: 'cronjobs', name: 'backup', uid: 'cron-uid', resourceVersion: '4' };
it('creates one named Job from a suspended CronJob without changing its schedule or template', async () => {
  const { actions } = setup(cronjob);
  await expect(actions.trigger(cronTarget, 'backup-manual')).resolves.toContain('created');
  const [, path, request] = vi.mocked(kubeJson).mock.calls[0];
  expect(path).toBe('/apis/batch/v1/namespaces/team/jobs'); expect(request!.method).toBe('POST');
  expect(request!.body).toMatchObject({ apiVersion: 'batch/v1', kind: 'Job', metadata: { name: 'backup-manual', namespace: 'team', labels: { app: 'backup' }, ownerReferences: [{ uid: 'cron-uid', kind: 'CronJob' }] }, spec: cronjob.spec!.jobTemplate.spec });
  expect((request!.body as any).spec).not.toHaveProperty('schedule');
  vi.mocked(kubeJson).mockRejectedValueOnce({ statusCode: 409 });
  await expect(actions.trigger(cronTarget, 'backup-manual')).rejects.toThrow('already exists');
});
it('suspends/resumes future CronJob runs using a guarded narrow patch', async () => {
  const { actions } = setup(cronjob);
  await actions.suspend(cronTarget, false);
  expect((vi.mocked(kubeJson).mock.calls[0][2]!.body as any[]).at(-1)).toEqual({ op: 'add', path: '/spec/suspend', value: false });
});
const nodeTarget: ActionTarget = { ...target, kind: 'nodes', name: 'worker', namespace: undefined, uid: 'node-uid' };
const node: Resource = { kind: 'Node', metadata: { name: 'worker', uid: 'node-uid', resourceVersion: '10' } };
const drainOptions = { ignoreDaemonSets: true, deleteEmptyDirData: false, force: false, timeoutSeconds: 300 };
it('keeps drain budget protections and destructive options opt-in', () => {
  const args = drainArgs('private config', 'context', 'worker', drainOptions);
  expect(args).toEqual(['--kubeconfig', 'private config', '--context', 'context', 'drain', 'worker', '--timeout=300s', '--grace-period=-1', '--ignore-daemonsets']);
  expect(args).not.toContain('--disable-eviction'); expect(args).not.toContain('--force'); expect(args).not.toContain('--delete-emptydir-data');
  expect(schemas['nodes:drain'].safeParse({ ...nodeTarget, options: { ...drainOptions, timeoutSeconds: 0 } }).success).toBe(false);
  expect(schemas['cronjobs:trigger'].safeParse({ ...cronTarget, jobName: '--bad;command' }).success).toBe(false);
});
it('refuses drain when eviction is unavailable or node identity changed', async () => {
  const { actions } = setup(node);
  await expect(actions.drain({ ...nodeTarget, uid: 'other' }, drainOptions)).rejects.toThrow('identity changed');
  vi.mocked(kubeJson).mockResolvedValue({ resources: [] });
  await expect(actions.drain(nodeTarget, drainOptions)).rejects.toThrow('will not bypass');
  expect(execFile).not.toHaveBeenCalled();
});
it('scopes drain, prevents duplicates, cleans private config and releases the lock on failure', async () => {
  const { actions, cleanup } = setup(node);
  vi.mocked(kubeJson).mockResolvedValue({ resources: [{ name: 'pods/eviction', verbs: ['create'] }] });
  let finish!: (...args: any[]) => void;
  vi.mocked(execFile).mockImplementation((...args: any[]) => { finish = args.at(-1); return { kill: vi.fn() } as any; });
  const running = actions.drain(nodeTarget, drainOptions);
  await vi.waitFor(() => expect(execFile).toHaveBeenCalled());
  expect(execFile).toHaveBeenCalledWith('kubectl', expect.arrayContaining(['--context', 'selected-context']), expect.objectContaining({ shell: false, windowsHide: true }), expect.any(Function));
  await expect(actions.drain(nodeTarget, drainOptions)).rejects.toThrow('already running');
  finish({ code: 1 }, '', 'Cannot evict pod as it would violate the disruption budget secret-value');
  await expect(running).rejects.toThrow('PodDisruptionBudget');
  expect(cleanup).toHaveBeenCalledOnce(); expect(actions.isBusy('cluster')).toBe(false);
  expect(drainFailure({ code: 1 }, 'secret-value')).not.toContain('secret-value');
});
it('validates editors using dry-run and never silently overwrites a newer object', async () => {
  const config: Resource = { kind: 'ConfigMap', metadata: { name: 'settings', namespace: 'team', uid: 'cm', resourceVersion: '8' }, data: { keep: 'value', remove: 'old' }, binaryData: { keep: 'AA==' } };
  const { actions } = setup(config);
  const input: ActionTarget = { ...target, kind: 'configmaps', name: 'settings', uid: 'cm', resourceVersion: '8' };
  await actions.edit(input, { type: 'configmap', data: { keep: 'new' } }, true);
  expect(vi.mocked(kubeJson).mock.calls[0][1]).toMatch(/configmaps\/settings\?dryRun=All$/);
  expect((vi.mocked(kubeJson).mock.calls[0][2]!.body as any[]).at(-1)).toEqual({ op: 'add', path: '/data', value: { keep: 'new' } });
  await expect(actions.edit({ ...input, resourceVersion: '7' }, { type: 'configmap', data: {} }, false)).rejects.toThrow('changed since review');
  expect(kubeJson).toHaveBeenCalledTimes(1);
});
