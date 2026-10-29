import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const temp = await mkdtemp(join(tmpdir(), 'optic-import-smoke-'));
const sockets = new Set(); const mutations = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost'); res.setHeader('Content-Type', 'application/json');
  if (url.searchParams.has('watch')) { res.writeHead(200); res.flushHeaders(); return; }
  if (url.pathname === '/version') return res.end(JSON.stringify({ gitVersion: 'v1.35.0' }));
  if (url.pathname === '/api/v1') return res.end(JSON.stringify({ resources: [{ name: 'configmaps', kind: 'ConfigMap', namespaced: true, verbs: ['get', 'list', 'patch'] }] }));
  if (url.pathname.includes('/configmaps/')) {
    if (req.method === 'PATCH') { if (!url.searchParams.has('dryRun')) mutations.push(url.pathname); return res.end('{}'); }
    res.writeHead(404); return res.end('{}');
  }
  res.end(JSON.stringify({ items: [], metadata: {} }));
});
server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const config = join(temp, 'config');
await writeFile(config, JSON.stringify({ apiVersion: 'v1', kind: 'Config', clusters: [{ name: 'fixture', cluster: { 'insecure-skip-tls-verify': true, server: `http://127.0.0.1:${server.address().port}` } }], users: [{ name: 'test', user: {} }], contexts: [{ name: 'fixture', context: { cluster: 'fixture', user: 'test' } }], 'current-context': 'fixture' }));
let app;
try {
  const env = { ...process.env, WORKBENCH_KUBECONFIG: config }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.', `--user-data-dir=${join(temp, 'profile')}`], env });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await expect(page.getByText('fixture', { exact: true }).first()).toBeVisible();
  const navResize = page.getByRole('separator', { name: 'Resize Navigator', exact: true });
  const navStart = await navResize.boundingBox();
  await page.mouse.move(navStart.x + navStart.width / 2, navStart.y + 120); await page.mouse.down();
  await page.mouse.move(navStart.x + navStart.width / 2 + 100, navStart.y + 120); await page.mouse.up();
  await expect(navResize).toHaveAttribute('aria-valuenow', '345');
  await navResize.focus(); await page.keyboard.press('ArrowRight');
  await expect(navResize).toHaveAttribute('aria-valuenow', '355');
  await page.getByTitle('Toggle Navigator', { exact: true }).click(); await expect(page.locator('.navigator')).toHaveCount(0);
  await page.getByTitle('Toggle Navigator', { exact: true }).click(); await expect(navResize).toHaveAttribute('aria-valuenow', '355');
  await page.reload(); await expect(page.getByRole('separator', { name: 'Resize Navigator', exact: true })).toHaveAttribute('aria-valuenow', '355');
  await navResize.dblclick(); await expect(navResize).toHaveAttribute('aria-valuenow', '245');
  await page.getByRole('button', { name: 'Applications', exact: true }).click();
  await mkdir('artifacts/import-deploy', { recursive: true });
  await page.screenshot({ path: 'artifacts/import-deploy/applications-header.png' });
  await page.getByRole('button', { name: 'Import and deploy', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Import and deploy' });
  await expect(modal).toBeVisible();
  await modal.locator('select').first().selectOption('paste');
  await modal.getByLabel('Imported manifests').fill('kind: [');
  await modal.getByRole('button', { name: 'Validate and review' }).click();
  await expect(modal.getByRole('alert')).toContainText('malformed YAML');
  await modal.getByLabel('Imported manifests').fill(['one', 'two'].map(name => `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\ndata:\n  hello: world`).join('\n---\n'));
  await modal.getByRole('button', { name: 'Validate and review' }).click();
  await expect(modal.locator('tbody tr')).toHaveCount(2).catch(async error => { console.log(await modal.innerText()); throw error; });
  await modal.getByLabel('Default namespace').fill('team');
  await expect(modal.getByRole('button', { name: 'Apply reviewed deployment' })).toBeDisabled();
  await modal.getByRole('button', { name: 'Validate and review' }).click();
  await expect(modal.locator('tbody tr').first()).toContainText('team');
  await mkdir('artifacts/import-deploy', { recursive: true });
  await page.screenshot({ path: 'artifacts/import-deploy/review.png' });
  await modal.getByRole('button', { name: 'Apply reviewed deployment' }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByLabel('Import deployment operations')).toContainText('Deployment completed');
  assert.equal(mutations.length, 2); assert(mutations.every(p => p.includes('/namespaces/team/'))); assert.deepEqual(errors, []);
  await page.screenshot({ path: 'artifacts/import-deploy/completed.png' });
  const file = join(temp, 'import.yaml'); await writeFile(file, 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: from-file\ndata:\n  source: file\n');
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, file);
  await page.evaluate(() => window.dispatchEvent(new Event('optic-import-deploy')));
  await modal.getByRole('button', { name: 'Choose files…' }).click();
  await expect(modal).toContainText('import.yaml');
  await writeFile(file, 'malformed: [');
  await modal.getByRole('button', { name: 'Validate and review' }).click();
  await expect(modal.locator('tbody tr')).toContainText('from-file');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680));
  await expect(modal.getByRole('button', { name: 'Apply reviewed deployment' })).toBeInViewport();
  await page.screenshot({ path: 'artifacts/import-deploy/file-review-small.png' });
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(mutations.length, 2, 'Cancelling a file import must not mutate the cluster');
  console.log('Import deployment Electron smoke passed.');
} finally { if (app) await app.close(); sockets.forEach(s => s.destroy()); await new Promise(resolve => server.close(resolve)); await rm(temp, { recursive: true, force: true }); }
