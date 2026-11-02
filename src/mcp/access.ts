import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { KubeConfig } from '@kubernetes/client-node';
import { z } from 'zod';

// Same profile directory Electron uses for Optic's userData; OPTIC_DATA_DIR overrides it (tests, portable setups).
export function opticDataDir() {
  if (process.env.OPTIC_DATA_DIR) return process.env.OPTIC_DATA_DIR;
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Optic');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Optic');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Optic');
}

// How a context authenticates. Commands are shown to the user at approval time and bound into the fingerprint,
// so the MCP server never runs a credential command the user did not approve.
export function authOf(config: KubeConfig) {
  const user = config.getCurrentUser() as (ReturnType<KubeConfig['getCurrentUser']> & { exec?: { command?: string; args?: string[]; env?: { name: string }[] }; authProvider?: { name?: string; config?: Record<string, string> } }) | null;
  if (user?.exec?.command) return { type: 'exec' as const, command: user.exec.command, args: user.exec.args ?? [], env: (user.exec.env ?? []).map((e: { name: string }) => e.name).sort() };
  if (user?.authProvider) return { type: 'auth-provider' as const, provider: user.authProvider.name ?? 'unknown', command: user.authProvider.config?.['cmd-path'] };
  if (user?.certData || user?.certFile) return { type: 'client-certificate' as const };
  if (user?.token || (user as { tokenFile?: string } | null)?.tokenFile) return { type: 'token' as const };
  if (user?.username) return { type: 'basic' as const };
  return { type: 'none' as const };
}
export type ContextAuth = ReturnType<typeof authOf>;

// Identity of what an approval covers. Credentials themselves are excluded so routine token or certificate
// rotation keeps the approval; a different server, CA or credential command invalidates it.
export function fingerprint(config: KubeConfig) {
  const cluster = config.getCurrentCluster();
  const ca = cluster?.caData ? createHash('sha256').update(cluster.caData).digest('hex') : cluster?.caFile ?? null;
  return createHash('sha256').update(JSON.stringify({ context: config.getCurrentContext(), server: cluster?.server, ca, skipTLSVerify: !!cluster?.skipTLSVerify, auth: authOf(config) })).digest('hex');
}

const storeSchema = z.object({ version: z.literal(1), clusters: z.record(z.string(), z.object({ context: z.string(), source: z.string(), fingerprint: z.string(), approvedAt: z.string() })) });
export type AccessStore = z.infer<typeof storeSchema>;
export const accessPath = (dataDir = opticDataDir()) => join(dataDir, 'mcp-access.json');

// A missing or unreadable store grants nothing.
export function readAccess(path = accessPath()): AccessStore {
  try { if (existsSync(path)) return storeSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); } catch { /* fall through to no approvals */ }
  return { version: 1, clusters: {} };
}
export function writeAccess(store: AccessStore, path = accessPath()) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(store, null, 2), { mode: 0o600 }); renameSync(temporary, path);
}

// Approval state for one context, as shown in Optic's Cluster settings.
export function accessState(id: string, config: KubeConfig, file: string, launch: { command: string; args: string[] }) {
  const approval = readAccess(file).clusters[id], auth = authOf(config);
  return { approved: !!approval, stale: !!approval && approval.fingerprint !== fingerprint(config), approvedAt: approval?.approvedAt, auth: { type: auth.type, ...('command' in auth && auth.command ? { command: auth.command } : {}), ...('args' in auth ? { args: auth.args } : {}) }, launch };
}
export function setAccess(id: string, cluster: { name: string; source: string }, config: KubeConfig, approved: boolean, file: string) {
  const store = readAccess(file);
  if (approved) store.clusters[id] = { context: cluster.name, source: cluster.source, fingerprint: fingerprint(config), approvedAt: new Date().toISOString() };
  else delete store.clusters[id];
  writeAccess(store, file);
}
