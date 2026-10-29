import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import assert from 'node:assert/strict';
const temp = await mkdtemp(join(tmpdir(), 'optic-streams-smoke-'));
const sockets = new Set(), activeLogs = new Map(), logRequests = [];
let denyBeta = false;
const pod = name => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: 'default', uid: name, resourceVersion: '1', labels: { app: 'demo' } }, spec: { containers: [{ name: 'app', image: 'busybox' }] }, status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: true, restartCount: 0 }] } });
const pods = [pod('alpha'), pod('beta')];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Content-Type', 'application/json');
  if (url.pathname.endsWith('/log')) {
    const name = url.pathname.split('/').at(-2), previous = url.searchParams.get('previous') === 'true';
    logRequests.push({ pod: name, sinceTime: url.searchParams.get('sinceTime'), tailLines: url.searchParams.get('tailLines'), previous });
    if (name === 'beta' && denyBeta) { res.writeHead(403); res.end('{}'); return; }
    res.setHeader('Content-Type', 'text/plain');
    if (previous) { res.end(`2026-10-25T10:00:00Z ${name} previous container\n`); return; }
    activeLogs.set(name, res); res.on('close', () => { if (activeLogs.get(name) === res) activeLogs.delete(name); });
    if (name === 'alpha') {
      res.write('2026-10-25T10:00:00.123456789Z level=error alpha failure\n');
      if (url.searchParams.has('sinceTime')) res.write('2026-10-25T10:00:01.123456789Z alpha recovered\n');
    } else {
      const buffer = Buffer.from('2026-10-25T10:00:00.123456789Z beta café 日志\n');
      res.write(buffer.subarray(0, buffer.length - 3)); res.write(buffer.subarray(buffer.length - 3));
    }
    return;
  }
  if (url.searchParams.has('watch')) { res.writeHead(200); res.flushHeaders(); return; }
  if (url.pathname === '/version') { res.end(JSON.stringify({ gitVersion: 'v1.36.0-test' })); return; }
  const selected = pods.find(p => url.pathname.endsWith(`/pods/${p.metadata.name}`));
  if (selected) { res.end(JSON.stringify(selected)); return; }
  res.end(JSON.stringify({ apiVersion: 'v1', kind: 'List', metadata: { resourceVersion: '1' }, items: url.pathname.endsWith('/pods') ? pods : url.pathname.endsWith('/namespaces') ? [{ metadata: { name: 'default', uid: 'namespace' } }] : [] }));
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const config = join(temp, 'config');
await writeFile(config, `apiVersion: v1\nkind: Config\nclusters:\n- name: test\n  cluster:\n    insecure-skip-tls-verify: true\n    server: http://127.0.0.1:${server.address().port}\nusers:\n- name: test\n  user: {}\ncontexts:\n- name: stream-tests\n  context:\n    cluster: test\n    user: test\ncurrent-context: stream-tests\n`);
let app;
try {
  const env = { ...process.env, WORKBENCH_KUBECONFIG: config }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ ...(env.WORKBENCH_TEST_EXECUTABLE ? { executablePath: env.WORKBENCH_TEST_EXECUTABLE } : {}), args: [...(env.WORKBENCH_TEST_EXECUTABLE ? [] : ['.']), `--user-data-dir=${join(temp, 'profile')}`], env });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const capture = async name => { await mkdir('artifacts/advanced-streams', { recursive: true }); await page.screenshot({ path: `artifacts/advanced-streams/${name}.png` }); };
  await page.getByLabel('Find in Navigator', { exact: true }).fill('Pods');
  await page.locator('.navigator').getByRole('button', { name: 'Pods', exact: true }).click();
  await page.getByLabel('Select alpha', { exact: true }).check(); await page.getByLabel('Select beta', { exact: true }).check();
  await page.getByRole('button', { name: 'Logs for selected Pods', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Choose log sources' })).toContainText('2 / 8 sources selected'); await capture('01-source-selection');
  await page.getByRole('button', { name: 'Open log streams', exact: true }).click();
  await expect(page.locator('.logs')).toContainText('[default/alpha/app]'); await expect(page.locator('.logs')).toContainText('beta café 日志');
  await expect(page.locator('.log-source-status summary')).toContainText('2/2 sources live'); await capture('02-multi-pod-logs');
  activeLogs.get('alpha').destroy();
  await expect.poll(() => logRequests.filter(r => r.pod === 'alpha').length).toBe(2);
  await expect(page.locator('.logs')).toContainText('alpha recovered');
  assert.equal(logRequests.filter(r => r.pod === 'alpha')[1].sinceTime, '2026-10-25T10:00:00.123456789Z');
  assert.equal(logRequests.filter(r => r.pod === 'alpha')[1].tailLines, null);
  await expect(page.locator('.logs .log-line').filter({ hasText: 'alpha failure' })).toHaveCount(1);
  await expect(page.locator('.logs .severity-error')).toHaveCount(1);
  const exportPath = join(temp, 'export.log');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, exportPath);
  await page.getByRole('button', { name: 'Export retained', exact: true }).click(); await expect(page.getByRole('status').filter({ hasText: 'Logs exported.' })).toBeVisible();
  assert.match(await readFile(exportPath, 'utf8'), /\[default\/beta\/app\].*café 日志/);
  await page.getByLabel('Filter log lines', { exact: true }).fill('level=error');
  await page.getByRole('button', { name: 'Export filtered', exact: true }).click();
  await expect.poll(async () => (await readFile(exportPath, 'utf8')).includes('beta')).toBe(false);
  assert.match(await readFile(exportPath, 'utf8'), /alpha failure/);
  await page.getByLabel('Filter log lines', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Stop logs', exact: true }).click(); await expect.poll(() => activeLogs.size).toBe(0);
  denyBeta = true; await page.getByRole('button', { name: 'Reconnect logs', exact: true }).click();
  await expect(page.locator('.log-source-row.severity-error')).toContainText('RBAC');
  await expect(page.locator('.log-source-status summary')).toContainText('1/2 sources live'); await capture('03-independent-source-error');
  const deniedCount = logRequests.filter(r => r.pod === 'beta').length;
  denyBeta = false; await page.getByRole('button', { name: 'Reconnect default/beta/app', exact: true }).click();
  await expect(page.locator('.log-source-status summary')).toContainText('2/2 sources live'); assert.equal(logRequests.filter(r => r.pod === 'beta').length, deniedCount + 1);
  await page.getByLabel('Previous container', { exact: true }).check(); await expect(page.locator('.logs')).toContainText('previous container');
  await expect(page.getByLabel('Auto reconnect', { exact: true })).toBeDisabled();
  await page.getByTitle('Close session', { exact: true }).click(); await expect.poll(() => activeLogs.size).toBe(0);

  // Pod sessions use controlled IPC responses; local terminal below uses real node-pty.
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const original = ipcMain._invokeHandlers.get('terminal:open'); globalThis.shellCalls = []; globalThis.localShellCalls = [];
    ipcMain.removeHandler('terminal:open'); ipcMain.handle('terminal:open', (event, input) => {
      if (!input.pod) { globalThis.localShellCalls.push(input); return original(event, input); }
      globalThis.shellCalls.push(input);
      setTimeout(() => BrowserWindow.getAllWindows()[0].webContents.send('stream:event', { id: input.id, type: 'data', data: `shell ${input.shell} ready\r\n`, seq: 1 }), 50);
      return { ok: true };
    });
  });
  await page.locator('tbody .resource-name').filter({ hasText: /^alpha$/ }).click();
  await page.getByRole('button', { name: 'Shell', exact: true }).click();
  await expect(page.locator('.terminal-pane [role=status]')).toHaveText('Connected');
  await page.getByLabel('Container shell', { exact: true }).fill('/bin/sh -c invalid'); await expect(page.getByRole('button', { name: 'Reconnect terminal', exact: true })).toBeDisabled();
  await page.getByLabel('Container shell', { exact: true }).fill('/bin/bash'); await page.getByRole('button', { name: 'Reconnect terminal', exact: true }).click();
  await expect(page.locator('.terminal-host')).toContainText('shell /bin/bash ready');
  const calls = await app.evaluate(() => globalThis.shellCalls); assert.equal(calls.length, 2); assert.equal(calls[1].shell, '/bin/bash'); assert.notEqual(calls[0].id, calls[1].id);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('stream:event', { id: globalThis.shellCalls.at(-1).id, type: 'end', exitCode: 0 }));
  await expect(page.locator('.terminal-pane [role=status]')).toHaveText('Ended');
  await capture('04-configurable-shell-ended');
  assert.equal((await app.evaluate(() => globalThis.shellCalls)).length, 2);
  await page.getByTitle('Close session', { exact: true }).click();
  await page.getByTitle('Local terminal', { exact: true }).click();
  await expect(page.locator('.terminal-pane [role=status]')).toHaveText('Connected');
  await page.locator('.terminal-host .xterm-helper-textarea').focus(); await page.keyboard.type('echo OPTIC_FRESH_TERMINAL'); await page.keyboard.press('Enter');
  await expect(page.locator('.terminal-host')).toContainText('OPTIC_FRESH_TERMINAL');
  await page.getByRole('button', { name: 'Disconnect terminal', exact: true }).click(); await expect(page.locator('.terminal-pane [role=status]')).toHaveText('Disconnected');
  await page.getByRole('button', { name: 'Reconnect terminal', exact: true }).click(); await expect(page.locator('.terminal-pane [role=status]')).toHaveText('Connected');
  await capture('05-terminal-reconnected');
  const savedClipboard = await app.evaluate(async ({ clipboard }) => await clipboard.readText());
  try {
    await app.evaluate(async ({ clipboard }) => await clipboard.writeText('echo OPTIC_%OS%_CLIPBOARD'));
    await page.locator('.terminal-host .xterm-helper-textarea').focus();
    await page.keyboard.press('Control+Shift+V');
    await expect(page.locator('.terminal-host')).toContainText('echo OPTIC_%OS%_CLIPBOARD');
    await page.keyboard.press('Enter');
    await expect(page.locator('.terminal-host')).toContainText('OPTIC_Windows_NT_CLIPBOARD');
    await page.locator('.terminal-host').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Select all', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect.poll(async () => app.evaluate(async ({ clipboard }) => await clipboard.readText())).toContain('OPTIC_Windows_NT_CLIPBOARD');
    await app.evaluate(async ({ clipboard }) => await clipboard.writeText('clipboard sentinel'));
    await page.locator('.terminal-host .xterm-helper-textarea').focus();
    await page.keyboard.press('Control+Shift+C');
    await expect.poll(async () => app.evaluate(async ({ clipboard }) => await clipboard.readText())).toContain('OPTIC_Windows_NT_CLIPBOARD');
    await page.keyboard.press('Escape');
    await app.evaluate(async ({ clipboard }) => await clipboard.writeText('echo OPTIC_PASTE_BUTTON'));
    await page.getByRole('button', { name: 'Paste', exact: true }).click();
    await expect(page.locator('.terminal-host')).toContainText('echo OPTIC_PASTE_BUTTON');
    await page.keyboard.press('Enter');
    await capture('08-terminal-clipboard');
    await app.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('terminal:write'); globalThis.interruptCount = 0;
      ipcMain.removeHandler('terminal:write'); ipcMain.handle('terminal:write', (event, input) => { if (input.data === '\u0003') globalThis.interruptCount++; return original(event, input); });
    });
    await page.locator('.terminal-host .xterm-screen').click();
    await page.keyboard.press('Control+c');
    await expect.poll(() => app.evaluate(() => globalThis.interruptCount)).toBe(1);
    await app.evaluate(async ({ clipboard }) => await clipboard.writeText('echo OPTIC_CTRL_V'));
    await page.keyboard.press('Control+v');
    await expect(page.locator('.terminal-host')).toContainText('echo OPTIC_CTRL_V'); await page.keyboard.press('Enter');
  } finally { await app.evaluate(async ({ clipboard }, text) => await clipboard.writeText(text), savedClipboard); }
  const profilesResult = await page.evaluate(() => window.desktop.request('terminal:profiles', undefined));
  assert(profilesResult.ok); const profiles = profilesResult.data;
  for (const profile of profiles.filter(p => p.available && p.id !== 'system')) {
    await page.getByLabel('Local terminal profile', { exact: true }).selectOption(profile.id);
    await page.getByTitle('Open selected terminal', { exact: true }).click();
    const pane = page.locator('.terminal-pane:visible');
    await expect(pane.locator('[role=status]')).toHaveText('Connected');
    await pane.locator('.xterm-helper-textarea').focus();
    const command = profile.id === 'gitbash' ? "printf 'OPTIC_%s_READY\\n' gitbash" : profile.id === 'cmd' ? 'echo OPTIC_%OS%_READY' : `Write-Output ('OPTIC_' + '${profile.id}_READY')`;
    await page.keyboard.type(command); await page.keyboard.press('Enter');
    await expect(pane.locator('.terminal-host')).toContainText(`OPTIC_${profile.id === 'cmd' ? 'Windows_NT' : profile.id}_READY`, { timeout: 20000 });
    await page.locator('.dock-tab.active').getByTitle('Close session', { exact: true }).click();
  }
  await page.getByLabel('Local terminal profile', { exact: true }).selectOption(profiles.find(p => p.id === 'powershell' && p.available) ? 'powershell' : 'system');
  const beforeSplit = await app.evaluate(() => globalThis.localShellCalls.length);
  await page.getByRole('button', { name: 'Split terminal side by side', exact: true }).click();
  await expect(page.locator('.terminal-pane:visible')).toHaveCount(2);
  await expect(page.locator('.terminal-pane:visible [role=status]')).toHaveText(['Connected', 'Connected']);
  assert.equal(await app.evaluate(() => globalThis.localShellCalls.length), beforeSplit + 1);
  await page.getByRole('separator', { name: 'Resize split terminals' }).focus(); await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('separator', { name: 'Resize split terminals' })).toHaveAttribute('aria-valuenow', '55');
  await capture('06-split-profiles');
  const splitClipboard = await app.evaluate(async ({ clipboard }) => await clipboard.readText());
  try {
    await app.evaluate(async ({ clipboard }) => await clipboard.writeText('echo OPTIC_RIGHT_PANE_ONLY'));
    const right = page.locator('.terminal-pane:visible').nth(1);
    await right.locator('.xterm-helper-textarea').focus(); await page.keyboard.press('Control+Shift+V');
    await expect(right).toContainText('echo OPTIC_RIGHT_PANE_ONLY');
    await expect(page.locator('.terminal-pane:visible').first()).not.toContainText('OPTIC_RIGHT_PANE_ONLY');
    await page.keyboard.press('Enter');
  } finally { await app.evaluate(async ({ clipboard }, text) => await clipboard.writeText(text), splitClipboard); }
  await page.getByRole('button', { name: 'Split terminal stacked', exact: true }).click();
  await expect(page.locator('.dock-content')).toHaveClass(/split-rows/);
  assert.equal(await app.evaluate(() => globalThis.localShellCalls.length), beforeSplit + 1, 'Changing split layout must preserve PTYs');
  await capture('07-stacked-terminals');
  await page.getByRole('button', { name: 'Unsplit', exact: true }).click();
  await expect(page.locator('.terminal-pane:visible')).toHaveCount(1);
  assert.equal(await app.evaluate(() => globalThis.localShellCalls.length), beforeSplit + 1, 'Unsplit must preserve PTYs');
  await page.locator('.dock-tab.active').getByTitle('Close session', { exact: true }).click();
  await expect(page.locator('.terminal-pane:visible [role=status]')).toHaveText('Connected');
  assert.deepEqual(errors, []);
  console.log('PASS: multi-pod source selection, labelled UTF-8 logs, automatic cursor resume/dedup, independent errors, filtered/native export, stop/close cleanup.');
  console.log('PASS: configurable pod shell, fresh session IDs, ended state, native local terminal disconnect/reconnect.');
} catch (error) {
  await mkdir('artifacts', { recursive: true }); if (app) await (await app.firstWindow()).screenshot({ path: 'artifacts/advanced-streams-failure.png' }).catch(() => {});
  throw error;
} finally {
  await app?.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
  if (resolve(temp).startsWith(resolve(tmpdir()) + sep)) await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}
