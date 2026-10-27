import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import assert from 'node:assert/strict';

const temp = await mkdtemp(join(tmpdir(), 'optic-security-smoke-'));
const sockets = new Set(), requests = [];
let mode = 'ready', replaced = false;
const base = { apiVersion: 'aquasecurity.github.io/v1alpha1', metadata: { name: 'replicaset-api-server', namespace: 'default', uid: 'report-uid', ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'api', uid: 'owner-uid', controller: true }], labels: { 'trivy-operator.container.name': 'server' } } };
const vulnerability = { ...base, kind: 'VulnerabilityReport', report: { updateTimestamp: '2026-10-26T10:00:00Z', scanner: { name: 'Trivy', version: 'test' }, artifact: { repository: 'api', tag: '1' }, registry: { server: 'registry.test' }, vulnerabilities: [
 { vulnerabilityID: 'CVE-TEST-001', severity: 'CRITICAL', resource: 'libssl', installedVersion: '1.0', fixedVersion: '1.1', score: 9.8, title: 'Test critical vulnerability', description: 'Update the package.' },
 { vulnerabilityID: 'CVE-TEST-002', severity: 'HIGH', resource: 'libc', installedVersion: '2.0', fixedVersion: '' }
] } };
const audit = { ...base, kind: 'ConfigAuditReport', metadata: { ...base.metadata, uid: 'audit-uid', name: 'replicaset-api' }, report: { updateTimestamp: '2026-10-26T10:00:00Z', scanner: { name: 'Trivy' }, checks: [
 { checkID: 'ROOT', severity: 'HIGH', success: false, messages: ['Container runs as root'] },
 { checkID: 'PASS', severity: 'CRITICAL', success: true }
] } };
const server = createServer((req, res) => {
 const url = new URL(req.url, 'http://localhost'); res.setHeader('Content-Type', 'application/json');
 requests.push({ path: url.pathname, method: req.method });
 if (url.searchParams.has('watch')) { res.writeHead(200); res.flushHeaders(); return; }
 if (url.pathname.startsWith('/apis/aquasecurity.github.io/')) {
  if (mode === 'missing') { res.writeHead(404); res.end('{}'); return; }
  if (mode === 'forbidden' && url.pathname.includes('configauditreports')) { res.writeHead(403); res.end('{}'); return; }
  if (mode === 'error') { res.writeHead(500); res.end('{}'); return; }
  const report = url.pathname.includes('configauditreports') ? audit : vulnerability;
  if (url.pathname.endsWith('/' + report.metadata.name)) { res.end(JSON.stringify(report)); return; }
  res.end(JSON.stringify({ items: mode === 'empty' ? [] : [report], metadata: {} })); return;
 }
 if (url.pathname === '/apis/apps/v1/namespaces/default/replicasets/api') { res.end(JSON.stringify({ apiVersion: 'apps/v1', kind: 'ReplicaSet', metadata: { name: 'api', namespace: 'default', uid: replaced ? 'other-owner' : 'owner-uid' }, spec: { replicas: 1 }, status: {} })); return; }
 if (url.pathname === '/version') { res.end(JSON.stringify({ gitVersion: 'v1.36.0-test' })); return; }
 const items = url.pathname.endsWith('/namespaces') ? [{ metadata: { name: 'default' } }, { metadata: { name: 'team' } }] : [];
 res.end(JSON.stringify({ apiVersion: 'v1', kind: 'List', metadata: { resourceVersion: '1' }, items }));
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const config = join(temp, 'config');
await writeFile(config, `apiVersion: v1\nkind: Config\nclusters:\n- name: test\n  cluster:\n    insecure-skip-tls-verify: true\n    server: http://127.0.0.1:${server.address().port}\nusers:\n- name: test\n  user: {}\ncontexts:\n- name: security-tests\n  context: {cluster: test, user: test}\ncurrent-context: security-tests\n`);
let app;
try {
  const env = { ...process.env, WORKBENCH_KUBECONFIG: config }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ ...(env.WORKBENCH_TEST_EXECUTABLE ? { executablePath: env.WORKBENCH_TEST_EXECUTABLE } : {}), args: [...(env.WORKBENCH_TEST_EXECUTABLE ? [] : ['.']), `--user-data-dir=${join(temp, 'profile')}`], env });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));

  await page.locator('.navigator').getByRole('button', { name: 'Security', exact: true }).click();
  const dashboard = page.locator('.security-page');
  await expect(dashboard.locator('tbody tr')).toHaveCount(2);
  await expect(dashboard).toContainText('Image vulnerabilities: 1 reports');
  await expect(dashboard.locator('.security-counts')).toContainText('CRITICAL1');
  await page.getByLabel('Security severity', { exact: true }).selectOption('CRITICAL');
  await expect(dashboard.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'replicaset-api-server', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Security report details' });
  await expect(modal).toContainText('CVE-TEST-001');
  await expect(modal).toContainText('registry.test/api:1');
  await expect(modal.locator('tbody tr')).toHaveCount(2);
  await modal.getByLabel('Fix available', { exact: true }).check();
  await expect(modal.locator('tbody tr')).toHaveCount(1);
  await modal.getByLabel('Search security findings').fill('missing-cve');
  await expect(modal).toContainText('No matching findings');
  await modal.getByLabel('Search security findings').fill('');
  await mkdir('artifacts/security', { recursive: true });
  await page.screenshot({ path: 'artifacts/security/01-vulnerability-details.png' });
  replaced = true;
  await modal.getByRole('button', { name: 'Open ReplicaSet / api' }).click();
  await expect(modal.getByRole('alert')).toContainText('deleted or replaced');
  replaced = false;
  await modal.getByRole('button', { name: 'Open ReplicaSet / api' }).click();
  await expect(page.getByRole('dialog', { name: 'Security report details' })).toHaveCount(0);
  await page.locator('.navigator').getByRole('button', { name: 'Security', exact: true }).click();
  await expect(dashboard.locator('tbody tr')).toHaveCount(2);
  await page.getByLabel('Security report type').selectOption('configauditreports');
  await expect(dashboard.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'replicaset-api', exact: true }).click();
  await expect(modal).toContainText('1 checks passed');
  await expect(modal.locator('tbody tr')).toHaveCount(1);
  await modal.getByText('Description', { exact: true }).click();
  await expect(modal).toContainText('Container runs as root');
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await page.getByLabel('Security report type').selectOption('all');
  mode = 'forbidden';
  await page.getByRole('button', { name: 'Refresh reports', exact: true }).click();
  await expect(dashboard).toContainText('Access denied');
  await expect(dashboard.locator('tbody tr')).toHaveCount(1);
  await page.screenshot({ path: 'artifacts/security/02-partial-permissions.png' });
  mode = 'missing';
  await page.getByRole('button', { name: 'Refresh reports', exact: true }).click();
  await expect(dashboard).toContainText('Report API unavailable');
  await expect(dashboard.locator('tbody tr')).toHaveCount(0);
  mode = 'empty';
  await page.getByRole('button', { name: 'Refresh reports', exact: true }).click();
  await expect(dashboard).toContainText('Image vulnerabilities: 0 reports');
  await expect(dashboard).toContainText('scans may still be pending');
  mode = 'error';
  await page.getByRole('button', { name: 'Refresh reports', exact: true }).click();
  await expect(dashboard).toContainText('Request failed');
  mode = 'ready';
  await page.getByLabel('Security namespace', { exact: true }).selectOption('team');
  await expect(dashboard.locator('tbody tr')).toHaveCount(2);
  assert.ok(requests.some(r => r.path.includes('/namespaces/team/vulnerabilityreports')));
  await page.screenshot({ path: 'artifacts/security/03-security-dashboard.png' });
  assert.ok(requests.every(r => r.method === 'GET'), 'Security inspection must not mutate the cluster');
  assert.deepEqual(errors, []);
  console.log('PASS: security reports, severity and fix filters, package details, config checks, owner UID protection/navigation, missing operator, partial RBAC, errors, empty reports and namespace scope.');
} catch (error) {
  await mkdir('artifacts', { recursive: true }); if (app) await (await app.firstWindow()).screenshot({ path: 'artifacts/security-failure.png' }).catch(() => {}); throw error;
} finally {
  await app?.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
  if (resolve(temp).startsWith(resolve(tmpdir()) + sep)) await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}
