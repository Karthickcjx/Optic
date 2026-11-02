import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { ClusterManager } from '../main/clusters';
import { accessPath, authOf, fingerprint, opticDataDir, readAccess, writeAccess } from './access';
import { ApprovedClusters, call, tools } from './tools';

export const serverVersion = '1.0.0';

export function createMcpServer(clusters: ApprovedClusters) {
  const server = new McpServer({ name: 'optic-kubernetes', version: serverVersion }, { instructions: 'Read-only access to Kubernetes clusters the user approved in Optic. Start with list_clusters. No tool changes cluster state.' });
  for (const [name, tool] of Object.entries(tools(clusters))) {
    // Validation happens in call() so invalid arguments become tool errors with a clear message.
    server.registerTool(name, { title: tool.title, description: tool.description, inputSchema: tool.input, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }, (args: unknown) => call(tool, args));
  }
  return server;
}

// Discovery uses the same kubeconfig sources as the desktop app, including kubeconfigs imported into Optic.
export function clusterManager(dataDir: string) { return new ClusterManager(undefined, join(dataDir, 'kubeconfig-sources.json')); }

const usage = `Optic MCP server (read-only Kubernetes access for AI clients)

  optic --mcp                    Serve MCP over stdio (configure this in your MCP client)
  optic --mcp --list             Show kubeconfig contexts and their approval state
  optic --mcp --allow <context>  Approve a context (interactive terminal only)
  optic --mcp --revoke <context> Revoke a context
  optic --mcp --revoke-all       Revoke every approval

Approvals can also be managed in Optic > Cluster settings > AI access.`;

type Io = { out: (text: string) => void; err: (text: string) => void; interactive: boolean; ask: (question: string) => Promise<string> };
const defaultIo: Io = {
  out: text => process.stdout.write(`${text}\n`), err: text => process.stderr.write(`${text}\n`), interactive: !!process.stdin.isTTY && !!process.stdout.isTTY,
  ask: async question => { const rl = createInterface({ input: process.stdin, output: process.stdout }); try { return await rl.question(question); } finally { rl.close(); } }
};

// Returns an exit code for management commands; resolves when the client disconnects in serve mode.
export async function runMcp(args: string[], dataDir = opticDataDir(), io: Io = defaultIo): Promise<number> {
  const manager = clusterManager(dataDir), file = accessPath(dataDir);
  const find = (selector: string) => { const all = manager.discover().clusters; return all.filter(c => c.id === selector || c.name === selector); };
  if (args.includes('--help')) { io.out(usage); return 0; }
  if (args.includes('--list')) {
    const approvals = readAccess(file).clusters;
    for (const c of manager.discover().clusters) {
      const config = manager.get(c.id, true).config, state = !approvals[c.id] ? 'not approved' : approvals[c.id].fingerprint === fingerprint(config) ? 'approved' : 'needs re-approval';
      io.out(`${c.id}  ${state.padEnd(17)}  ${c.name}  (${authOf(config).type})`);
    }
    return 0;
  }
  if (args.includes('--revoke-all')) { writeAccess({ version: 1, clusters: {} }, file); io.out('All MCP approvals revoked.'); return 0; }
  const revoke = args.indexOf('--revoke');
  if (revoke >= 0) {
    const selector = args[revoke + 1] ?? '', store = readAccess(file);
    const ids = Object.entries(store.clusters).filter(([id, a]) => id === selector || a.context === selector).map(([id]) => id);
    if (!ids.length) { io.err(`No approval matches "${selector}".`); return 1; }
    for (const id of ids) delete store.clusters[id];
    writeAccess(store, file); io.out(`Revoked ${ids.length} approval(s).`); return 0;
  }
  const allow = args.indexOf('--allow');
  if (allow >= 0) {
    // Approval needs a person at a terminal: an agent running shell commands cannot approve clusters for itself.
    if (!io.interactive) { io.err('Approving a cluster requires an interactive terminal. Use Optic > Cluster settings > AI access, or run this command yourself in a terminal.'); return 1; }
    const matches = find(args[allow + 1] ?? '');
    if (matches.length !== 1) { io.err(matches.length ? 'Several contexts match; use the id from --list.' : 'No kubeconfig context matches. Use --list.'); return 1; }
    const cluster = matches[0], config = manager.get(cluster.id, true).config, auth = authOf(config);
    io.out(`Context: ${cluster.name}\nKubeconfig: ${cluster.source}\nServer: ${cluster.server}\nAuthentication: ${auth.type}${'command' in auth && auth.command ? `\nCredential command run by the MCP server: ${[auth.command, ...('args' in auth ? auth.args : [])].join(' ')}` : ''}\nAI clients will be able to read this cluster (Secret values are never returned).`);
    if ((await io.ask('Type the context name to approve: ')).trim() !== cluster.name) { io.err('Not approved.'); return 1; }
    const store = readAccess(file); store.clusters[cluster.id] = { context: cluster.name, source: cluster.source, fingerprint: fingerprint(config), approvedAt: new Date().toISOString() };
    writeAccess(store, file); io.out('Approved.'); return 0;
  }
  if (args.some(a => a.startsWith('--'))) { io.err(usage); return 2; }
  const server = createMcpServer(new ApprovedClusters(manager, file)), transport = new StdioServerTransport();
  await server.connect(transport);
  // The server owns the transport's callbacks once connected; stdin ending means the client went away.
  const closed = new Promise<void>(resolve => { server.server.onclose = () => resolve(); process.stdin.once('end', () => resolve()); });
  io.err('Optic MCP server ready (stdio, read-only).');
  await closed; await server.close().catch(() => {});
  return 0;
}
