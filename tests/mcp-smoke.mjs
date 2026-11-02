// Process-level MCP checks against the built app: stdio handshake, tool calls, approvals and shutdown,
// for both `node out/main/mcp.js` and the Electron binary started with `--mcp`.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const requests = [];
const api = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost'); requests.push(`${req.method} ${url.pathname}`);
  const send = body => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/version') return send({ gitVersion: 'v1.36.0-smoke' });
  if (url.pathname === '/api/v1/namespaces/default/pods') return send({ items: [{ metadata: { name: 'api', namespace: 'default', uid: 'p' }, spec: { containers: [{ name: 'app' }] }, status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0 }] } }], metadata: {} });
  res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ kind: 'Status', apiVersion: 'v1', message: 'not found', code: 404 }));
});
await new Promise(r => api.listen(0, '127.0.0.1', r));
const temp = await mkdtemp(join(tmpdir(), 'optic-mcp-smoke-'));
const kubeconfig = join(temp, 'config');
await writeFile(kubeconfig, `apiVersion: v1\nkind: Config\nclusters:\n- name: smoke\n  cluster: { server: "http://127.0.0.1:${api.address().port}", insecure-skip-tls-verify: true }\nusers:\n- name: u\n  user: { token: smoke-token }\ncontexts:\n- name: smoke\n  context: { cluster: smoke, user: u, namespace: default }\n- name: hidden\n  context: { cluster: smoke, user: u }\ncurrent-context: smoke\n`);

// Approvals use the real fingerprint code (Node runs the TypeScript module directly); the cluster id
// matches ClusterManager: sha256(kubeconfig path, NUL, context name).
async function setApproval(dataDir, path, context) {
  const { KubeConfig } = require('@kubernetes/client-node');
  const { accessPath, setAccess } = await import('../src/mcp/access.ts');
  const config = new KubeConfig(); config.loadFromFile(path); config.setCurrentContext(context);
  const id = createHash('sha256').update(`${resolve(path)}\0${context}`).digest('hex').slice(0, 24);
  setAccess(id, { name: context, source: resolve(path) }, config, true, accessPath(dataDir));
}

async function session(label, command, args, dataDir) {
  const env = { ...process.env, WORKBENCH_KUBECONFIG: kubeconfig, OPTIC_DATA_DIR: dataDir }; delete env.ELECTRON_RUN_AS_NODE;
  const transport = new StdioClientTransport({ command, args, env, stderr: 'pipe', cwd: resolve('.') });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'optic-smoke', version: '1' });
  try { await client.connect(transport); } catch (error) { throw new Error(`${label}: MCP connect failed: ${error.message}
${stderr}`); }
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 17, `${label}: tool count`);
    assert.ok(tools.every(t => t.annotations?.readOnlyHint === true), `${label}: read-only annotations`);
    const listed = JSON.parse((await client.callTool({ name: 'list_clusters', arguments: {} })).content[0].text);
    assert.deepEqual(listed.clusters.map(c => c.context), ['smoke'], `${label}: only approved contexts`);
    assert.equal(listed.unapprovedContexts, 1);
    const pods = JSON.parse((await client.callTool({ name: 'list_pods', arguments: { cluster: 'smoke', namespace: 'default' } })).content[0].text);
    assert.equal(pods.items[0].name, 'api');
    const denied = await client.callTool({ name: 'list_pods', arguments: { cluster: 'hidden' } });
    assert.equal(denied.isError, true); assert.match(denied.content[0].text, /^NOT_APPROVED/);
    assert.match(stderr, /Optic MCP server ready/);
  } finally { await client.close(); }
  // Closing the client closes stdin; the server process must exit on its own.
  const pid = transport.pid;
  for (let i = 0; i < 50 && pid && alive(pid); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(!pid || !alive(pid), `${label}: process exits after the client disconnects`);
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

try {
  // Approve "smoke" only, in isolated profiles for each mode.
  const nodeData = join(temp, 'node-profile'), electronData = join(temp, 'electron-profile');
  await setApproval(nodeData, kubeconfig, 'smoke'); await setApproval(electronData, kubeconfig, 'smoke');
  await session('node', process.execPath, ['out/main/mcp.js'], nodeData);
  await session('electron', electronPath, ['.', `--user-data-dir=${electronData}`, '--mcp'], electronData);
  assert.ok(requests.every(r => r.startsWith('GET ')), 'only GET requests reach the cluster');
  console.log('PASS: MCP server over stdio (node and Electron --mcp): handshake, 17 read-only tools, approved-only clusters, tool calls, GET-only traffic, exit on disconnect.');
} finally { api.closeAllConnections(); api.close(); await rm(temp, { recursive: true, force: true }); }
