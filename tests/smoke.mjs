import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import assert from 'node:assert/strict';
const temp = await mkdtemp(join(tmpdir(), 'workbench-smoke-'));
const requests = [], sockets = new Set(), watchers = new Set();
const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { uid: 'pod-1', name: 'api-gateway', namespace: 'default', resourceVersion: '10', creationTimestamp: new Date(Date.now() - 3600000).toISOString(), labels: { app: 'gateway', environment: 'test' } }, spec: { nodeName: 'worker-1', containers: [{ name: 'server', image: 'example/gateway:1.0' }] }, status: { phase: 'Running', containerStatuses: [{ name: 'server', ready: true, restartCount: 0, state: { running: {} } }] } };
const deployment = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'web', namespace: 'default', uid: 'dep-1', annotations: { 'deployment.kubernetes.io/revision': '2' } }, spec: { replicas: 2 }, status: { readyReplicas: 2 } };
const replicaSet = { apiVersion: 'apps/v1', kind: 'ReplicaSet', metadata: { name: 'web-rs', namespace: 'default', uid: 'rs-1', annotations: { 'deployment.kubernetes.io/revision': '2' }, ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: 'web', uid: 'dep-1', controller: true }] }, spec: { replicas: 2 }, status: { readyReplicas: 2 } };
pod.metadata.ownerReferences = [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'web-rs', uid: 'rs-1', controller: true }];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost'); requests.push({ method: req.method, path: url.pathname, query: url.search });
  res.setHeader('Content-Type', 'application/json');
  if (url.pathname.endsWith('/log')) { res.setHeader('Content-Type', 'text/plain'); res.write('2026-10-22T12:00:00Z gateway ready\n'); if (process.env.OPTIC_SCREENSHOT_DIR) res.write('2026-10-22T12:00:01Z level=warn retrying upstream request\n2026-10-22T12:00:02Z level=error upstream connection refused\n'); return; }
  if (url.searchParams.has('watch')) { res.writeHead(200); res.flushHeaders(); watchers.add(res); req.on('close', () => watchers.delete(res)); return; }
  if (url.pathname === '/version') return res.end(JSON.stringify({ major: '1', minor: '34', gitVersion: 'v1.34.0-test' }));
  if (url.pathname === '/apis/metrics.k8s.io/v1beta1/namespaces/default/pods') return res.end(JSON.stringify({ items: [{ metadata: { name: 'api-gateway', namespace: 'default' }, containers: [{ name: 'server', usage: { cpu: '250m', memory: '64Mi' } }] }] }));
  if (url.pathname === '/apis/metrics.k8s.io/v1beta1/nodes') return res.end(JSON.stringify({ items: [{ metadata: { name: 'worker-1' }, usage: { cpu: '500m', memory: '1Gi' } }] }));
  if (req.method === 'PATCH') { let body = ''; for await (const chunk of req) body += chunk; return res.end(body); }
  if (url.pathname === '/api/v1') return res.end(JSON.stringify({ apiVersion: 'v1', kind: 'APIResourceList', groupVersion: 'v1', resources: [{ name: 'configmaps', namespaced: true, kind: 'ConfigMap', verbs: ['patch'] }, { name: 'pods', singularName: 'pod', namespaced: true, kind: 'Pod', verbs: ['get', 'list', 'watch', 'update', 'delete'] }] }));
  if (url.pathname.endsWith('/pods/api-gateway')) {
    if (req.method === 'PUT') { let text = ''; for await (const chunk of req) text += chunk; return res.end(text); }
    if (req.method === 'DELETE') return res.end(JSON.stringify({ kind: 'Status', apiVersion: 'v1', status: 'Success' }));
    return res.end(JSON.stringify(pod));
  }
  if (url.pathname.endsWith('/deployments/web')) return res.end(JSON.stringify(deployment));
  if (url.pathname.endsWith('/replicasets/web-rs')) return res.end(JSON.stringify(replicaSet));
  const items = url.pathname.endsWith('/replicasets') ? [replicaSet] : url.pathname.endsWith('/deployments') ? [deployment] : url.pathname === '/api/v1/nodes' ? [{ apiVersion: 'v1', kind: 'Node', metadata: { name: 'worker-1', uid: 'node-1' }, status: { allocatable: { cpu: '4', memory: '8Gi', pods: '110' }, conditions: [{ type: 'Ready', status: 'True' }] } }] : url.pathname.endsWith('/pods') ? [pod] : url.pathname.endsWith('/namespaces') ? [{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'default', uid: 'ns-1' } }] : [];
  res.end(JSON.stringify({ apiVersion: 'v1', kind: 'List', metadata: { resourceVersion: '10' }, items }));
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const configPath = join(temp, 'config');
await writeFile(configPath, `apiVersion: v1\nkind: Config\nclusters:\n- name: test\n  cluster:\n    insecure-skip-tls-verify: true\n    server: http://127.0.0.1:${server.address().port}\nusers:\n- name: test\n  user: {}\ncontexts:\n- name: local-test\n  context:\n    cluster: test\n    user: test\ncurrent-context: local-test\n`);
let app;
try {
  const env = { ...process.env, WORKBENCH_KUBECONFIG: configPath }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ ...(process.env.WORKBENCH_TEST_EXECUTABLE ? { executablePath: process.env.WORKBENCH_TEST_EXECUTABLE } : {}), args: [...(process.env.WORKBENCH_TEST_EXECUTABLE ? [] : ['.']), `--user-data-dir=${join(temp, 'profile')}`], env });
  const page = await app.firstWindow();
  const captureDir = process.env.OPTIC_SCREENSHOT_DIR;
  const captures = [];
  const capture = async (name) => {
    if (!captureDir) return;
    await mkdir(captureDir, { recursive: true });
    await page.evaluate(() => {
      let badge = document.getElementById('showcase-demo-label');
      if (!badge) { badge = document.createElement('div'); badge.id = 'showcase-demo-label'; document.body.appendChild(badge); }
      badge.textContent = 'OPTIC | DEMO WORKSPACE';
      badge.style.cssText = 'position:fixed;bottom:3px;left:45%;z-index:99999;font:10px sans-serif;letter-spacing:1px;color:#a8c7df;background:#25282b;padding:2px 8px;pointer-events:none';
    });
    await page.screenshot({ path: join(captureDir, name + '.png') });
    captures.push(name);
    await writeFile(join(captureDir, 'screenshots.json'), JSON.stringify(captures, null, 2));
  };
  if (captureDir) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
    await expect(page.locator('.welcome-brand')).toBeVisible();
    await capture('01-welcome');
  }
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  // Search must reveal nested policy entries even when Config is collapsed.
  await page.getByLabel('Find in Navigator', { exact: true }).fill('Validating Admission Policy Bindings');
  await page.locator('.navigator').getByRole('button', { name: 'Validating Admission Policy Bindings', exact: true }).click();
  await expect.poll(() => requests.some(r => r.path === '/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicybindings')).toBe(true);
  await page.getByLabel('Find in Navigator', { exact: true }).fill('Leases');
  await page.locator('.navigator').getByRole('button', { name: 'Leases', exact: true }).click();
  await expect.poll(() => requests.some(r => r.path.endsWith('/leases'))).toBe(true);
  await page.getByLabel('Find in Navigator', { exact: true }).fill('');
  await page.locator('.navigator').getByRole('button', { name: 'Applications', exact: true }).click();
  await expect(page.locator('.application-card')).toContainText('gateway');
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/applications.png' });
  await page.locator('.application-card').getByRole('button', { name: 'api-gateway', exact: true }).click();
  await expect(page.locator('.details h2')).toHaveText('api-gateway');
  await page.getByTitle('Close details', { exact: true }).click();

  await page.getByRole('button', { name: 'Pods', exact: true }).click();
  await expect(page.getByText('api-gateway', { exact: true })).toBeVisible({ timeout: 20000 });
  await capture('02-pods');
  const agePods = [['age-two-minutes', 2], ['age-ten-hours', 600], ['age-one-day', 1440]].map(([name, minutes]) => ({ ...pod, metadata: { ...pod.metadata, uid: name, name, creationTimestamp: new Date(Date.now() - minutes * 60000).toISOString() } }));
  for (const response of watchers) for (const object of agePods) response.write(JSON.stringify({ type: 'ADDED', object }) + '\n');
  await expect(page.locator('tbody tr')).toHaveCount(4);
  await page.getByRole('button', { name: 'Age', exact: true }).click();
  await expect(page.locator('tbody .resource-name')).toHaveText(['age-two-minutes', 'api-gateway', 'age-ten-hours', 'age-one-day']);
  await page.getByRole('button', { name: 'Age', exact: true }).click();
  await expect(page.locator('tbody .resource-name')).toHaveText(['age-one-day', 'age-ten-hours', 'api-gateway', 'age-two-minutes']);
  for (const response of watchers) for (const object of agePods) response.write(JSON.stringify({ type: 'DELETED', object }) + '\n');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Name', exact: true }).click();
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  await page.getByTitle('Add kubeconfig', { exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Add kubeconfig', exact: true })).toBeVisible();
  await capture('03-kubeconfig-import-options');
  await expect(page.getByRole('button', { name: 'Add kubeconfig from filesystem', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByTitle('Add kubeconfig', { exact: true }).click();
  await page.getByRole('button', { name: 'Add kubeconfig from clipboard', exact: true }).click();
  const pasteDialog = page.getByRole('dialog', { name: 'Add Clusters from Kubeconfig', exact: true });
  await expect(pasteDialog).toBeVisible();
  await capture('04-paste-kubeconfig-editor');
  await expect(pasteDialog.getByRole('button', { name: 'Add Clusters', exact: true })).toBeDisabled();
  await page.getByLabel('Kubeconfig YAML', { exact: true }).fill('not a kubeconfig');
  await pasteDialog.getByRole('button', { name: 'Add Clusters', exact: true }).click();
  await expect(pasteDialog.getByRole('alert')).toContainText('valid v1 kubeconfig');
  await expect(page.getByLabel('Kubeconfig YAML', { exact: true })).toHaveValue('not a kubeconfig');
  await pasteDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  const prefs = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.sandbox, true);
  await page.getByText('api-gateway', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'api-gateway' })).toBeVisible();
  await capture('05-pod-details');
  if (captureDir) {
    const unhealthy = { ...pod, status: { phase: 'Pending', conditions: [{ type: 'Ready', status: 'False', reason: 'ContainersNotReady', message: 'Container image could not be pulled.' }], containerStatuses: [{ name: 'server', ready: false, restartCount: 0, state: { waiting: { reason: 'ImagePullBackOff', message: 'Unable to pull example/gateway:missing' } } }] } };
    for (const response of watchers) response.write(JSON.stringify({ type: 'MODIFIED', object: unhealthy }) + '\n');
    await expect(page.locator('tbody')).toContainText('ImagePullBackOff');
    await capture('05b-resource-error-highlighting');
    for (const response of watchers) response.write(JSON.stringify({ type: 'MODIFIED', object: pod }) + '\n');
    await expect(page.locator('tbody')).toContainText('Running');
  }

  await page.getByRole('button', { name: 'Metrics', exact: true }).click();
  await expect(page.getByRole('img', { name: 'CPU (cores) history', exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.resource-metrics')).toContainText('0.250');
  await expect(page.locator('.resource-metrics')).toContainText('Requires Prometheus');
  await page.getByLabel('Metrics container', { exact: true }).selectOption('server');
  await expect(page.getByRole('img', { name: 'Memory working set history', exact: true })).toBeVisible();
  await page.getByLabel('Resource metrics time range', { exact: true }).selectOption('5');
  await expect(page.getByRole('img', { name: 'CPU (cores) history', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Related', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ReplicaSet / web-rs', exact: true })).toBeVisible();
  await capture('06-owner-chain');
  await page.getByRole('button', { name: 'Deployment / web', exact: true }).click();
  await expect(page.locator('.details h2')).toHaveText('web');
  await page.getByRole('button', { name: 'Related', exact: true }).click();
  await expect(page.locator('.related-resources')).toContainText('2 (current)');
  await capture('07-related-pods-and-revisions');
  await page.locator('.related-resources').getByRole('button', { name: 'web-rs', exact: true }).click();
  await expect(page.locator('.details h2')).toHaveText('web-rs');
  await capture('08-replicaset-details');
  await page.getByRole('button', { name: 'Related', exact: true }).click();
  await page.locator('.related-resources').getByRole('button', { name: 'api-gateway', exact: true }).click();
  await expect(page.locator('.details h2')).toHaveText('api-gateway');
  await page.getByRole('button', { name: 'Logs', exact: true }).click();
  await expect(page.locator('.logs')).toContainText('gateway ready');
  await capture('09-live-container-logs');
  await page.getByLabel('Previous container', { exact: true }).check();
  await expect.poll(() => requests.some(r => r.path.endsWith('/log') && r.query.includes('previous=true'))).toBe(true);
  await page.getByLabel('Previous container', { exact: true }).uncheck();
  const logsBefore = requests.filter(r => r.path.endsWith('/log')).length;
  await page.getByRole('button', { name: 'Reconnect logs', exact: true }).click();
  await expect.poll(() => requests.filter(r => r.path.endsWith('/log')).length).toBeGreaterThan(logsBefore);
  await page.getByRole('button', { name: 'Port forward', exact: true }).click();
  await expect(page.getByLabel('Local port', { exact: true })).toHaveValue('0');
  await capture('10-port-forward-configuration');
  await page.getByLabel('Remote port', { exact: true }).fill('65536');
  await expect(page.getByRole('button', { name: 'Start forwarding', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'YAML', exact: true }).click();
  await expect(page.getByLabel('Resource YAML')).toHaveValue(/api-gateway/);
  await capture('11-resource-yaml-editor');
  await page.getByRole('button', { name: 'Save YAML', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(() => requests.some(r => r.method === 'PUT')).toBe(true);
  const result = await page.evaluate(async () => {
    const id = crypto.randomUUID(), output = [];
    const dispose = window.desktop.subscribe(event => { if (event.id === id && event.type === 'data') { output.push(event.data); void window.desktop.request('stream:ack', { id, seq: event.seq }); } });
    try {
      const opened = await window.desktop.request('terminal:open', { id, cols: 80, rows: 24 });
      if (!opened.ok) return { opened, text: '' };
      await window.desktop.request('terminal:write', { id, data: 'echo WORKBENCH_PTY_OK\r' });
      for (let n = 0; n < 100 && !/\nWORKBENCH_PTY_OK(?:\r?\n|\x1b)/.test(output.join('')); n++) await new Promise(resolve => setTimeout(resolve, 50));
      return { opened, text: output.join('') };
    } finally { dispose(); await window.desktop.request('stream:close', { id }); }
  });
  assert.equal(result.opened.ok, true, JSON.stringify(result)); assert.match(result.text, /\nWORKBENCH_PTY_OK(?:\r?\n|\x1b)/);
  await page.locator('.detail-tabs').getByRole('button', { name: 'Overview', exact: true }).click();
  await mkdir('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/dashboard.png' });
  for (const response of watchers) response.write(`${JSON.stringify({ type: 'MODIFIED', object: { ...pod, status: { phase: 'Pending' } } })}\n`);
  await expect(page.locator('tbody')).toContainText('Pending'); assert.deepEqual(errors, []);
  const listsBefore = requests.filter(r => r.path.endsWith('/pods')).length;
  for (const response of watchers) response.write(`${JSON.stringify({ type: 'ERROR', object: { code: 410, reason: 'Expired' } })}\n`);
  await expect.poll(() => requests.filter(r => r.path.endsWith('/pods')).length, { timeout: 10000 }).toBeGreaterThan(listsBefore);
  await expect(page.locator('tbody')).toContainText('Running');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  assert.equal(requests.some(r => r.method === 'DELETE'), false);
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(() => requests.some(r => r.method === 'DELETE')).toBe(true);
  await page.getByRole('button', { name: 'Collapse or expand dock' }).click();
  await page.locator('.navigator').getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(page.getByRole('img', { name: 'CPU: 0.50 used', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'PODS: 1 used', exact: true })).toBeVisible();
  await expect(page.locator('.gauge').first()).toContainText('Allocatable: 4.00');
  const historyChart = page.getByRole('img', { name: 'Live usage history', exact: true });
  await expect(historyChart.locator('circle').first()).toBeVisible();
  const firstPoint = await historyChart.locator('circle').first().getAttribute('cy');
  const sampleCount = await historyChart.locator('circle').count();
  await page.getByTitle('Refresh overview', { exact: true }).click();
  await expect.poll(() => historyChart.locator('circle').count()).toBeGreaterThan(sampleCount);
  await expect(historyChart.locator('circle').first()).toHaveAttribute('cy', firstPoint);
  await expect(historyChart.locator('polyline')).toHaveAttribute('points', /\S+,\S+ \S+,\S+/);
  await expect(historyChart.locator('text')).toHaveCount(10);
  // A failed poll must not present retained history as a current reading.
  await app.evaluate(({ ipcMain }) => {
    globalThis.auditMetricsHandler = ipcMain._invokeHandlers.get('metrics:read');
    ipcMain.removeHandler('metrics:read');
    ipcMain.handle('metrics:read', () => ({ ok: false, error: { code: 'UNREACHABLE', message: 'Test metrics connection lost', retryable: true } }));
  });
  await page.getByTitle('Refresh overview', { exact: true }).click();
  await expect(page.getByRole('img', { name: 'CPU: unavailable used', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'MEMORY: unavailable used', exact: true })).toBeVisible();
  await expect(page.locator('.overview-page')).toContainText('Historical samples are retained; last successful sample:');
  await expect(page.locator('.overview-toolbar')).toContainText('Metrics unavailable');
  await expect(historyChart.locator('circle').first()).toBeVisible();
  await capture('12b-metrics-unavailable-history-retained');
  await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('metrics:read'); ipcMain.handle('metrics:read', globalThis.auditMetricsHandler); delete globalThis.auditMetricsHandler; });
  await page.getByTitle('Refresh overview', { exact: true }).click();
  await expect(page.getByRole('img', { name: 'CPU: 0.50 used', exact: true })).toBeVisible();
  await expect(page.locator('.overview-page')).not.toContainText('Historical samples are retained; last successful sample:');
  await expect(page.locator('.overview-toolbar')).toContainText('Live samples');
  await page.getByLabel('Monitor nodes', { exact: true }).selectOption('masters');
  await expect(page.getByRole('img', { name: 'CPU: unavailable used', exact: true })).toBeVisible();
  await expect(page.getByText('No nodes match this selection.', { exact: true })).toBeVisible();
  await expect(historyChart.locator('circle')).toHaveCount(0);
  await page.getByLabel('Monitor nodes', { exact: true }).selectOption('workers');
  await expect(page.getByRole('img', { name: 'CPU: 0.50 used', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'PODS: 1 used', exact: true })).toBeVisible();
  await page.getByLabel('Metrics time range', { exact: true }).selectOption('60');
  await page.getByRole('button', { name: 'Absolute units', exact: true }).click();
  await expect(historyChart).toContainText('100.0%');
  await page.getByLabel('Monitor nodes', { exact: true }).selectOption('node:worker-1');
  await expect(page.getByRole('img', { name: 'CPU: 0.50 used', exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/overview.png' });
  await capture('12-metrics-overview');
  await page.locator('.navigator').getByRole('button', { name: 'Deployments', exact: true }).click();
  await page.getByText('web', { exact: true }).click();
  await expect(page.locator('.details')).toContainText('Ready replicas');
  await page.screenshot({ path: 'artifacts/resource-details.png' });
  await capture('13-deployment-details');
  await page.getByRole('button', { name: 'Scale', exact: true }).click();
  await page.getByLabel('Replicas', { exact: true }).fill('3');
  await capture('14-scale-workload');
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(() => requests.some(r => r.method === 'PATCH' && r.path.endsWith('/deployments/web/scale'))).toBe(true);
  await page.getByRole('button', { name: 'Restart', exact: true }).click();
  await capture('15-restart-confirmation');
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(() => requests.some(r => r.method === 'PATCH' && r.path.endsWith('/deployments/web'))).toBe(true);
  await page.locator('.navigator').getByRole('button', { name: 'Nodes', exact: true }).click();
  await page.getByText('worker-1', { exact: true }).click();
  await page.getByRole('button', { name: 'Cordon', exact: true }).click();
  await capture('16-node-management');
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(() => requests.some(r => r.method === 'PATCH' && r.path === '/api/v1/nodes/worker-1')).toBe(true);
  // On smaller displays the details drawer overlays the resource toolbar.
  await page.getByTitle('Close details', { exact: true }).click();
  await expect(page.locator('.details')).toHaveCount(0);
  await page.getByTitle('Create resource', { exact: true }).click();
  await expect(page.getByLabel('Resource template', { exact: true })).toHaveValue('nodes');
  await expect(page.getByLabel('Manifest YAML', { exact: true })).toHaveValue(/kind: Node/);
  await expect(page.getByLabel('Manifest YAML', { exact: true })).not.toHaveValue(/namespace:/);
  await page.getByLabel('Resource template', { exact: true }).selectOption('pods');
  await expect(page.getByLabel('Manifest YAML', { exact: true })).toHaveValue(/kind: Pod/);
  await expect(page.getByLabel('Manifest YAML', { exact: true })).toHaveValue(/containers:/);
  // Keep the existing dry-run/apply fixture, now selected explicitly.
  await page.getByLabel('Resource template', { exact: true }).selectOption('configmaps');
  await page.getByRole('button', { name: 'Apply to cluster', exact: true }).isDisabled().then(value => assert.equal(value, true));
  await page.getByRole('button', { name: 'Validate manifest', exact: true }).click();
  await expect(page.locator('.validation-result')).toContainText('example-config');
  await page.getByLabel('Resource template', { exact: true }).selectOption('deployments');
  await expect(page.getByRole('button', { name: 'Apply to cluster', exact: true })).toBeDisabled();
  await expect(page.locator('.validation-result')).toHaveCount(0);
  await page.getByLabel('Resource template', { exact: true }).selectOption('configmaps');
  await page.getByRole('button', { name: 'Validate manifest', exact: true }).click();
  await expect(page.locator('.validation-result')).toContainText('example-config');
  await capture('17-manifest-validation');
  assert.equal(requests.some(r => r.path.endsWith('/configmaps/example-config') && !r.query.includes('dryRun')), false);
  await page.getByRole('button', { name: 'Apply to cluster', exact: true }).click();
  await expect.poll(() => requests.some(r => r.path.endsWith('/configmaps/example-config') && !r.query.includes('dryRun'))).toBe(true);
  await page.getByRole('tab', { name: /^Pods .*local-test$/ }).click();
  await page.getByLabel('Search Pods', { exact: true }).fill('absent');
  await expect(page.getByText('No matching resources', { exact: true })).toBeVisible();
  await page.getByLabel('Search Pods', { exact: true }).fill('');
  await expect(page.locator('tbody')).toContainText('api-gateway');
  assert.deepEqual(errors, []);
  await page.locator('.cluster-tree-header').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Disconnect', exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/cluster-menu.png' });
  await capture('18-cluster-context-menu');
  await expect(page.getByRole('menuitem', { name: 'Remove from Kubeconfig', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Add to Hotbar', exact: true }).click();
  await expect(page.locator('.activity-rail .context-icon')).toHaveCount(1);
  await page.getByTitle('Cluster actions: local-test', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Appearance', exact: true }).click();
  await page.getByLabel('Cluster display name', { exact: true }).fill('My test cluster');
  await capture('19-cluster-appearance');
  await page.getByRole('button', { name: 'Save appearance', exact: true }).click();
  await expect(page.locator('.cluster-tree-header')).toContainText('My test cluster');
  await page.getByTitle('Cluster actions: local-test', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Show Cluster Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('v1.34.0-test');
  await capture('20-cluster-general-settings');
  const settingsNav = page.getByRole('navigation', { name: 'Cluster settings sections' });
  for (const name of ['General','Proxy','Terminal','Namespaces','Metrics','Monitoring Stack','Cost','Node Shell']) await expect(settingsNav.getByRole('button', { name, exact: true })).toBeVisible();
  if (captureDir) {
    for (const section of ['Proxy', 'Terminal', 'Namespaces', 'Metrics', 'Monitoring Stack', 'Cost', 'Node Shell']) {
      await settingsNav.getByRole('button', { name: section, exact: true }).click();
      await capture('21-settings-' + section.toLowerCase().replaceAll(' ', '-'));
    }
  }
  await settingsNav.getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.getByLabel('Default namespace', { exact: true }).fill('team-a');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Settings saved');
  await settingsNav.getByRole('button', { name: 'Namespaces', exact: true }).click();
  await page.getByLabel('Accessible namespaces', { exact: true }).fill('default\nteam-a');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Settings saved');
  await settingsNav.getByRole('button', { name: 'Metrics', exact: true }).click();
  await page.getByLabel('Metrics source', { exact: true }).selectOption('none');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Settings saved');
  await page.getByRole('button', { name: 'Test saved metrics configuration', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('disabled');
  await page.getByLabel('Metrics source', { exact: true }).selectOption('metrics-server');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Settings saved');
  await page.screenshot({ path: 'artifacts/cluster-settings.png' });
  await settingsNav.getByRole('button', { name: 'Cost', exact: true }).click();
  await page.getByLabel('Cost source', { exact: true }).selectOption('estimate');
  await page.getByLabel('Estimated hourly node cost', { exact: true }).fill('0.25');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Settings saved');
  await page.getByRole('button', { name: 'Read saved cost source', exact: true }).click();
  await expect(page.locator('.settings-info')).toContainText('USD 6.00');
  await capture('22-cost-estimate');
  await settingsNav.getByRole('button', { name: 'Monitoring Stack', exact: true }).click();
  // Keep chart discovery deterministic and offline; backend lookup is covered by unit tests.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('monitoring:version');
    ipcMain.handle('monitoring:version', async () => ({ ok: true, data: { version: '99.2.3' } }));
  });
  await page.getByLabel('prometheus action', { exact: true }).selectOption('install');
  await expect(page.getByLabel('prometheus chart version', { exact: true })).toHaveValue('99.2.3');
  await page.getByRole('button', { name: 'Review monitoring changes' }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm monitoring changes' })).toContainText('99.2.3');
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('monitoring:apply');
    ipcMain.handle('monitoring:apply', async () => {
      await new Promise(resolve => { globalThis.finishMonitoring = resolve; });
      return { ok: true, data: { completed: ['prometheus installed'], error: 'kube-state-metrics failed to become ready' } };
    });
  });
  await page.getByRole('button', { name: 'Apply monitoring changes', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm monitoring changes' })).toHaveCount(0);
  await expect(page.locator('.helm-notification.running')).toContainText('Monitoring Stack');
  await page.getByRole('tab', { name: 'Welcome', exact: true }).click();
  await expect(page.locator('.helm-notification.running')).toBeVisible();
  await expect.poll(() => app.evaluate(() => typeof globalThis.finishMonitoring)).toBe('function');
  await app.evaluate(() => globalThis.finishMonitoring());
  await expect(page.locator('.helm-notification.failed')).toContainText('Completed: prometheus installed');
  await expect(page.locator('.helm-notification.failed')).toContainText('kube-state-metrics failed');
  await page.locator('.helm-notification.failed button[aria-label^="Dismiss"]').click();
  await page.getByRole('tab', { name: /^Pods .*local-test$/ }).click();
  await expect(page.getByLabel('Namespace', { exact: true })).toHaveValue('default');
  await expect(page.locator('tbody')).toContainText('api-gateway');
  await page.getByTitle('Cluster actions: local-test', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Cluster disconnected' })).toBeVisible();
  await expect.poll(() => watchers.size).toBe(0);
  await page.getByTitle('Cluster actions: local-test', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('img', { name: 'CPU: 0.50 used', exact: true })).toBeVisible();
  await page.getByTitle('Cluster actions: local-test', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Remove from Kubeconfig', exact: true }).click();
  await page.getByRole('button', { name: 'Remove context', exact: true }).click();
  await expect(page.locator('.backup-path')).toBeVisible();
  await page.getByTitle('Close cluster settings').click();
  await expect(page.getByText('No contexts found.', { exact: false })).toBeVisible();
  await page.getByTitle('Add kubeconfig', { exact: true }).click();
  await page.getByRole('button', { name: 'Add kubeconfig from clipboard', exact: true }).click();
  const validPastedConfig = `apiVersion: v1
kind: Config
clusters:
- name: test
  cluster: {server: "http://127.0.0.1:${server.address().port}"}
users:
- name: test
  user: {}
contexts:
- name: pasted-context
  context: {cluster: test, user: test}
current-context: pasted-context
`;
  await page.getByLabel('Kubeconfig YAML', { exact: true }).fill(validPastedConfig);
  await page.screenshot({ path: 'artifacts/kubeconfig-paste.png' });
  await page.getByRole('button', { name: 'Add Clusters', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Add Clusters from Kubeconfig', exact: true })).toHaveCount(0);
  await expect(page.getByTitle('Cluster actions: pasted-context', { exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
  // Mock external Helm at IPC for deterministic renderer flows; service tests cover CLI arguments.
  await app.evaluate(({ ipcMain }) => {
    globalThis.helmTestCalls = [];
    const release = { name: 'web', namespace: 'default', revision: '2', updated: '2026-10-23', status: 'deployed', chart: 'nginx-2.0.0', app_version: '1.27' };
    const handlers = {
      'helm:repositories': () => [{ name: 'bitnami', url: 'https://charts.bitnami.com/bitnami' }],
      'helm:charts': () => [{ name: 'nginx', description: 'Test web chart', version: '2.0.0', appVersion: '1.27', repository: 'bitnami', deprecated: false }],
      'helm:versions': () => [{ version: '2.0.0', appVersion: '1.27' }, { version: '1.0.0', appVersion: '1.26' }],
      'helm:chart-info': () => ({ values: 'replicaCount: 1', readme: '# Test chart' }),
      'helm:preview': () => ({ token: '11111111-1111-4111-8111-111111111111', manifest: 'kind: Deployment\nmetadata: {name: web}', resources: 1 }),
      'helm:apply': async input => { globalThis.helmTestCalls.push({ action: input.plan.action, values: input.plan.values }); if (input.plan.action === 'install') await new Promise(resolve => { globalThis.finishHelmInstall = resolve; }); },
      'helm:releases': () => [release],
      'helm:details': () => ({ status: 'deployed', values: 'replicaCount: 2', manifest: 'kind: Deployment', notes: 'Ready', history: [{ revision: 2, status: 'deployed', chart: 'nginx-2.0.0', description: 'Upgrade' }, { revision: 1, status: 'superseded', chart: 'nginx-1.0.0', description: 'Install' }] }),
      'helm:rollback': input => { globalThis.helmTestCalls.push({ action: 'rollback', revision: input.revision }); },
      'helm:uninstall': () => { globalThis.helmTestCalls.push({ action: 'uninstall' }); }
    };
    for (const [channel, handler] of Object.entries(handlers)) { ipcMain.removeHandler(channel); ipcMain.handle(channel, async (_event, input) => ({ ok: true, data: await handler(input) })); }
  });
  await page.locator('.navigator').getByRole('button', { name: 'Charts', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Helm Charts', exact: true })).toBeVisible();
  await capture('23-helm-chart-catalog');
  await page.getByRole('button', { name: 'nginx', exact: true }).click();
  const helmDialog = page.getByRole('dialog', { name: 'Configure Helm release', exact: true });
  await expect(helmDialog.getByRole('button', { name: 'Review and apply', exact: true })).toBeDisabled();
  await page.getByLabel('Helm release name', { exact: true }).fill('web');
  await page.getByLabel('Helm values YAML', { exact: true }).fill('replicaCount: 2');
  await page.getByRole('button', { name: 'Load chart defaults and README', exact: true }).click();
  await expect(helmDialog).toContainText('Chart defaults');
  await capture('24-helm-values-editor');
  await page.getByRole('button', { name: 'Preview changes', exact: true }).click();
  await expect(helmDialog.getByRole('button', { name: 'Review and apply', exact: true })).toBeEnabled();
  if (captureDir) await page.locator('.helm-modal').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await capture('25-helm-manifest-preview');
  await page.getByLabel('Helm values YAML', { exact: true }).fill('replicaCount: 3');
  await expect(helmDialog.getByRole('button', { name: 'Review and apply', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Preview changes', exact: true }).click();
  await page.getByRole('button', { name: 'Review and apply', exact: true }).click();
  assert.equal(await app.evaluate(() => globalThis.helmTestCalls.length), 0);
  await capture('26-helm-confirmation');
  await page.getByRole('dialog', { name: 'Confirm Helm operation', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.screenshot({ path: 'artifacts/helm-install.png' });
  await page.getByRole('button', { name: 'Review and apply', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm Helm operation', exact: true }).click();
  await expect(helmDialog).toHaveCount(0);
  await expect(page.locator('.helm-notification.running')).toContainText('Install web');
  await capture('27-background-operation');
  await page.getByRole('tab', { name: 'Welcome', exact: true }).click();
  await expect(page.locator('.helm-notification.running')).toBeVisible();
  await app.evaluate(() => globalThis.finishHelmInstall());
  await expect(page.locator('.helm-notification.succeeded')).toContainText('Operation completed successfully');
  await capture('28-operation-complete');
  await page.locator('.navigator').getByRole('button', { name: 'Releases', exact: true }).click();
  await expect(page.getByRole('button', { name: 'web', exact: true })).toBeVisible();
  await capture('29-helm-releases');
  await page.getByRole('button', { name: 'web', exact: true }).click();
  await page.getByRole('button', { name: 'Upgrade / edit values', exact: true }).click();
  await expect(page.getByLabel('Helm values YAML', { exact: true })).toHaveValue('replicaCount: 2');
  await expect(page.getByLabel('Helm release name', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Preview changes', exact: true }).click();
  await page.getByRole('button', { name: 'Review and apply', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm Helm operation', exact: true }).click();
  await expect(helmDialog).toHaveCount(0);
  await expect(page.locator('.helm-notification.running')).toHaveCount(0);
  await page.getByRole('button', { name: 'web', exact: true }).click();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await capture('30-helm-revision-history');
  await page.getByRole('button', { name: 'Rollback to 1', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm Helm operation', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Helm release details', exact: true })).toHaveCount(0);
  await expect(page.locator('.helm-notification.running')).toHaveCount(0);
  await page.getByRole('button', { name: 'web', exact: true }).click();
  await page.getByRole('button', { name: 'Uninstall release', exact: true }).click();
  await capture('31-helm-uninstall-confirmation');
  await page.getByRole('button', { name: 'Confirm Helm operation', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Helm release details', exact: true })).toHaveCount(0);
  await expect(page.locator('.helm-notification.running')).toHaveCount(0);
  assert.deepEqual(await app.evaluate(() => globalThis.helmTestCalls), [{ action: 'install', values: 'replicaCount: 3' }, { action: 'upgrade', values: 'replicaCount: 2' }, { action: 'rollback', revision: 1 }, { action: 'uninstall' }]);
  assert.deepEqual(errors, []);
  if (captureDir) {
    while (await page.locator('.helm-notifications button[aria-label^="Dismiss"]').count()) await page.locator('.helm-notifications button[aria-label^="Dismiss"]').first().click();
    await page.getByRole('button', { name: 'Search resources and commands', exact: false }).click();
    await capture('32-command-palette');
    await page.keyboard.press('Escape');
    await page.getByTitle('Local terminal', { exact: true }).click();
    await expect(page.locator('.terminal-host').last().locator('.xterm-screen')).toBeVisible();
    await expect(page.locator('.terminal-host').last()).toContainText(/PS|PowerShell|>/, { timeout: 15000 });
    await capture('33-integrated-terminal');
  }
  console.log('PASS: Helm chart browsing, values editing, preview invalidation, confirmed install/upgrade/rollback/uninstall.');
  console.log('PASS: cluster context menu, hotbar, appearance, connection settings, connect and backed-up context removal.');
  console.log('PASS: overview metrics, workspace tabs, search, scale, restart, cordon, manifest dry-run/apply.');
  console.log('PASS: secure renderer, discovery, LIST/WATCH and expiry recovery, YAML, confirmed write/delete, live logs, native PTY command execution.');
} catch (error) {
  if (app) {
    await mkdir('artifacts', { recursive: true });
    await (await app.firstWindow()).screenshot({ path: 'artifacts/smoke-failure.png' }).catch(() => {});
    console.error('Mock API requests:', requests);
    console.error('Mock SDK diagnostic:', await app.evaluate(async (_electron, modulePath) => {
      try { const require = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json'); const { KubeConfig, VersionApi } = require('@kubernetes/client-node'); const config = new KubeConfig(); config.loadFromFile(process.env.WORKBENCH_KUBECONFIG); return await config.makeApiClient(VersionApi).getCode(); }
      catch (e) { return String(e.stack); }
    }, new URL('../node_modules/@kubernetes/client-node/dist/index.js', import.meta.url).href));
  }
  throw error;
} finally {
  await app?.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
  if (resolve(temp).startsWith(resolve(tmpdir()) + sep)) await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}
