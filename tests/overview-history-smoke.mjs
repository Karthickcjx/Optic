import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import assert from 'node:assert/strict';
const temp = await mkdtemp(join(tmpdir(), 'optic-history-smoke-'));
const sockets = new Set(), requests = [];
let fail = false, memoryMissing = false, delayed = false;
const nodes = ['control', 'worker'].map((name, i) => ({ apiVersion: 'v1', kind: 'Node', metadata: { name, uid: name, labels: i ? {} : { 'node-role.kubernetes.io/control-plane': '' } }, status: { allocatable: { cpu: '4', memory: '8Gi', pods: '110' }, addresses: [{ address: `10.0.0.${i + 1}` }], conditions: [{ type: 'Ready', status: 'True' }] } }));
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost'); res.setHeader('Content-Type', 'application/json');
  if (url.searchParams.has('watch')) { res.writeHead(200); res.flushHeaders(); return; }
  if (url.pathname.endsWith('/query_range')) {
    const start = Number(url.searchParams.get('start')), end = Number(url.searchParams.get('end')), step = Number(url.searchParams.get('step'));
    const cpu = url.searchParams.get('query').includes('cpu'); requests.push({ start, end, step, cpu });
    if (fail) { res.writeHead(403); res.end('{}'); return; }
    const result = !cpu && memoryMissing ? [] : nodes.map((n, i) => ({ metric: { node: n.metadata.name }, values: Array.from({ length: Math.floor((end - start) / step) + 1 }, (_, j) => [start + j * step, String((cpu ? 0.1 : 256 * 1024 ** 2) * (i + 1) * (1 + j % 5 / 10))]).filter((_, j) => j < 10 || j > 20) }));
    const send = () => res.end(JSON.stringify({ status: 'success', data: { resultType: 'matrix', result } }));
    if (delayed && end - start === 3600) setTimeout(send, 1200); else send(); return;
  }
  if (url.pathname === '/version') { res.end(JSON.stringify({ gitVersion: 'v1.36.0-test' })); return; }
  let items = [];
  if (url.pathname === '/api/v1/services') items = [{ metadata: { name: 'prometheus', namespace: 'monitoring' }, spec: { ports: [{ port: 9090 }] } }];
  else if (url.pathname === '/api/v1/nodes') items = nodes;
  else if (url.pathname === '/apis/metrics.k8s.io/v1beta1/nodes') items = nodes.map(n => ({ metadata: n.metadata, usage: { cpu: '250m', memory: '512Mi' } }));
  else if (url.pathname.endsWith('/namespaces')) items = [{ metadata: { name: 'default' } }];
  res.end(JSON.stringify({ apiVersion: 'v1', kind: 'List', metadata: { resourceVersion: '1' }, items }));
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const config = join(temp, 'config');
await writeFile(config, `apiVersion: v1\nkind: Config\nclusters:\n- name: test\n  cluster:\n    insecure-skip-tls-verify: true\n    server: http://127.0.0.1:${server.address().port}\nusers:\n- name: test\n  user: {}\ncontexts:\n- name: history-tests\n  context: {cluster: test, user: test}\ncurrent-context: history-tests\n`);
let app;
try {
  const env = { ...process.env, WORKBENCH_KUBECONFIG: config }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ ...(env.WORKBENCH_TEST_EXECUTABLE ? { executablePath: env.WORKBENCH_TEST_EXECUTABLE } : {}), args: [...(env.WORKBENCH_TEST_EXECUTABLE ? [] : ['.']), `--user-data-dir=${join(temp, 'profile')}`], env });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const capture = async name => { await mkdir('artifacts/overview-history', { recursive: true }); await page.screenshot({ path: `artifacts/overview-history/${name}.png` }); };
  await page.locator('.navigator').getByRole('button', { name: 'Overview', exact: true }).click();
  const chart = page.getByRole('img', { name: 'Prometheus usage history', exact: true });
  await expect(chart.locator('circle')).toHaveCount(50);
  await chart.hover();
  await expect(page.getByRole('tooltip')).toContainText('CPU:');
  await page.getByRole('img', { name: 'CPU: 0.50 used', exact: true }).hover();
  await expect(page.getByRole('tooltip')).toContainText('Allocatable:');
  await page.mouse.move(0, 0);
  await expect(chart.locator('polyline')).toHaveCount(2); // A missing scrape interval stays a gap.
  assert.ok(requests[0].start < Date.now() / 1000 - 14 * 60);
  await expect(page.locator('.overview-page')).toContainText('History source: Prometheus');
  await expect(page.getByRole('img', { name: 'CPU: 0.50 used', exact: true })).toBeVisible();
  await capture('01-immediate-history');
  const allTitle = await chart.locator('circle title').first().textContent();
  await page.getByLabel('Monitor nodes', { exact: true }).selectOption('workers');
  const workerTitle = await chart.locator('circle title').first().textContent(); assert.notEqual(allTitle, workerTitle);
  await page.getByRole('button', { name: 'Memory', exact: true }).click();
  await expect(chart.locator('circle title').first()).toContainText('MiB');
  await page.getByLabel('Metrics time range', { exact: true }).selectOption('1440');
  await expect.poll(() => requests.some(r => r.end - r.start === 86400)).toBe(true);
  await expect(chart.locator('circle')).toHaveCount(230); await capture('02-worker-memory-24h');
  await page.getByRole('button', { name: 'Absolute units', exact: true }).click();
  await expect(chart.locator('circle title').first()).toContainText('%');
  fail = true; await page.getByTitle('Refresh overview', { exact: true }).click();
  await expect(page.locator('.overview-toolbar')).toContainText('History stale');
  await expect(chart.locator('circle')).toHaveCount(230); await capture('03-stale-history');
  fail = false; memoryMissing = true; await page.getByTitle('Refresh overview', { exact: true }).click();
  await expect(page.locator('.overview-page')).toContainText('Historical memory data is unavailable');
  await expect(chart.locator('circle')).toHaveCount(0);
  await page.getByRole('button', { name: 'CPU', exact: true }).click(); await expect(chart.locator('circle')).toHaveCount(230);
  memoryMissing = false; delayed = true;
  await page.getByLabel('Metrics time range', { exact: true }).selectOption('60');
  await expect.poll(() => requests.some(r => r.end - r.start === 3600)).toBe(true);
  await page.getByLabel('Metrics time range', { exact: true }).selectOption('5');
  await expect(chart.locator('circle')).toHaveCount(10);
  await page.waitForTimeout(1400); // Let the deliberately delayed old range finish.
  await expect(chart.locator('circle')).toHaveCount(10);
  const before = requests.length;
  await page.getByTitle('Close Cluster Overview — history-tests', { exact: true }).click();
  await page.locator('.navigator').getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(chart.locator('circle')).toHaveCount(50); assert.ok(requests.length > before);
  assert.deepEqual(errors, []);
  console.log('PASS: immediate Prometheus history, 24h range, worker scope, CPU/memory/percent, missing intervals, stale history, missing metric, late-response isolation and reopening.');
} catch (error) {
  await mkdir('artifacts', { recursive: true }); if (app) await (await app.firstWindow()).screenshot({ path: 'artifacts/overview-history-failure.png' }).catch(() => {}); throw error;
} finally {
  await app?.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
  if (resolve(temp).startsWith(resolve(tmpdir()) + sep)) await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}
