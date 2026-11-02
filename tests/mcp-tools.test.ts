import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { ClusterManager } from '../src/main/clusters';
import { accessPath, setAccess } from '../src/mcp/access';
import { createMcpServer } from '../src/mcp/server';
import { ApprovedClusters, MAX_OUTPUT_CHARS } from '../src/mcp/tools';

// Fake Kubernetes API server: real HTTP, recorded methods, paging, RBAC denials and failure modes.
const requests: { method: string; path: string; query: URLSearchParams }[] = [];
const meta = (name: string, namespace?: string, extra = {}) => ({ name, ...(namespace ? { namespace } : {}), uid: `${namespace ?? ''}-${name}`, resourceVersion: '1', creationTimestamp: '2026-11-01T00:00:00Z', ...extra });
const pods = Array.from({ length: 7 }, (_, i) => ({ apiVersion: 'v1', kind: 'Pod', metadata: meta(i ? `worker-${i}` : 'web', 'team'), spec: { nodeName: 'node-a', containers: [{ name: 'app', image: 'example/app:1', env: [{ name: 'DB_PASSWORD', value: 'hunter2' }, { name: 'MODE', value: 'prod' }, { name: 'API_TOKEN', valueFrom: { secretKeyRef: { name: 'db', key: 'token' } } }], args: ['--password=hunter2', '--verbose'] }], volumes: [{ name: 'creds', secret: { secretName: 'db' } }] }, status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: i > 0, restartCount: i ? 0 : 5, state: i ? { running: {} } : { waiting: { reason: 'CrashLoopBackOff' } } }] } }));
const objects: Record<string, any> = {
  '/version': { gitVersion: 'v1.36.0-test', platform: 'linux/amd64' },
  '/api/v1/namespaces': { kind: 'NamespaceList', items: ['team', 'locked'].map(n => ({ metadata: meta(n, undefined, { labels: { team: n } }), status: { phase: 'Active' } })) },
  '/api/v1/namespaces/team': { apiVersion: 'v1', kind: 'Namespace', metadata: meta('team', undefined, { annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"secret":"x"}' } }), status: { phase: 'Active' } },
  '/api/v1/namespaces/team/resourcequotas': { items: [{ metadata: meta('compute', 'team'), spec: { hard: { cpu: '4' } }, status: { used: { cpu: '1' } } }] },
  '/api/v1/namespaces/team/limitranges': { items: [] },
  '/api/v1/namespaces/team/pods': { items: pods },
  '/api/v1/pods': { items: pods },
  '/api/v1/namespaces/team/pods/web': pods[0],
  '/apis/apps/v1/namespaces/team/deployments': { items: [{ metadata: meta('web', 'team'), spec: { replicas: 3, template: { spec: { containers: [{ image: 'example/app:1' }] } } }, status: { readyReplicas: 1, updatedReplicas: 3, availableReplicas: 1, conditions: [{ type: 'Available', status: 'False', reason: 'MinimumReplicasUnavailable' }] } }] },
  '/apis/apps/v1/namespaces/team/deployments/web': { apiVersion: 'apps/v1', kind: 'Deployment', metadata: meta('web', 'team'), spec: { replicas: 3 } },
  '/api/v1/namespaces/team/services': { items: [{ metadata: meta('web', 'team'), spec: { type: 'ClusterIP', clusterIP: '10.0.0.1', ports: [{ port: 80, protocol: 'TCP', targetPort: 8080 }], selector: { app: 'web' } } }] },
  '/api/v1/namespaces/team/services/web': { apiVersion: 'v1', kind: 'Service', metadata: meta('web', 'team'), spec: { type: 'ClusterIP' } },
  '/api/v1/nodes': { items: [{ metadata: meta('node-a', undefined, { labels: { 'node-role.kubernetes.io/control-plane': '' } }), spec: {}, status: { conditions: [{ type: 'Ready', status: 'True' }], nodeInfo: { kubeletVersion: 'v1.36.0' }, capacity: { cpu: '4', memory: '16Gi', pods: '110' } } }] },
  '/api/v1/nodes/node-a': { apiVersion: 'v1', kind: 'Node', metadata: meta('node-a'), status: {} },
  '/api/v1/namespaces/team/events': { items: [
    { metadata: meta('e1', 'team'), type: 'Warning', reason: 'BackOff', message: 'Back-off restarting failed container; token=abc123secret', involvedObject: { kind: 'Pod', name: 'web', namespace: 'team' }, count: 9, lastTimestamp: '2026-11-02T10:00:00Z' },
    { metadata: meta('e2', 'team'), type: 'Normal', reason: 'Pulled', message: 'Pulled image', involvedObject: { kind: 'Pod', name: 'worker-1', namespace: 'team' }, lastTimestamp: '2026-11-02T09:00:00Z' }] },
  '/api/v1/namespaces/team/secrets/db': { apiVersion: 'v1', kind: 'Secret', type: 'Opaque', metadata: meta('db', 'team', { annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"data":{"password":"aHVudGVyMg=="}}' } }), data: { password: 'aHVudGVyMg==', user: 'YWRtaW4=' } },
  '/api/v1/namespaces/team/configmaps/settings': { apiVersion: 'v1', kind: 'ConfigMap', metadata: meta('settings', 'team'), data: { color: 'blue', api_key: 'abcdef', 'app.properties': 'db.password=hunter2\nmode=fast' } },
  '/api/v1/namespaces/team/configmaps/huge': { apiVersion: 'v1', kind: 'ConfigMap', metadata: meta('huge', 'team'), data: { blob: 'x'.repeat(MAX_OUTPUT_CHARS + 5000) } },
  '/api/v1/namespaces/broken/pods': {},
  '/api/v1': { resources: [{ name: 'pods', kind: 'Pod', namespaced: true, verbs: ['get', 'list', 'watch', 'create', 'delete'] }, { name: 'pods/exec', kind: 'PodExecOptions', namespaced: true, verbs: ['create', 'get'] }, { name: 'secrets', kind: 'Secret', namespaced: true, verbs: ['get', 'list'] }, { name: 'configmaps', kind: 'ConfigMap', namespaced: true, verbs: ['get', 'list'] }, { name: 'bindings', kind: 'Binding', namespaced: true, verbs: ['create'] }] },
  '/apis': { groups: [{ name: 'apps', preferredVersion: { groupVersion: 'apps/v1' } }, { name: 'metrics.k8s.io', preferredVersion: { groupVersion: 'metrics.k8s.io/v1beta1' } }] },
  '/apis/apps/v1': { resources: [{ name: 'deployments', kind: 'Deployment', namespaced: true, verbs: ['get', 'list', 'patch'] }, { name: 'deployments/scale', kind: 'Scale', namespaced: true, verbs: ['get', 'patch'] }] }
};
// The SDK validates arguments against the advertised schema first; call() re-validates for direct use.
const invalid = /^(INVALID_INPUT: |Input validation error)/;
const status = (code: number, message: string) => ({ kind: 'Status', apiVersion: 'v1', status: 'Failure', message, code });
let api: Server, dataDir: string, clusters: ApprovedClusters, manager: ClusterManager, client: Client, kubeconfig: string, marker: string;
const ids: Record<string, string> = {};

function handler(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
  const url = new URL(req.url!, 'http://localhost'); requests.push({ method: req.method!, path: url.pathname, query: url.searchParams });
  const send = (code: number, body: unknown, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  if (url.pathname.startsWith('/api/v1/namespaces/slow/')) return; // never answers
  if (url.pathname.includes('/namespaces/locked')) return send(403, status(403, 'pods is forbidden: User "dev" cannot list resource "pods" in API group "" in the namespace "locked"'));
  if (url.pathname === '/api/v1/namespaces/team/pods/web/log') {
    const text = 'start\nAuthorization: Bearer abcdefghijklmnop.qrstuv\nconnecting with password=hunter2\n' + 'line\n'.repeat(5000);
    const limit = Number(url.searchParams.get('limitBytes') ?? Infinity);
    return send(200, text.slice(0, limit), 'text/plain');
  }
  if (url.pathname === '/apis/metrics.k8s.io/v1beta1') return send(503, status(503, 'service unavailable'));
  let body = objects[url.pathname];
  if (body === undefined) return send(404, status(404, `the server could not find the requested resource (${url.pathname})`));
  if (Array.isArray(body.items)) {
    let items = body.items as any[];
    const field = url.searchParams.get('fieldSelector');
    for (const term of field ? field.split(',') : []) { const [key, value] = term.split('='); items = items.filter(i => key === 'type' ? i.type === value : key === 'involvedObject.name' ? i.involvedObject?.name === value : key === 'involvedObject.kind' ? i.involvedObject?.kind === value : true); }
    const start = Number(url.searchParams.get('continue') ?? 0), limit = Number(url.searchParams.get('limit') ?? items.length);
    const next = start + limit < items.length ? String(start + limit) : undefined;
    body = { ...body, items: items.slice(start, start + limit), metadata: { resourceVersion: '5', ...(next ? { continue: next, remainingItemCount: items.length - start - limit } : {}) } };
  }
  send(200, body);
}
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { type: string; text: string }[] };
  const text = result.content[0].text;
  return { error: !!result.isError, text, json: result.isError ? undefined : (() => { try { return JSON.parse(text); } catch { return undefined; } })() };
};

beforeAll(async () => {
  api = createServer(handler); await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  const server = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  dataDir = mkdtempSync(join(tmpdir(), 'optic-mcp-test-'));
  marker = join(dataDir, 'exec-ran');
  writeFileSync(join(dataDir, 'exec.cjs'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdout.write(JSON.stringify({ apiVersion: 'client.authentication.k8s.io/v1', kind: 'ExecCredential', status: { token: 'exec-token' } }));`);
  kubeconfig = join(dataDir, 'config');
  const exec = (script: string) => `    exec:\n      apiVersion: client.authentication.k8s.io/v1\n      command: ${JSON.stringify(process.execPath)}\n      args: [${JSON.stringify(script)}]\n      interactiveMode: Never\n`;
  writeFileSync(kubeconfig, `apiVersion: v1\nkind: Config\nclusters:\n- name: fake\n  cluster:\n    server: ${server}\n    insecure-skip-tls-verify: true\n- name: dead\n  cluster:\n    server: http://127.0.0.1:1\n    insecure-skip-tls-verify: true\nusers:\n- name: token-user\n  user:\n    token: super-secret-token\n- name: exec-user\n  user:\n${exec(join(dataDir, 'exec.cjs'))}contexts:\n- name: approved\n  context: { cluster: fake, user: token-user, namespace: team }\n- name: other\n  context: { cluster: fake, user: token-user }\n- name: exec-ctx\n  context: { cluster: fake, user: exec-user }\n- name: dead\n  context: { cluster: dead, user: token-user }\ncurrent-context: approved\n`);
  manager = new ClusterManager([kubeconfig], join(dataDir, 'kubeconfig-sources.json'));
  for (const c of manager.discover().clusters) ids[c.name] = c.id;
  for (const name of ['approved', 'exec-ctx', 'dead']) { const { cluster, config } = manager.get(ids[name], true); setAccess(cluster.id, cluster, config, true, accessPath(dataDir)); }
  clusters = new ApprovedClusters(manager, accessPath(dataDir));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(clusters).connect(serverSide);
  client = new Client({ name: 'test', version: '1' }); await client.connect(clientSide);
});
afterAll(async () => { await client?.close(); await new Promise<void>(resolve => { api.closeAllConnections(); api.close(() => resolve()); }); rmSync(dataDir, { recursive: true, force: true }); });

describe('MCP server surface', () => {
  it('exposes exactly the read-only tool set, all annotated read-only', async () => {
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['discover_api_resources', 'get_cluster_info', 'get_deployment_details', 'get_namespace_details', 'get_node_details', 'get_pod_details', 'get_pod_logs', 'get_resource_events', 'get_resource_yaml', 'get_service_details', 'list_clusters', 'list_deployments', 'list_events', 'list_namespaces', 'list_nodes', 'list_pods', 'list_services']);
    expect(tools.every(t => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false)).toBe(true);
  });
});

describe('cluster access control', () => {
  it('lists only approved contexts and never names unapproved ones', async () => {
    const { json } = await call('list_clusters');
    expect(json.clusters.map((c: any) => c.context).sort()).toEqual(['approved', 'dead', 'exec-ctx']);
    expect(json.unapprovedContexts).toBe(1);
    expect(JSON.stringify(json)).not.toMatch(/"other"|super-secret-token|127\.0\.0\.1/);
  });
  it('refuses unapproved contexts by name or id without falling back to another cluster', async () => {
    const before = requests.length;
    for (const cluster of ['other', ids.other, 'missing']) expect((await call('list_pods', { cluster })).text).toMatch(/^NOT_APPROVED: /);
    expect(requests.length).toBe(before);
  });
  it('suspends an approval when the credential command changes, without running the command', async () => {
    const original = manager.get(ids['exec-ctx'], true).config, user = original.getUsers().find(u => u.name === 'exec-user')!;
    writeFileSync(join(dataDir, 'other.cjs'), 'process.exit(1)');
    const { readFileSync } = await import('node:fs');
    writeFileSync(kubeconfig, readFileSync(kubeconfig, 'utf8').replace(JSON.stringify(join(dataDir, 'exec.cjs')), JSON.stringify(join(dataDir, 'other.cjs'))));
    try {
      const result = await call('list_namespaces', { cluster: 'exec-ctx' });
      expect(result.text).toMatch(/^APPROVAL_STALE: /);
      expect(existsSync(marker)).toBe(false);
      expect((await call('list_clusters')).json.clusters.find((c: any) => c.context === 'exec-ctx').status).toMatch(/needs re-approval/);
    } finally { writeFileSync(kubeconfig, readFileSync(kubeconfig, 'utf8').replace(JSON.stringify(join(dataDir, 'other.cjs')), JSON.stringify(join(dataDir, 'exec.cjs')))); }
    expect(user.exec).toBeDefined();
    // Restored and still approved: the approved credential command runs.
    expect((await call('list_namespaces', { cluster: 'exec-ctx' })).error).toBe(false);
    expect(existsSync(marker)).toBe(true);
  });
  it('applies revocation immediately', async () => {
    const store = accessPath(dataDir), { readAccess, writeAccess } = await import('../src/mcp/access');
    const saved = readAccess(store); writeAccess({ version: 1, clusters: {} }, store);
    try { expect((await call('get_cluster_info', { cluster: 'approved' })).text).toMatch(/^NOT_APPROVED/); } finally { writeAccess(saved, store); }
  });
});

describe('read tools with real HTTP', () => {
  it('reports cluster info without kubeconfig contents', async () => {
    const { json, text } = await call('get_cluster_info', { cluster: 'approved' });
    expect(json).toMatchObject({ context: 'approved', defaultNamespace: 'team', kubernetesVersion: 'v1.36.0-test', auth: 'token' });
    expect(text).not.toMatch(/super-secret-token|127\.0\.0\.1|server/);
  });
  it('lists and pages namespaces, pods, deployments, services and nodes', async () => {
    expect((await call('list_namespaces', { cluster: 'approved' })).json.items.map((n: any) => n.name)).toEqual(['team', 'locked']);
    const first = (await call('list_pods', { cluster: 'approved', namespace: 'team', limit: 5 })).json;
    expect(first.items).toHaveLength(5); expect(first.continue).toBe('5'); expect(first.remainingItemCount).toBe(2);
    expect(first.items[0]).toMatchObject({ name: 'web', ready: '0/1', restarts: 5, reason: 'CrashLoopBackOff', node: 'node-a' });
    const second = (await call('list_pods', { cluster: 'approved', namespace: 'team', limit: 5, continue: first.continue })).json;
    expect(second.items.map((p: any) => p.name)).toEqual(['worker-5', 'worker-6']); expect(second.continue).toBeUndefined();
    expect((await call('list_pods', { cluster: 'approved' })).json.items).toHaveLength(7);
    expect((await call('list_deployments', { cluster: 'approved', namespace: 'team' })).json.items[0]).toMatchObject({ name: 'web', replicas: 3, ready: 1, conditions: ['Available=False (MinimumReplicasUnavailable)'] });
    expect((await call('list_services', { cluster: 'approved', namespace: 'team' })).json.items[0]).toMatchObject({ type: 'ClusterIP', ports: ['80/TCP->8080'] });
    expect((await call('list_nodes', { cluster: 'approved' })).json.items[0]).toMatchObject({ name: 'node-a', ready: 'True', roles: ['control-plane'], capacity: { cpu: '4' } });
    expect(requests.filter(r => r.path === '/api/v1/pods').at(-1)!.query.get('limit')).toBe('50');
  });
  it('returns object details with sensitive values redacted', async () => {
    const pod = (await call('get_pod_details', { cluster: 'approved', namespace: 'team', name: 'web' })).text;
    expect(pod).not.toContain('hunter2');
    expect(pod).toContain('"secretName": "db"');
    expect(pod).toContain('"MODE"');
    expect((await call('get_deployment_details', { cluster: 'approved', namespace: 'team', name: 'web' })).json.kind).toBe('Deployment');
    expect((await call('get_service_details', { cluster: 'approved', namespace: 'team', name: 'web' })).json.kind).toBe('Service');
    expect((await call('get_node_details', { cluster: 'approved', name: 'node-a' })).json.kind).toBe('Node');
    const ns = (await call('get_namespace_details', { cluster: 'approved', name: 'team' })).json;
    expect(ns.namespace.metadata.annotations).toEqual({});
    expect(ns.resourceQuotas[0]).toMatchObject({ name: 'compute', spec: { hard: { cpu: '4' } } });
  });
  it('returns bounded pod logs with credentials redacted', async () => {
    const { json } = await call('get_pod_logs', { cluster: 'approved', namespace: 'team', name: 'web', tailLines: 50, maxBytes: 2048 });
    expect(json.logs.length).toBeLessThanOrEqual(2048);
    expect(json.logs).toContain('Bearer [redacted]'); expect(json.logs).toContain('password=[redacted]');
    expect(json.logs).not.toMatch(/hunter2|abcdefghijklmnop/);
    const request = requests.filter(r => r.path.endsWith('/log')).at(-1)!;
    expect(Object.fromEntries(request.query)).toMatchObject({ tailLines: '50', limitBytes: '2048', timestamps: 'true' });
  });
  it('lists events and finds the events of one object, redacting credential text', async () => {
    const warnings = (await call('list_events', { cluster: 'approved', namespace: 'team', type: 'Warning' })).json.items;
    expect(warnings).toEqual([expect.objectContaining({ reason: 'BackOff', object: 'Pod/team/web', count: 9 })]);
    expect(warnings[0].message).toContain('token=[redacted]');
    const forPod = (await call('get_resource_events', { cluster: 'approved', namespace: 'team', kind: 'Pod', name: 'worker-1' })).json.items;
    expect(forPod.map((e: any) => e.reason)).toEqual(['Pulled']);
  });
  it('discovers readable resources, skipping subresources and reporting unavailable groups', async () => {
    const { json } = await call('discover_api_resources', { cluster: 'approved' });
    expect(json.resources.map((r: any) => `${r.apiVersion}/${r.resource}`)).toEqual(['apps/v1/deployments', 'v1/bindings', 'v1/configmaps', 'v1/pods', 'v1/secrets']);
    expect(json.resources.find((r: any) => r.resource === 'pods').verbs).toEqual(['get', 'list', 'watch']);
    expect(json.unavailableGroupVersions).toEqual(['metrics.k8s.io/v1beta1']);
    expect((await call('discover_api_resources', { cluster: 'approved', group: 'apps' })).json.resources).toHaveLength(1);
  });
  it('never returns Secret data and redacts sensitive ConfigMap values', async () => {
    const secret = (await call('get_resource_yaml', { cluster: 'approved', apiVersion: 'v1', resource: 'secrets', namespace: 'team', name: 'db' }));
    expect(secret.json).toMatchObject({ kind: 'Secret', type: 'Opaque', dataKeys: ['password', 'user'] });
    expect(secret.text).not.toMatch(/aHVudGVyMg|YWRtaW4|last-applied/);
    const cm = (await call('get_resource_yaml', { cluster: 'approved', apiVersion: 'v1', resource: 'configmaps', namespace: 'team', name: 'settings' })).json;
    expect(cm.data).toEqual({ color: 'blue', api_key: '[redacted]', 'app.properties': 'db.password=[redacted]\nmode=fast' });
  });
  it('only reads advertised, gettable, non-subresource kinds', async () => {
    expect((await call('get_resource_yaml', { cluster: 'approved', apiVersion: 'v1', resource: 'bindings', namespace: 'team', name: 'x' })).text).toMatch(/^UNSUPPORTED/);
    const exec = await call('get_resource_yaml', { cluster: 'approved', apiVersion: 'v1', resource: 'pods/exec', namespace: 'team', name: 'web' });
    expect(exec.error).toBe(true); expect(exec.text).toMatch(invalid);
    expect((await call('get_resource_yaml', { cluster: 'approved', apiVersion: 'v1', resource: 'configmaps', name: 'settings' })).text).toMatch(/^NAMESPACE_REQUIRED/);
  });
  it('truncates oversized output', async () => {
    const { text, error } = await call('get_resource_yaml', { cluster: 'approved', apiVersion: 'v1', resource: 'configmaps', namespace: 'team', name: 'huge' });
    expect(error).toBe(false); expect(text.length).toBeLessThan(MAX_OUTPUT_CHARS + 200); expect(text).toMatch(/output truncated/);
  });
});

describe('failures', () => {
  it('reports RBAC denials with the API server explanation', async () => {
    expect((await call('list_pods', { cluster: 'approved', namespace: 'locked' })).text).toBe('FORBIDDEN: Kubernetes API: pods is forbidden: User "dev" cannot list resource "pods" in API group "" in the namespace "locked"');
  });
  it('rejects invalid arguments before any request', async () => {
    const before = requests.length;
    for (const [tool, args] of [['list_pods', { cluster: 'approved', namespace: '../kube-system' }], ['get_pod_details', { cluster: 'approved', namespace: 'team', name: '../../secrets/db' }], ['list_pods', { cluster: 'approved', limit: 100000 }], ['get_pod_logs', { cluster: 'approved', namespace: 'team', name: 'web', maxBytes: 10_000_000 }], ['get_resource_events', { cluster: 'approved', kind: 'Pod', name: 'web,involvedObject.name=other' }], ['get_resource_yaml', { cluster: 'approved', apiVersion: '../v1', resource: 'pods', name: 'x' }], ['list_pods', {}]] as const) {
      const result = await call(tool, args);
      expect(result.error, tool).toBe(true); expect(result.text, `${tool} ${JSON.stringify(args)}`).toMatch(invalid);
    }
    expect(requests.length).toBe(before);
  });
  it('handles malformed responses, unreachable clusters and timeouts', async () => {
    expect((await call('list_pods', { cluster: 'approved', namespace: 'broken' })).text).toMatch(/^MALFORMED_RESPONSE/);
    expect((await call('get_cluster_info', { cluster: 'dead' })).text).toMatch(/^(UNREACHABLE|REQUEST_FAILED): /);
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(200));
    try { expect((await call('list_pods', { cluster: 'approved', namespace: 'slow' })).text).toMatch(/^TIMEOUT: /); } finally { spy.mockRestore(); }
  });
  it('skips malformed kubeconfig files instead of failing', async () => {
    const bad = join(dataDir, 'bad-config'); writeFileSync(bad, 'apiVersion: v1\nkind: Config\nclusters: [\n');
    const withBad = new ApprovedClusters(new ClusterManager([kubeconfig, bad], join(dataDir, 'kubeconfig-sources.json')), accessPath(dataDir));
    expect(withBad.list().clusters.map(c => c.context).sort()).toEqual(['approved', 'dead', 'exec-ctx']);
  });
  it('only ever sent GET requests to the cluster', () => {
    expect(requests.length).toBeGreaterThan(20);
    expect([...new Set(requests.map(r => r.method))]).toEqual(['GET']);
  });
});
