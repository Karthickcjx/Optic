// Electron UI checks for the Argo CD and Flux views against a fake API server serving objects and events captured from
// a live cluster running Argo CD v3.5.6 / Flux v2.10.0. This is a UI integration test, not a live-cluster test.
import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const temp = await mkdtemp(join(tmpdir(), 'optic-gitops-smoke-'));
const fixture = async name => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')).items;
const data = { applications: await fixture('argo-applications'), appprojects: await fixture('argo-appprojects'), applicationsets: await fixture('argo-applicationsets'), kustomizations: await fixture('flux-kustomizations'), helmreleases: await fixture('flux-helmreleases'), gitrepositories: await fixture('flux-gitrepositories'), helmrepositories: await fixture('flux-helmrepositories'), ocirepositories: await fixture('flux-ocirepositories'), buckets: [] };
// Event timestamps are shifted to "now" so they fall inside the activity time range.
const events = (await fixture('argo-events')).map((e, i) => ({ ...e, lastTimestamp: new Date(Date.now() - i * 60000).toISOString() }));
const bulk = Array.from({ length: 1200 }, (_, i) => ({ ...data.applications[0], metadata: { name: `bulk-${String(i).padStart(4, '0')}`, namespace: 'bulk', uid: `bulk-${i}`, resourceVersion: '1' } }));
const groups = { 'argoproj.io': ['v1alpha1', { applications: 'Application', applicationsets: 'ApplicationSet', appprojects: 'AppProject' }], 'kustomize.toolkit.fluxcd.io': ['v1', { kustomizations: 'Kustomization' }], 'helm.toolkit.fluxcd.io': ['v2', { helmreleases: 'HelmRelease' }], 'source.toolkit.fluxcd.io': ['v1', { gitrepositories: 'GitRepository', helmrepositories: 'HelmRepository', ocirepositories: 'OCIRepository', buckets: 'Bucket' }] };
const deployment = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'guestbook-ui', namespace: 'argo-demo', uid: 'dep-1', resourceVersion: '1' }, spec: { replicas: 1 }, status: { readyReplicas: 1 } };
const sockets = new Set(), requests = [];
const json = (res, body, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const handler = gitops => (req, res) => {
  const url = new URL(req.url, 'http://localhost'); requests.push(`${req.method} ${url.pathname}${url.searchParams.get('fieldSelector') ? `?${url.searchParams.get('fieldSelector')}` : ''}`);
  if (url.searchParams.has('watch')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.flushHeaders(); return; }
  if (url.pathname === '/version') return json(res, { gitVersion: 'v1.36.0-gitops' });
  if (url.pathname === '/apis') return json(res, { groups: gitops ? Object.entries(groups).map(([name, [v]]) => ({ name, versions: [{ groupVersion: `${name}/${v}` }], preferredVersion: { groupVersion: `${name}/${v}` } })) : [] });
  for (const [name, [v, kinds]] of Object.entries(groups)) if (gitops && url.pathname === `/apis/${name}/${v}`) return json(res, { resources: Object.entries(kinds).map(([plural, kind]) => ({ name: plural, kind, namespaced: true, verbs: ['get', 'list', 'watch'] })) });
  if (url.pathname === '/api/v1/namespaces') return json(res, { items: ['argocd', 'flux-system', 'locked', 'bulk'].map(name => ({ metadata: { name, uid: name } })), metadata: { resourceVersion: '1' } });
  if (url.pathname === '/api/v1/namespaces/argocd/configmaps/argocd-cm') return json(res, { data: { url: 'https://argocd.example.test/' } });
  if (url.pathname === '/apis/apps/v1/namespaces/argo-demo/deployments/guestbook-ui') return json(res, deployment);
  if (url.pathname === '/apis/apps/v1/namespaces/argo-demo/deployments') return json(res, { items: [deployment], metadata: { resourceVersion: '1' } });
  if (/^\/api\/v1(\/namespaces\/[^/]+)?\/events$/.test(url.pathname)) {
    const field = url.searchParams.get('fieldSelector') ?? '';
    const terms = Object.fromEntries(field.split(',').filter(Boolean).map(t => t.split('=')));
    const items = events.filter(e => (!terms['involvedObject.apiVersion'] || e.involvedObject.apiVersion === terms['involvedObject.apiVersion']) && (!terms['involvedObject.kind'] || e.involvedObject.kind === terms['involvedObject.kind']) && (!terms['involvedObject.name'] || e.involvedObject.name === terms['involvedObject.name']));
    return json(res, { items: gitops ? items : [], metadata: { resourceVersion: '1' } });
  }
  const single = url.pathname.match(/^\/apis\/[^/]+\/[^/]+\/namespaces\/([^/]+)\/([a-z]+)\/([^/]+)$/);
  if (gitops && single && data[single[2]]) { const found = data[single[2]].find(i => i.metadata.name === single[3]); return found ? json(res, found) : json(res, { kind: 'Status', code: 404, message: 'not found' }, 404); }
  const match = url.pathname.match(/^\/apis\/[^/]+\/[^/]+(?:\/namespaces\/([^/]+))?\/([a-z]+)$/);
  if (gitops && match && data[match[2]]) {
    const [, namespace, plural] = match;
    if (namespace === 'locked') return json(res, { kind: 'Status', apiVersion: 'v1', status: 'Failure', code: 403, reason: 'Forbidden', message: `${plural} is forbidden: User "dev" cannot list resource "${plural}" in the namespace "locked"` }, 403);
    const items = plural === 'applications' && namespace === 'bulk' ? bulk : data[plural].filter(i => !namespace || i.metadata.namespace === namespace);
    return json(res, { items, metadata: { resourceVersion: '1' } });
  }
  json(res, { items: [], metadata: { resourceVersion: '1' } });
};
const servers = await Promise.all([true, false].map(async gitops => { const s = createServer(handler(gitops)); s.on('connection', c => { sockets.add(c); c.on('close', () => sockets.delete(c)); }); await new Promise(r => s.listen(0, '127.0.0.1', r)); return s; }));
const cluster = (name, server) => ({ name, cluster: { 'insecure-skip-tls-verify': true, server } });
const config = join(temp, 'config');
await writeFile(config, JSON.stringify({ apiVersion: 'v1', kind: 'Config', clusters: [cluster('gitops', `http://127.0.0.1:${servers[0].address().port}`), cluster('plain', `http://127.0.0.1:${servers[1].address().port}`), cluster('offline', 'http://127.0.0.1:1')], users: [{ name: 'u', user: {} }], contexts: ['gitops', 'plain', 'offline'].map(name => ({ name, context: { cluster: name, user: 'u' } })), 'current-context': 'gitops' }));
let app;
try {
  const env = { ...process.env, WORKBENCH_KUBECONFIG: config }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.', `--user-data-dir=${join(temp, 'profile')}`], env });
  // Record external links instead of opening a browser.
  await app.evaluate(({ shell }) => { globalThis.__opened = []; shell.openExternal = async url => { globalThis.__opened.push(url); }; });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000); const errors = []; page.on('pageerror', e => errors.push(e.message));
  const capture = async name => { if (process.env.OPTIC_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.OPTIC_SCREENSHOT_DIR, `gitops-${name}.png`) }); };
  const open = async (context, label) => { const tree = page.locator('.cluster-tree').filter({ has: page.getByText(context, { exact: true }) }); await tree.getByRole('button', { name: label, exact: true }).click(); };
  const argoTab = name => page.getByRole('tablist', { name: 'Argo CD sections' }).getByRole('tab', { name, exact: true });
  const fluxTab = name => page.getByRole('tablist', { name: 'Flux sections' }).getByRole('tab', { name, exact: true });
  const counters = page.getByLabel('Application status counters'), drawer = page.locator('.gitops-details');
  const table = page.locator('.gitops-page .gitops-table').first(), rowOf = name => page.locator('.gitops-page .gitops-table tbody tr').filter({ has: page.getByRole('button', { name, exact: true }) });

  // Navigator: GitOps group with Argo CD and Flux.
  await open('gitops', 'Argo CD');
  await expect(page.getByRole('heading', { name: 'Argo CD', exact: true })).toBeVisible();
  // Summary counters come from the captured application states.
  for (const [label, value] of [['Applications', '6'], ['Synced', '4'], ['Out of sync', '1'], ['Healthy', '5'], ['Degraded', '0'], ['Missing', '1'], ['Progressing', '0'], ['Unknown', '1']]) await expect(counters.getByRole('button', { name: `${value} ${label}`, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Argo CD UI' })).toBeVisible();
  // Dashboard cards, Needs attention and Recent activity.
  await expect(page.locator('.gitops-card').filter({ hasText: 'Applications' }).first()).toContainText('5/6 healthy');
  await expect(page.locator('.gitops-card').filter({ hasText: 'Projects' }).first()).toContainText('team-a');
  await expect(page.locator('.gitops-card').filter({ hasText: 'Application sets' })).toContainText('2 generated application(s)');
  const attention = page.locator('.gitops-card').filter({ hasText: 'Needs attention (2)' });
  await expect(attention).toContainText('ComparisonError'); await expect(attention).toContainText('guestbook-manual');
  const activity = page.locator('.gitops-card').filter({ hasText: 'Recent activity' });
  await expect(activity).toContainText('OperationCompleted'); await expect(activity).toContainText('Deployed');
  assert.ok(requests.some(r => r.includes('/events?involvedObject.apiVersion=argoproj.io/v1alpha1')), 'events watch narrowed server-side');
  await page.getByLabel('Activity type', { exact: true }).selectOption('OperationCompleted');
  await expect(activity.locator('tbody tr').first()).toContainText('OperationCompleted');
  assert.equal(await activity.locator('tbody tr').filter({ hasNotText: 'OperationCompleted' }).count(), 0);
  await page.getByLabel('Activity application', { exact: true }).fill('stage');
  assert.ok(await activity.locator('tbody tr').count() >= 1); assert.equal(await activity.locator('tbody tr').filter({ hasNotText: 'guestbook-stage' }).count(), 0);
  await capture('argo-dashboard');
  await attention.getByRole('button', { name: 'guestbook-manual', exact: true }).click();
  await expect(drawer).toContainText('ARGO CD APPLICATION'); await expect(drawer.getByRole('heading', { name: 'guestbook-manual' })).toBeVisible();
  await drawer.getByTitle('Close details').click();

  // Counter click filters the Applications view.
  await counters.getByRole('button', { name: '1 Out of sync', exact: true }).click();
  await expect(argoTab('Applications')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.gitops-page .gitops-table tbody tr')).toHaveCount(1); await expect(table).toContainText('guestbook-manual');
  await page.getByRole('button', { name: 'Clear filters' }).click(); await expect(page.locator('.gitops-page .gitops-table tbody tr')).toHaveCount(6);
  await page.getByLabel('Project filter', { exact: true }).selectOption('team-a'); await expect(page.locator('.gitops-page .gitops-table tbody tr')).toHaveCount(1);
  await page.getByLabel('Project filter', { exact: true }).selectOption('');
  await page.getByLabel('Application set filter', { exact: true }).selectOption('guestbook-envs'); await expect(page.locator('.gitops-page .gitops-table tbody tr')).toHaveCount(2);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByRole('button', { name: 'Health', exact: true }).click();
  await expect(page.locator('.gitops-page .gitops-table tbody tr').first()).toContainText('guestbook-manual');
  // Application details: all six tabs, with real data.
  await rowOf('guestbook').click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'Open details' }).click();
  await expect(drawer).toContainText('https://github.com/argoproj/argocd-example-apps.git'); await expect(drawer).toContainText('Automated');
  await drawer.getByRole('tab', { name: 'Resources' }).click(); await expect(drawer).toContainText('Deployment (1)'); await expect(drawer).toContainText('Service (1)');
  await drawer.getByRole('tab', { name: 'Events' }).click(); await expect(drawer.locator('tbody tr').first()).toBeVisible();
  assert.ok(requests.some(r => r.includes('involvedObject.kind=Application,involvedObject.name=guestbook')));
  await drawer.getByRole('tab', { name: 'History' }).click(); await expect(drawer.locator('tbody tr')).toHaveCount(1);
  await drawer.getByRole('tab', { name: 'YAML' }).click(); await expect(drawer.getByLabel('Resource YAML (read-only)')).toContainText('kind: Application');
  await expect(drawer.getByLabel('Resource YAML (read-only)')).not.toContainText('managedFields');
  await drawer.getByRole('tab', { name: 'Conditions' }).click(); await expect(drawer).toContainText('No conditions reported.');
  await capture('argo-application');
  await drawer.getByRole('tab', { name: 'Resources' }).click();
  await drawer.locator('details').filter({ hasText: 'Deployment' }).getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('.details:not(.gitops-details) h2')).toHaveText('guestbook-ui');
  await open('gitops', 'Argo CD');
  await page.getByRole('button', { name: 'Open Argo CD UI' }).click();
  await expect.poll(() => app.evaluate(() => globalThis.__opened)).toEqual(['https://argocd.example.test/applications']);

  // Projects and Application Sets.
  await argoTab('Projects').click();
  await rowOf('team-a').click();
  await expect(drawer).toContainText('Team A applications (restricted)'); await expect(drawer).toContainText('team-a-*'); await expect(drawer).toContainText('viewer');
  await drawer.getByRole('tab', { name: 'Permissions' }).click(); await expect(drawer).toContainText('core/Namespace'); await expect(drawer).toContainText('core/ResourceQuota');
  await drawer.getByRole('tab', { name: 'Applications' }).click(); await expect(drawer).toContainText('team-a-guestbook');
  await argoTab('Application Sets').click();
  await rowOf('guestbook-envs').click();
  await expect(drawer).toContainText('2 element(s)'); await expect(drawer).toContainText('guestbook-{{.env}}');
  await drawer.getByRole('tab', { name: 'Applications' }).click(); await expect(drawer).toContainText('guestbook-dev'); await expect(drawer).toContainText('guestbook-stage');
  await drawer.getByRole('tab', { name: 'Conditions' }).click(); await expect(drawer).toContainText('ResourcesUpToDate');
  await capture('argo-appset');

  // Namespace filter, RBAC denial and a large collection.
  await argoTab('Applications').click();
  await page.getByLabel('Argo CD namespace', { exact: true }).selectOption('locked');
  await expect(page.getByRole('alert')).toContainText('Permission denied'); await expect(page.getByRole('alert')).toContainText('cannot list resource "applications"');
  await page.getByLabel('Argo CD namespace', { exact: true }).selectOption('bulk');
  await expect(page.locator('.gitops-page .gitops-table tbody tr')).toHaveCount(500); await expect(page.getByText('1200 application(s); showing the first 500', { exact: false })).toBeVisible();
  await page.getByLabel('Search applications', { exact: true }).fill('bulk-1199'); await expect(page.locator('.gitops-page .gitops-table tbody tr')).toHaveCount(1);
  await page.getByLabel('Argo CD namespace', { exact: true }).selectOption('');

  // Flux: overview, needs attention, lists, sources and details.
  await open('gitops', 'Flux');
  const flux = page.getByLabel('Flux status counters');
  for (const [label, value] of [['Resources', '7'], ['Ready', '5'], ['Failing', '2'], ['Suspended', '0'], ['Reconciling', '2'], ['Stalled', '0'], ['Unknown', '0']]) await expect(flux.locator('.gitops-stat').filter({ hasText: new RegExp('^[0-9]+' + label + '$') }).locator('b')).toHaveText(value);
  const fluxAttention = page.locator('.gitops-card').filter({ hasText: 'Needs attention (2)' });
  await expect(fluxAttention).toContainText('broken-path'); await expect(fluxAttention).toContainText('missing-repo');
  await expect(page.locator('.gitops-card').filter({ hasText: 'OCI repositories' })).toContainText('1/1 ready');
  await capture('flux-overview');
  await fluxAttention.getByRole('button', { name: 'broken-path', exact: true }).click();
  await expect(fluxTab('Kustomizations')).toHaveAttribute('aria-selected', 'true');
  await expect(drawer).toContainText('kustomization path not found');
  await page.getByLabel('Status filter', { exact: true }).selectOption('failing'); await expect(page.locator('.gitops-page .gitops-table tbody tr')).toHaveCount(1);
  await page.getByLabel('Status filter', { exact: true }).selectOption('');
  await rowOf('podinfo').click();
  await drawer.getByRole('tab', { name: 'Resources' }).click(); await expect(drawer).toContainText('Deployment'); await expect(drawer).toContainText('flux-demo/podinfo');
  await drawer.getByRole('tab', { name: 'History' }).click(); await expect(drawer).toContainText('ReconciliationSucceeded');
  await drawer.getByRole('tab', { name: 'Overview' }).click();
  await drawer.getByRole('button', { name: 'GitRepository/flux-system/podinfo', exact: true }).click();
  await expect(fluxTab('Sources')).toHaveAttribute('aria-selected', 'true');
  await drawer.getByRole('tab', { name: 'Resources' }).click(); await expect(drawer).toContainText('broken-path'); await expect(drawer).toContainText('podinfo');
  await page.getByRole('tab', { name: /OCI repositories/ }).click();
  await expect(rowOf('podinfo-oci')).toContainText('oci://ghcr.io/stefanprodan/manifests/podinfo (tag latest)');
  await fluxTab('Helm releases').click(); await expect(rowOf('podinfo-helm')).toContainText('True');
  await capture('flux-sources');

  // Empty and unreachable clusters.
  await open('plain', 'Argo CD'); await expect(page.getByRole('heading', { name: 'Argo CD is not installed' })).toBeVisible();
  await open('plain', 'Flux'); await expect(page.getByRole('heading', { name: 'Flux is not installed' })).toBeVisible();
  await open('offline', 'Argo CD'); await expect(page.getByRole('alert')).toContainText(/could not be reached|did not respond|Request failed/);

  assert.deepEqual([...new Set(requests.map(r => r.split(' ')[0]))], ['GET'], 'GitOps views only read');
  assert.deepEqual(errors, []);
  console.log('PASS: GitOps (fixtures from a live cluster): Argo CD counters/filters, dashboard cards, needs attention, recent activity filters, application tabs, context menu, Open Argo CD UI, projects, application sets, RBAC denial, 1200-item cap; Flux overview, attention, kinds, sources, details; empty/unreachable; GET-only.');
} catch (error) { const [window] = app ? app.windows() : []; if (window && process.env.OPTIC_SCREENSHOT_DIR) await window.screenshot({ path: join(process.env.OPTIC_SCREENSHOT_DIR, 'gitops-failure.png') }); throw error; } finally { if (app) await app.close(); sockets.forEach(s => s.destroy()); await Promise.all(servers.map(s => new Promise(r => s.close(r)))); await rm(temp, { recursive: true, force: true }); }
