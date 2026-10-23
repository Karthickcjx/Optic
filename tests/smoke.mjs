import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import assert from 'node:assert/strict';
const temp = await mkdtemp(join(tmpdir(), 'workbench-smoke-'));
const requests = [], sockets = new Set(), watchers = new Set();
const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { uid: 'pod-1', name: 'api-gateway', namespace: 'default', resourceVersion: '10', creationTimestamp: new Date(Date.now() - 3600000).toISOString(), labels: { app: 'gateway', environment: 'test' } }, spec: { nodeName: 'worker-1', containers: [{ name: 'server', image: 'example/gateway:1.0' }] }, status: { phase: 'Running' } };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost'); requests.push({ method: req.method, path: url.pathname, query: url.search });
  res.setHeader('Content-Type', 'application/json');
  if (url.pathname.endsWith('/log')) { res.setHeader('Content-Type', 'text/plain'); res.write('2026-10-22T12:00:00Z gateway ready\n'); return; }
  if (url.searchParams.has('watch')) { res.writeHead(200); res.flushHeaders(); watchers.add(res); req.on('close', () => watchers.delete(res)); return; }
  if (url.pathname === '/version') return res.end(JSON.stringify({ major: '1', minor: '34', gitVersion: 'v1.34.0-test' }));
  if (url.pathname === '/apis/metrics.k8s.io/v1beta1/nodes') return res.end(JSON.stringify({ items: [{ metadata: { name: 'worker-1' }, usage: { cpu: '500m', memory: '1Gi' } }] }));
  if (req.method === 'PATCH') { let body = ''; for await (const chunk of req) body += chunk; return res.end(body); }
  if (url.pathname === '/api/v1') return res.end(JSON.stringify({ apiVersion: 'v1', kind: 'APIResourceList', groupVersion: 'v1', resources: [{ name: 'configmaps', namespaced: true, kind: 'ConfigMap', verbs: ['patch'] }, { name: 'pods', singularName: 'pod', namespaced: true, kind: 'Pod', verbs: ['get', 'list', 'watch', 'update', 'delete'] }] }));
  if (url.pathname.endsWith('/pods/api-gateway')) {
    if (req.method === 'PUT') { let text = ''; for await (const chunk of req) text += chunk; return res.end(text); }
    if (req.method === 'DELETE') return res.end(JSON.stringify({ kind: 'Status', apiVersion: 'v1', status: 'Success' }));
    return res.end(JSON.stringify(pod));
  }
  const items = url.pathname.endsWith('/deployments') ? [{ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'web', namespace: 'default', uid: 'dep-1' }, spec: { replicas: 2 }, status: { readyReplicas: 2 } }] : url.pathname === '/api/v1/nodes' ? [{ apiVersion: 'v1', kind: 'Node', metadata: { name: 'worker-1', uid: 'node-1' }, status: { allocatable: { cpu: '4', memory: '8Gi', pods: '110' }, conditions: [{ type: 'Ready', status: 'True' }] } }] : url.pathname.endsWith('/pods') ? [pod] : url.pathname.endsWith('/namespaces') ? [{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'default', uid: 'ns-1' } }] : [];
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
  const page = await app.firstWindow(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.getByRole('button', { name: 'Pods', exact: true }).click();
  await expect(page.getByText('api-gateway', { exact: true })).toBeVisible({ timeout: 20000 });
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  await page.getByTitle('Add kubeconfig', { exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Add kubeconfig', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add kubeconfig from filesystem', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByTitle('Add kubeconfig', { exact: true }).click();
  await page.getByRole('button', { name: 'Add kubeconfig from clipboard', exact: true }).click();
  const pasteDialog = page.getByRole('dialog', { name: 'Add Clusters from Kubeconfig', exact: true });
  await expect(pasteDialog).toBeVisible();
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
  await page.getByRole('button', { name: 'Logs', exact: true }).click();
  await expect(page.locator('.logs')).toContainText('gateway ready');
  await page.getByLabel('Previous container', { exact: true }).check();
  await expect.poll(() => requests.some(r => r.path.endsWith('/log') && r.query.includes('previous=true'))).toBe(true);
  await page.getByLabel('Previous container', { exact: true }).uncheck();
  const logsBefore = requests.filter(r => r.path.endsWith('/log')).length;
  await page.getByRole('button', { name: 'Reconnect logs', exact: true }).click();
  await expect.poll(() => requests.filter(r => r.path.endsWith('/log')).length).toBeGreaterThan(logsBefore);
  await page.getByRole('button', { name: 'Port forward', exact: true }).click();
  await expect(page.getByLabel('Local port', { exact: true })).toHaveValue('0');
  await page.getByLabel('Remote port', { exact: true }).fill('65536');
  await expect(page.getByRole('button', { name: 'Start forwarding', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'YAML', exact: true }).click();
  await expect(page.getByLabel('Resource YAML')).toHaveValue(/api-gateway/);
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
  const listsBefore = requests.filter(r => r.path === '/api/v1/pods').length;
  for (const response of watchers) response.write(`${JSON.stringify({ type: 'ERROR', object: { code: 410, reason: 'Expired' } })}\n`);
  await expect.poll(() => requests.filter(r => r.path === '/api/v1/pods').length, { timeout: 10000 }).toBeGreaterThan(listsBefore);
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
  await page.locator('.navigator').getByRole('button', { name: 'Deployments', exact: true }).click();
  await page.getByText('web', { exact: true }).click();
  await expect(page.locator('.details')).toContainText('Ready replicas');
  await page.screenshot({ path: 'artifacts/resource-details.png' });
  await page.getByRole('button', { name: 'Scale', exact: true }).click();
  await page.getByLabel('Replicas', { exact: true }).fill('3');
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(() => requests.some(r => r.method === 'PATCH' && r.path.endsWith('/deployments/web/scale'))).toBe(true);
  await page.getByRole('button', { name: 'Restart', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(() => requests.some(r => r.method === 'PATCH' && r.path.endsWith('/deployments/web'))).toBe(true);
  await page.locator('.navigator').getByRole('button', { name: 'Nodes', exact: true }).click();
  await page.getByText('worker-1', { exact: true }).click();
  await page.getByRole('button', { name: 'Cordon', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(() => requests.some(r => r.method === 'PATCH' && r.path === '/api/v1/nodes/worker-1')).toBe(true);
  await page.getByTitle('Create resource', { exact: true }).click();
  await page.getByRole('button', { name: 'Apply to cluster', exact: true }).isDisabled().then(value => assert.equal(value, true));
  await page.getByRole('button', { name: 'Validate manifest', exact: true }).click();
  await expect(page.locator('.validation-result')).toContainText('example-config');
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
  await expect(page.getByRole('menuitem', { name: 'Remove from Kubeconfig', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Add to Hotbar', exact: true }).click();
  await expect(page.locator('.activity-rail .context-icon')).toHaveCount(1);
  await page.getByTitle('Cluster actions: local-test', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Appearance', exact: true }).click();
  await page.getByLabel('Cluster display name', { exact: true }).fill('My test cluster');
  await page.getByRole('button', { name: 'Save appearance', exact: true }).click();
  await expect(page.locator('.cluster-tree-header')).toContainText('My test cluster');
  await page.getByTitle('Cluster actions: local-test', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Show Cluster Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('v1.34.0-test');
  const settingsNav = page.getByRole('navigation', { name: 'Cluster settings sections' });
  for (const name of ['General','Proxy','Terminal','Namespaces','Metrics','Monitoring Stack','Cost','Node Shell']) await expect(settingsNav.getByRole('button', { name, exact: true })).toBeVisible();
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
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
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
  console.log('PASS: cluster context menu, hotbar, appearance, connection settings, connect and backed-up context removal.');
  console.log('PASS: overview metrics, workspace tabs, search, scale, restart, cordon, manifest dry-run/apply.');
  console.log('PASS: secure renderer, discovery, LIST/WATCH and expiry recovery, YAML, confirmed write/delete, live logs, native PTY command execution.');
} catch (error) {
  if (app) {
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
