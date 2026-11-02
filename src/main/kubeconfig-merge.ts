import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { KubeConfig, type Cluster, type Context, type User } from '@kubernetes/client-node';
import { parse } from 'yaml';

// Files kubectl would read: the KUBECONFIG list (WORKBENCH_KUBECONFIG in tests) in order, or ~/.kube/config when unset.
export function kubeconfigChain(env: NodeJS.ProcessEnv = process.env) {
  const list = env.WORKBENCH_KUBECONFIG || env.KUBECONFIG;
  return [...new Set((list ? list.split(delimiter).filter(Boolean) : [join(homedir(), '.kube', 'config')]).map(p => resolve(p)))];
}

const rec = (v: unknown): Record<string, any> | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : undefined;
const absolute = (dir: string, value: unknown) => typeof value === 'string' && value && !isAbsolute(value) ? resolve(dir, value) : value;
// Like client-go's ResolveLocalPaths: file references are relative to the kubeconfig that declares them. An exec
// command is resolved only when written as a path; a bare name ("aws") is still looked up on PATH.
function resolveReferences(raw: Record<string, any>, dir: string) {
  for (const entry of Array.isArray(raw.clusters) ? raw.clusters : []) { const c = rec(rec(entry)?.cluster); if (c) c['certificate-authority'] = absolute(dir, c['certificate-authority']); }
  for (const entry of Array.isArray(raw.users) ? raw.users : []) {
    const u = rec(rec(entry)?.user); if (!u) continue;
    for (const key of ['client-certificate', 'client-key', 'token-file']) if (key in u) u[key] = absolute(dir, u[key]);
    const exec = rec(u.exec); if (exec && typeof exec.command === 'string' && /[\\/]/.test(exec.command)) exec.command = absolute(dir, exec.command);
  }
}

export function readKubeconfig(path: string) {
  if (statSync(path).size > 8_000_000) throw new Error('Kubeconfig too large');
  const raw = rec(parse(readFileSync(path, 'utf8'), { maxAliasCount: 50 }));
  if (!raw) throw new Error('Not a kubeconfig');
  resolveReferences(raw, dirname(path));
  const config = new KubeConfig(); config.loadFromString(JSON.stringify(raw));
  return config;
}

export interface MergedContext { name: string; file: string; context: Context; cluster?: Cluster; user?: User }
// kubectl merge rules: files are read in order, missing files are skipped, and the first file to define a cluster,
// user or context name (or current-context) wins. A context may reference a cluster or user from another file.
// Unlike kubectl, an unreadable file is skipped with a warning instead of failing the whole list.
export function mergeKubeconfigs(paths: string[]) {
  const clusters = new Map<string, Cluster>(), users = new Map<string, User>(), contexts = new Map<string, { context: Context; file: string }>();
  const warnings: string[] = []; let currentContext: string | undefined;
  for (const path of paths) {
    if (!existsSync(path)) continue;
    let config: KubeConfig;
    try { config = readKubeconfig(path); } catch { warnings.push(`Could not load kubeconfig: ${path}`); continue; }
    currentContext ??= config.getCurrentContext() || undefined;
    for (const c of config.getClusters()) if (!clusters.has(c.name)) clusters.set(c.name, c);
    for (const u of config.getUsers()) if (!users.has(u.name)) users.set(u.name, u);
    for (const c of config.getContexts()) if (!contexts.has(c.name)) contexts.set(c.name, { context: c, file: path });
  }
  return { currentContext, warnings, contexts: [...contexts.values()].map(({ context, file }): MergedContext => ({ name: context.name, file, context, cluster: clusters.get(context.cluster), user: context.user ? users.get(context.user) : undefined })) };
}
