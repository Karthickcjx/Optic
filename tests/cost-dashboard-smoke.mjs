import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import assert from 'node:assert/strict';
const temp = await mkdtemp(join(tmpdir(), 'optic-cost-smoke-'));
const sockets = new Set(), requests = [];
let fail = false, memoryMissing = false;
const nodes = ['control', 'worker'].map((name, i) => ({ apiVersion: 'v1', kind: 'Node', metadata: { name, uid: name, labels: i ? {} : { 'node-role.kubernetes.io/control-plane': '' } }, status: { allocatable: { cpu: '4', memory: '8Gi', pods: '110' }, addresses: [{ address: `10.0.0.${i + 1}` }], conditions: [{ type: 'Ready', status: 'True' }] } }));
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost'); res.setHeader('Content-Type', 'application/json');
  if (url.searchParams.has('watch')) { res.writeHead(200); res.flushHeaders(); return; }
  if (url.pathname.endsWith('/allocation')) {
    requests.push(Object.fromEntries(url.searchParams));
    if (fail) { res.writeHead(403); res.end('{}'); return; }
    const [start, end] = url.searchParams.get('window').split(',').map(Date.parse);
    const step = url.searchParams.get('step') === '1d' ? 86400000 : 3600000;
    const group = url.searchParams.get('aggregate'), data = [];
    for (let t = start; t < end; t += step) {
      const window = { start: new Date(t).toISOString(), end: new Date(Math.min(t + step, end)).toISOString() };
      data.push({ [group === 'node' ? 'worker-1' : group.includes('controller') ? 'production/Deployment/api' : 'production']: { totalCost: 3, cpuCost: 1, ramCost: 1.5, pvCost: 0.5, window }, ...(url.searchParams.get('includeIdle') === 'true' ? { __idle__: { totalCost: 0.5, window } } : {}) });
    }
    res.end(JSON.stringify({ currency: 'USD', data: memoryMissing ? [] : data })); return;
  }
  if (url.pathname === '/version') { res.end(JSON.stringify({ gitVersion: 'v1.36.0-test' })); return; }
  let items = [];
  if (url.pathname === '/api/v1/services') items = [{ metadata: { name: 'opencost', namespace: 'cost' }, spec: { ports: [{ port: 9003 }] } }];
  else if (url.pathname === '/api/v1/nodes') items = nodes;
  else if (url.pathname === '/apis/metrics.k8s.io/v1beta1/nodes') items = nodes.map(n => ({ metadata: n.metadata, usage: { cpu: '250m', memory: '512Mi' } }));
  else if (url.pathname.endsWith('/namespaces')) items = [{ metadata: { name: 'default' } }];
  res.end(JSON.stringify({ apiVersion: 'v1', kind: 'List', metadata: { resourceVersion: '1' }, items }));
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const config = join(temp, 'config');
await writeFile(config, `apiVersion: v1\nkind: Config\nclusters:\n- name: test\n  cluster:\n    insecure-skip-tls-verify: true\n    server: http://127.0.0.1:${server.address().port}\nusers:\n- name: test\n  user: {}\ncontexts:\n- name: cost-tests\n  context: {cluster: test, user: test}\ncurrent-context: cost-tests\n`);
let app;
try {
  const env = { ...process.env, WORKBENCH_KUBECONFIG: config }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ ...(env.WORKBENCH_TEST_EXECUTABLE ? { executablePath: env.WORKBENCH_TEST_EXECUTABLE } : {}), args: [...(env.WORKBENCH_TEST_EXECUTABLE ? [] : ['.']), `--user-data-dir=${join(temp, 'profile')}`], env });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const capture = async name => { await mkdir('artifacts/cost-dashboard', { recursive: true }); await page.screenshot({ path: `artifacts/cost-dashboard/${name}.png` }); };
  await page.locator('.navigator').getByRole('button', { name: 'Cost', exact: true }).click();
  const dashboard = page.locator('.cost-dashboard');
  const chart = page.getByRole('img', { name: 'Historical cost timeline' });
  await expect(chart.locator('rect')).toHaveCount(24);
  await expect(dashboard.locator('.cost-summary')).toContainText('84.00');
  await dashboard.getByRole('button', { name: 'production', exact: true }).click();
  await expect(dashboard.locator('.cost-detail tbody tr')).toHaveCount(24);
  await capture('01-daily-cost-and-detail');
  await dashboard.getByRole('button', { name: 'Close allocation' }).click();
  await page.getByLabel('Cost time range').selectOption('168');
  await page.getByLabel('Cost grouping').selectOption('controller');
  await page.getByLabel('Include idle costs').uncheck();
  await page.getByRole('button', { name: 'Apply range', exact: true }).click();
  await expect(chart.locator('rect')).toHaveCount(7);
  await expect(dashboard.locator('.cost-summary')).toContainText('21.00');
  assert.equal(requests.at(-1).aggregate, 'namespace,controllerKind,controller');
  assert.equal(requests.at(-1).includeIdle, 'false');
  await capture('02-weekly-workload-cost');
  await page.getByLabel('Search cost allocations').fill('not-present');
  await expect(dashboard).toContainText('No matching allocations.');
  await expect(page.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
  await page.getByLabel('Search cost allocations').fill('');
  const exportPath = join(temp, 'report.json');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, exportPath);
  await page.getByRole('button', { name: 'Export JSON' }).click();
  await expect.poll(async () => { try { return JSON.parse(await readFile(exportPath, 'utf8')).total; } catch { return null; } }).toBe(21);
  const report = JSON.parse(await readFile(exportPath, 'utf8')); assert.equal(report.buckets.length, 7);
  await page.getByRole('button', { name: 'Export CSV' }).click();
  await expect.poll(async () => (await readFile(exportPath, 'utf8')).startsWith('"source"')).toBe(true);

  fail = true; await page.getByRole('button', { name: 'Refresh report' }).click();
  await expect(dashboard.getByRole('alert')).toContainText('may be stale');
  await expect(page.getByRole('button', { name: 'Export JSON' })).toBeDisabled();
  await expect(chart.locator('rect')).toHaveCount(7); await capture('03-stale-report');
  fail = false; memoryMissing = true; await page.getByRole('button', { name: 'Refresh report' }).click();
  await expect(dashboard).toContainText('No allocations were returned');
  await expect(dashboard.locator('.cost-summary')).toContainText('Unavailable');
  await expect(chart).toHaveCount(0);
  memoryMissing = false;
  await page.getByLabel('Cost time range').selectOption('custom');
  await page.getByLabel('Cost start').fill('2026-01-01T00:00');
  await page.getByLabel('Cost end').fill('2026-01-02T00:00');
  await page.getByLabel('Cost grouping').selectOption('node');
  await page.getByRole('button', { name: 'Apply range', exact: true }).click();
  await expect(chart.locator('rect')).toHaveCount(24);
  await expect(dashboard.getByRole('button', { name: 'worker-1', exact: true })).toBeVisible();
  await page.getByLabel('Cost end').fill('2026-03-02T00:00');
  await page.getByRole('button', { name: 'Apply range', exact: true }).click();
  await expect(dashboard.getByRole('alert')).toContainText('valid past range');
  assert.deepEqual(errors, []);
  console.log('PASS: cost history, date ranges, grouping, idle costs, allocation detail, search, JSON download, stale report, unavailable data and invalid dates.');

} catch (error) {
  await mkdir('artifacts', { recursive: true }); if (app) await (await app.firstWindow()).screenshot({ path: 'artifacts/cost-dashboard-failure.png' }).catch(() => {}); throw error;
} finally {
  await app?.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
  if (resolve(temp).startsWith(resolve(tmpdir()) + sep)) await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}
