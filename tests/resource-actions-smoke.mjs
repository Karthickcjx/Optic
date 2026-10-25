import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import assert from 'node:assert/strict';

const temp = await mkdtemp(join(tmpdir(), 'optic-actions-smoke-'));
const sockets = new Set(), requests = [];
const meta = (name, uid, extra = {}) => ({ name, uid, namespace: 'default', resourceVersion: '10', ...extra });
const deployment = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: meta('web', 'dep', { annotations: { 'deployment.kubernetes.io/revision': '2' } }), spec: { replicas: 2, selector: { matchLabels: { app: 'web' } }, template: { metadata: { labels: { app: 'web' } }, spec: { containers: [{ name: 'app', image: 'example/web:2', env: [{ name: 'PRESERVED', value: 'yes' }] }] } } } };
const rs = (revision, image) => ({ apiVersion: 'apps/v1', kind: 'ReplicaSet', metadata: meta(`web-${revision}`, `rs-${revision}`, { annotations: { 'deployment.kubernetes.io/revision': String(revision) }, ownerReferences: [{ kind: 'Deployment', uid: 'dep', controller: true }] }), spec: { template: { metadata: { labels: { app: 'web', 'pod-template-hash': String(revision) } }, spec: { containers: [{ name: 'app', image }] } } } });
const cronjob = { apiVersion: 'batch/v1', kind: 'CronJob', metadata: meta('backup', 'cron'), spec: { schedule: '0 * * * *', suspend: false, concurrencyPolicy: 'Forbid', jobTemplate: { spec: { backoffLimit: 1, template: { spec: { restartPolicy: 'Never', containers: [{ name: 'job', image: 'busybox', command: ['true'] }] } } } } } };
const configmap = { apiVersion: 'v1', kind: 'ConfigMap', metadata: meta('settings', 'cm'), data: { color: 'blue', remove: 'old' }, binaryData: { keep: 'AA==' } };
const service = { apiVersion: 'v1', kind: 'Service', metadata: meta('web', 'svc'), spec: { type: 'ClusterIP', clusterIP: '10.0.0.1', selector: { app: 'web' }, ports: [{ name: 'http', port: 80, targetPort: 8080 }] } };
const node = { apiVersion: 'v1', kind: 'Node', metadata: { name: 'worker', uid: 'node', resourceVersion: '10' }, spec: {}, status: { conditions: [{ type: 'Ready', status: 'True' }] } };
const pod = { apiVersion: 'v1', kind: 'Pod', metadata: meta('standalone', 'pod'), spec: { nodeName: 'worker', volumes: [{ name: 'cache', emptyDir: {} }], containers: [{ name: 'app', image: 'busybox' }] }, status: { phase: 'Running' } };
const resources = { deployments: [deployment], replicasets: [rs(1, 'example/web:1'), rs(2, 'example/web:2')], cronjobs: [cronjob], configmaps: [configmap], services: [service], nodes: [node], pods: [pod], jobs: [], namespaces: [{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'default', uid: 'namespace' } }] };
function send(res, data, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.searchParams.has('watch')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.flushHeaders(); return; }
  if (url.pathname === '/version') return send(res, { gitVersion: 'v1.36.0-test' });
  const segments = url.pathname.split('/'), name = segments.at(-1), collection = segments.at(-2);
  const list = resources[name], item = resources[collection]?.find(r => r.metadata.name === name);
  let body = ''; for await (const chunk of req) body += chunk;
  const input = body ? JSON.parse(body) : undefined;
  requests.push({ method: req.method, path: url.pathname, query: url.search, input });
  if (req.method === 'PATCH' && item && Array.isArray(input)) {
    const copy = structuredClone(item);
    for (const op of input) {
      const parts = op.path.slice(1).split('/'); let parent = copy;
      for (const part of parts.slice(0, -1)) parent = parent[part];
      const key = parts.at(-1);
      if (op.op === 'test' && parent[key] !== op.value) return send(res, { message: 'precondition failed' }, 422);
      if (op.op === 'add') parent[key] = op.value;
    }
    if (!url.searchParams.has('dryRun')) { copy.metadata.resourceVersion = String(Number(copy.metadata.resourceVersion) + 1); Object.assign(item, copy); }
    return send(res, copy);
  }
  if (req.method === 'POST' && name === 'jobs') {
    if (resources.jobs.some(j => j.metadata.name === input.metadata.name)) return send(res, {}, 409);
    input.metadata.uid = `job-${resources.jobs.length}`; input.metadata.resourceVersion = '1'; resources.jobs.push(input); return send(res, input, 201);
  }
  if (item) return send(res, item);
  return send(res, { apiVersion: 'v1', kind: 'List', metadata: { resourceVersion: '10' }, items: list ?? [] });
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const config = join(temp, 'config');
await writeFile(config, `apiVersion: v1\nkind: Config\nclusters:\n- name: test\n  cluster:\n    insecure-skip-tls-verify: true\n    server: http://127.0.0.1:${server.address().port}\nusers:\n- name: test\n  user: {}\ncontexts:\n- name: action-tests\n  context:\n    cluster: test\n    user: test\ncurrent-context: action-tests\n`);
let app;
try {
  const env = { ...process.env, WORKBENCH_KUBECONFIG: config }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ ...(env.WORKBENCH_TEST_EXECUTABLE ? { executablePath: env.WORKBENCH_TEST_EXECUTABLE } : {}), args: [...(env.WORKBENCH_TEST_EXECUTABLE ? [] : ['.']), `--user-data-dir=${join(temp, 'profile')}`], env });
  const page = await app.firstWindow(), errors = []; page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  const capture = async name => { await mkdir('artifacts/resource-actions', { recursive: true }); await page.screenshot({ path: `artifacts/resource-actions/${name}.png` }); };
  const open = async (kind, name) => {
    await page.getByLabel('Find in Navigator', { exact: true }).fill(kind);
    await page.locator('.navigator').getByRole('button', { name: kind, exact: true }).click();
    await page.locator('tbody .resource-name').filter({ hasText: new RegExp(`^${name}$`) }).click();
    await expect(page.locator('.details h2')).toHaveText(name);
  };
  const done = async () => { await expect(page.locator('.resource-notification.running')).toHaveCount(0); while (await page.locator('.resource-notification button[aria-label^="Dismiss"]').count()) await page.locator('.resource-notification button[aria-label^="Dismiss"]').first().click(); };
  await open('Deployments', 'web');
  await page.getByRole('button', { name: 'Rollback', exact: true }).click();
  await expect(page.getByLabel('Rollback revision')).toHaveValue('rs-1'); await capture('01-deployment-rollback');
  await page.getByRole('button', { name: 'Confirm roll back deployment', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.resource-notification.succeeded')).toContainText('revision 1 submitted');
  assert.equal(deployment.spec.template.spec.containers[0].image, 'example/web:1'); assert.equal(deployment.spec.replicas, 2);
  await done();

  await open('Cron Jobs', 'backup');
  await page.getByRole('button', { name: 'Suspend', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm suspend cronjob', exact: true }).click();
  await expect(page.locator('.resource-notification.succeeded')).toContainText('Already running Jobs are unchanged'); await done();
  assert.equal(cronjob.spec.suspend, true);
  await page.getByRole('button', { name: 'Run now', exact: true }).click();
  await page.getByLabel('Manual Job name').fill('backup-manual-test'); await capture('02-cronjob-run');
  await page.getByRole('button', { name: 'Confirm run cronjob now', exact: true }).click();
  await expect(page.locator('.resource-notification.succeeded')).toContainText('backup-manual-test created'); await done();
  assert.equal(resources.jobs[0].metadata.ownerReferences[0].uid, 'cron'); assert.deepEqual(resources.jobs[0].spec, cronjob.spec.jobTemplate.spec);
  await page.getByRole('button', { name: 'Resume', exact: true }).click(); await page.getByRole('button', { name: 'Confirm resume cronjob', exact: true }).click(); await done();
  assert.equal(cronjob.spec.suspend, false);

  await open('ConfigMaps', 'settings');
  await page.getByRole('button', { name: 'Edit resource', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit resource', exact: true });
  await expect(page.getByLabel('Data value 1')).toHaveValue('blue');
  await page.getByLabel('Data value 1').fill('green'); await page.getByLabel('Remove Data 2').click();
  await page.getByRole('button', { name: 'Validate changes', exact: true }).click();
  await expect(editor).toContainText('API-server validation passed'); assert.equal(configmap.data.color, 'blue');
  await page.getByLabel('Data value 1').fill('purple'); await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Validate changes', exact: true }).click(); await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled(); await capture('03-configmap-editor');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await page.getByRole('button', { name: 'Confirm save changes', exact: true }).click(); await done();
  assert.deepEqual(configmap.data, { color: 'purple' }); assert.deepEqual(configmap.binaryData, { keep: 'AA==' });

  await open('Deployments', 'web'); await page.getByRole('button', { name: 'Edit resource', exact: true }).click();
  await page.getByLabel('Image app', { exact: true }).fill('example/web:3'); await page.getByLabel('Editor replicas').fill('3');
  await page.getByRole('button', { name: 'Validate changes', exact: true }).click(); await expect(editor).toContainText('API-server validation passed'); await capture('04-workload-editor');
  // An external update after validation must not be overwritten by Save.
  deployment.metadata.resourceVersion = '99';
  await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await page.getByRole('button', { name: 'Confirm save changes', exact: true }).click();
  await expect(page.locator('.resource-notification.failed')).toContainText('changed since review'); assert.equal(deployment.spec.replicas, 2); await done();

  await open('Services', 'web'); await page.getByRole('button', { name: 'Edit resource', exact: true }).click();
  await page.getByLabel('Service port 1', { exact: true }).fill('81'); await page.getByRole('button', { name: 'Validate changes', exact: true }).click(); await expect(editor).toContainText('API-server validation passed'); await capture('05-service-editor');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await page.getByRole('button', { name: 'Confirm save changes', exact: true }).click(); await done();
  assert.equal(service.spec.ports[0].port, 81); assert.equal(service.spec.clusterIP, '10.0.0.1');

  await open('Cron Jobs', 'backup'); await page.getByRole('button', { name: 'Edit resource', exact: true }).click();
  await page.getByLabel('CronJob schedule', { exact: true }).fill('*/5 * * * *'); await page.getByRole('button', { name: 'Validate changes', exact: true }).click(); await expect(editor).toContainText('API-server validation passed'); await capture('06-cronjob-editor');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await page.getByRole('button', { name: 'Confirm save changes', exact: true }).click(); await done();
  assert.equal(cronjob.spec.schedule, '*/5 * * * *');

  await open('Nodes', 'worker'); await page.getByRole('button', { name: 'Drain', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Drain node' })).toContainText('standalone');
  await expect(page.getByRole('button', { name: 'Confirm drain node', exact: true })).toBeDisabled();
  await page.getByLabel('Allow deletion of emptyDir data (local data will be lost)', { exact: true }).check();
  await page.getByLabel('Allow unmanaged Pods to be evicted (they may not be recreated)', { exact: true }).check();
  await expect(page.getByRole('button', { name: 'Confirm drain node', exact: true })).toBeEnabled(); await capture('07-node-drain-review');
  // Never drain a real node in UI tests. The subprocess behavior has unit coverage.
  await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('nodes:drain'); ipcMain.handle('nodes:drain', (_event, input) => { globalThis.drainInput = input; return new Promise(resolve => { globalThis.finishDrain = () => resolve({ ok: false, error: { code: 'DRAIN_FAILED', message: 'Drain blocked by PodDisruptionBudget.', retryable: false } }); }); }); });
  await page.getByRole('button', { name: 'Confirm drain node', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.resource-notification.running')).toContainText('Drain node');
  await page.getByTitle('Close details', { exact: true }).click();
  await app.evaluate(() => globalThis.finishDrain());
  await expect(page.locator('.resource-notification.failed')).toContainText('PodDisruptionBudget'); await capture('08-background-failure');
  assert.equal((await app.evaluate(() => globalThis.drainInput)).uid, 'node');
  assert.deepEqual(errors, []);
  console.log('PASS: deployment rollback, CronJob trigger/suspend/resume, ConfigMap/workload/Service/CronJob editors, dry-run invalidation and concurrent edit protection.');
  console.log('PASS: node drain review/opt-ins and background failure notification after closing details. Screenshots: artifacts/resource-actions/.');
} catch (error) {
  await mkdir('artifacts', { recursive: true });
  if (app) await (await app.firstWindow()).screenshot({ path: 'artifacts/resource-actions-failure.png' }).catch(() => {});
  throw error;
} finally {
  await app?.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
  if (resolve(temp).startsWith(resolve(tmpdir()) + sep)) await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}
