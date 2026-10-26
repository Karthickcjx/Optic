import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import assert from 'node:assert/strict';
const temp = await mkdtemp(join(tmpdir(), 'optic-cost-smoke-'));
const sockets = new Set(), requests = [];
let fail = false, memoryMissing = false, estimateMissing = false, estimateSince = 0, delayRange = false;
const metricRequests = [];
const nodes = ['control', 'worker'].map((name, i) => ({ apiVersion: 'v1', kind: 'Node', metadata: { name, uid: name, labels: i ? {} : { 'node-role.kubernetes.io/control-plane': '' } }, status: { capacity: { cpu: '4', memory: '8Gi' }, allocatable: { cpu: '4', memory: '8Gi', pods: '110' }, addresses: [{ address: `10.0.0.${i + 1}` }], conditions: [{ type: 'Ready', status: 'True' }] } }));
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost'); res.setHeader('Content-Type', 'application/json');
  if (url.searchParams.has('watch')) { res.writeHead(200); res.flushHeaders(); return; }
  if (url.pathname.endsWith('/query_range')) {
    const expression = url.searchParams.get('query'), start = Number(url.searchParams.get('start')), end = Number(url.searchParams.get('end')), step = Number(url.searchParams.get('step'));
    metricRequests.push({ expression, start, end, step });
    const availability = expression.includes('vector(1)'), capacity = expression.includes('kube_node_status_capacity'), memory = expression.includes('resource="memory"') || expression.includes('container_memory_working_set_bytes'), request = expression.includes('kube_pod_container_resource_requests');
    const value = availability ? 1 : capacity ? (memory ? 8 * 1024 ** 3 : 4) : request ? (memory ? 2 * 1024 ** 3 : 1) : (memory ? 1024 ** 3 : 0.5);
    const labels = availability ? {} : capacity ? { node: 'worker' } : { namespace: 'production', pod: 'api', node: 'worker' };
    const values = Array.from({ length: Math.floor((end - start) / step) + 1 }, (_, i) => {
      const t = start + i * step, fraction = Math.max(0, Math.min(1, (t - Math.max(t - step, estimateSince)) / step));
      return [t, String(value * fraction)];
    }).filter(([, value]) => Number(value) > 0);
    const send = () => res.end(JSON.stringify({ status: 'success', data: { resultType: 'matrix', result: estimateMissing ? [] : [{ metric: labels, values }] } }));
    if (delayRange && step > 60) setTimeout(send, 1200); else send(); return;
  }
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
  await expect(page.getByLabel('Cost time range')).toHaveValue('1');
  await expect(chart.locator('rect')).toHaveCount(1);
  await expect(dashboard.locator('.cost-summary')).toContainText('3.50');
  await chart.hover();
  await expect(page.getByRole('tooltip')).toContainText('Cost: 3.50');
  await chart.focus();
  await chart.press('End');
  await expect(page.getByRole('tooltip')).toBeVisible();
  await chart.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);

  await dashboard.getByRole('button', { name: 'production', exact: true }).click();
  await expect(dashboard.locator('.cost-detail tbody tr')).toHaveCount(1);
  await capture('01-hourly-cost-and-detail');
  await dashboard.getByRole('button', { name: 'Close allocation' }).click();
  // Every allocation-provider preset and a rolling refresh.
  for (const [range, count] of [['1', 1], ['6', 6], ['24', 24], ['168', 7], ['720', 30]]) {
    await page.getByLabel('Cost time range').selectOption(range);
    await page.getByRole('button', { name: 'Apply range', exact: true }).click();
    await expect(chart.locator('rect')).toHaveCount(count);
  }
  const priorEnd = Date.parse(requests.at(-1).window.split(',')[1]);
  await page.getByRole('button', { name: 'Refresh report' }).click();
  await expect.poll(() => Date.parse(requests.at(-1).window.split(',')[1])).toBeGreaterThan(priorEnd);
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
  await expect(dashboard.locator('.cost-summary').first()).toContainText('Unavailable');
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
  await expect(page.getByRole('button', { name: 'Export JSON' })).toBeEnabled();
  await expect(dashboard.getByRole('alert')).not.toContainText('stale');
  // Exercise the real Estimate IPC/settings path without an allocation service or external pricing calls.
  await page.evaluate(async () => {
    const clusters = await window.desktop.request('clusters:list'); const clusterId = clusters.data.clusters[0].id;
    const saved = await window.desktop.request('settings:get', { clusterId });
    const result = await window.desktop.request('settings:save', { clusterId, settings: { ...saved.data, costSource: 'estimate', estimatePublicPrices: false, prometheus: { namespace: 'metrics', service: 'prometheus', port: 9090 } } });
    if (!result.ok) throw new Error(result.error.message);
  });
  await page.getByLabel('Cost time range').selectOption('24');
  await page.getByLabel('Cost grouping').selectOption('namespace');
  await page.getByLabel('Include idle costs').check();
  await page.getByRole('button', { name: 'Apply range', exact: true }).click();
  await expect(dashboard).toContainText('Prometheus estimate');
  await expect(chart.locator('rect')).toHaveCount(287);
  await expect(dashboard).toContainText('50.0%');
  await dashboard.locator('.cost-node-prices summary').click();
  await expect(dashboard.locator('.cost-node-prices')).toContainText('Configured CPU/RAM fallback rates');
  await dashboard.evaluate(e => { e.scrollTop = 0; }); await capture('05-prometheus-estimate');
  await page.getByRole('button', { name: 'Export JSON' }).click();
  await expect.poll(async () => { try { return JSON.parse(await readFile(exportPath, 'utf8')).estimated; } catch { return false; } }).toBe(true);
  const estimate = JSON.parse(await readFile(exportPath, 'utf8'));
  assert.ok(estimate.idleCost > 0); assert.equal(estimate.efficiency.cpu, 0.5); assert.ok(estimate.nodePrices.length > 0); assert.ok(estimate.buckets.length > 0);
  await expect(dashboard.locator('.cost-warning').filter({ hasText: 'Historical coverage is partial' })).toHaveCount(0);
  estimateSince = Date.now() / 1000 - 3600;
  await page.getByRole('button', { name: 'Apply range', exact: true }).click();
  await expect(dashboard.locator('.cost-history-coverage')).toContainText('Available estimate intervals');
  await expect(page.getByRole('button', { name: 'Use available history', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use available history', exact: true }).click();
  await expect(page.getByLabel('Cost time range')).toHaveValue('custom');
  await expect(dashboard).toContainText('Prometheus estimate');
  const selectedStart = await page.getByLabel('Cost start').inputValue(), selectedEnd = await page.getByLabel('Cost end').inputValue();
  assert.ok(new Date(selectedEnd) - new Date(selectedStart) <= 65 * 60000);
  await capture('07-available-cost-history');
  await page.getByLabel('Cost time range').selectOption('1');
  await page.getByRole('button', { name: 'Apply range', exact: true }).click();
  await expect(dashboard).toContainText('Prometheus estimate');
  estimateSince = Date.now() / 1000 - 3600;
  // Exercise every Estimate preset, including the newest incomplete wide interval.
  for (const [range, step] of [['1', 60], ['6', 120], ['24', 300], ['168', 2100], ['720', 9000]]) {
    await page.getByLabel('Cost time range').selectOption(range);
    await page.getByRole('button', { name: 'Apply range', exact: true }).click();
    await expect.poll(() => metricRequests.at(-1)?.step).toBe(step);
    await expect(page.getByRole('button', { name: 'Refresh report' })).toBeEnabled();
    await expect(chart).toBeVisible();
    assert.ok(Math.abs(metricRequests.at(-1).end - Date.now() / 1000) < 61);
    await page.getByRole('button', { name: 'Export JSON' }).click();
    await expect.poll(async () => { try { const r = JSON.parse(await readFile(exportPath, 'utf8')); return Math.round((r.end - r.start) / 3600000); } catch { return 0; } }).toBe(Number(range));
  }
  // A refresh must really re-query even inside the 30-second cache window.
  const beforeRefresh = metricRequests.length;
  await page.getByRole('button', { name: 'Refresh report' }).click();
  await expect.poll(() => metricRequests.length).toBeGreaterThan(beforeRefresh);
  await expect(page.getByRole('button', { name: 'Refresh report' })).toBeEnabled();
  delayRange = true;
  await page.getByLabel('Cost time range').selectOption('6');
  await page.getByRole('button', { name: 'Apply range', exact: true }).click();
  await expect.poll(() => metricRequests.at(-1)?.step).toBe(120);
  await page.getByLabel('Cost time range').selectOption('1');
  await page.getByRole('button', { name: 'Apply range', exact: true }).click();
  await expect(chart.locator('rect')).toHaveCount(59);
  await page.waitForTimeout(1400); // Let the intentionally delayed old range finish.
  await expect(chart.locator('rect')).toHaveCount(59); delayRange = false;
  await page.getByLabel('Cost time range').selectOption('custom');
  for (const [a, b] of [['2026-01-02T00:00', '2026-01-01T00:00'], ['2026-01-01T00:00', '2026-02-02T00:00'], ['', '2026-01-01T00:00'], ['2035-01-01T00:00', '2035-01-02T00:00']]) {
    await page.getByLabel('Cost start').fill(a); await page.getByLabel('Cost end').fill(b);
    await page.getByRole('button', { name: 'Apply range', exact: true }).click();
    await expect(dashboard.getByRole('alert')).toContainText('valid past range');
    await expect(chart.locator('rect')).toHaveCount(59);
  }
  estimateSince = 0;
  await page.getByLabel('Cost start').fill('2026-01-01T00:00'); await page.getByLabel('Cost end').fill('2026-02-01T00:00');
  await page.getByRole('button', { name: 'Apply range', exact: true }).click();
  await expect(dashboard.getByRole('alert')).toHaveCount(0); await expect(chart).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh report' })).toBeEnabled();
  const fixedWindow = metricRequests.at(-1);
  await page.getByRole('button', { name: 'Refresh report' }).click();
  await expect(page.getByRole('button', { name: 'Refresh report' })).toBeEnabled();
  assert.equal(metricRequests.at(-1).end, fixedWindow.end); assert.equal(metricRequests.at(-1).start, fixedWindow.start);
  estimateMissing = true;
  await page.getByRole('button', { name: 'Refresh report' }).click();
  await expect(dashboard).toContainText('No complete CPU/memory cost observations');
  await expect(dashboard.locator('.cost-summary').first()).toContainText('Unavailable');
  await expect(dashboard.getByRole('alert')).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log('PASS: cost history, date ranges, grouping, idle costs, allocation detail, search, JSON download, stale report, unavailable data, invalid dates and Prometheus estimates with node rates, idle costs and efficiency.');

} catch (error) {
  await mkdir('artifacts', { recursive: true }); if (app) await (await app.firstWindow()).screenshot({ path: 'artifacts/cost-dashboard-failure.png' }).catch(() => {}); throw error;
} finally {
  await app?.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
  if (resolve(temp).startsWith(resolve(tmpdir()) + sep)) await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}
