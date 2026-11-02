import { ClusterSettingsStore } from './cluster-settings';
import type { ClusterSettings } from '../shared/cluster-settings';
import { KubeConfig } from '@kubernetes/client-node';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, statSync, realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseDocument, isSeq } from 'yaml';
import { tmpdir } from 'node:os';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { kubeJson } from './kube-http';
import { kubeconfigChain, mergeKubeconfigs } from './kubeconfig-merge';
import type { Cluster } from '../shared/protocol';
import { AppError } from './errors';

export class ClusterManager {
  readonly preferences: ClusterSettingsStore;
  private disconnected = new Set<string>();
  private imported: string[] = [];
  constructor(private paths?: string[], private settingsPath?: string) {
    this.preferences = new ClusterSettingsStore(settingsPath ? join(dirname(settingsPath), 'cluster-settings.json') : undefined);
    if (settingsPath && existsSync(settingsPath)) { try { const value = JSON.parse(readFileSync(settingsPath, 'utf8')); if (Array.isArray(value)) this.imported = value.filter(p => typeof p === 'string'); } catch {} }
  }
  importClipboard(source: string) {
    if (!source.trim()) throw new AppError('INVALID_CONFIG', 'The clipboard is empty. Copy a kubeconfig first.');
    if (Buffer.byteLength(source, 'utf8') > 8_000_000) throw new AppError('INVALID_CONFIG', 'Clipboard kubeconfig exceeds the 8 MB limit.');
    const config = new KubeConfig();
    try {
      const document = parseDocument(source);
      if (document.errors.length || document.get('kind') !== 'Config' || document.get('apiVersion') !== 'v1') throw new Error();
      config.loadFromString(source);
      if (!config.getContexts().length) throw new Error();
      for (const context of config.getContexts()) {
        const cluster = config.getCluster(context.cluster);
        if (!cluster || !/^https?:\/\//.test(cluster.server) || (context.user && !config.getUser(context.user))) throw new Error();
      }
    } catch { throw new AppError('INVALID_CONFIG', 'Clipboard does not contain a valid v1 kubeconfig with usable context references.'); }
    const files = [...config.getClusters().map(c => c.caFile), ...config.getUsers().flatMap(u => [u.certFile, u.keyFile])].filter(Boolean) as string[];
    if (files.some(path => !isAbsolute(path))) throw new AppError('INVALID_CONFIG', 'Clipboard kubeconfigs need embedded certificates or absolute certificate/key paths. Use filesystem import for relative paths.');
    if (!this.settingsPath) throw new AppError('INVALID_CONFIG', 'The application profile is unavailable.');
    const directory = join(dirname(this.settingsPath), 'kubeconfigs');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    let path = join(directory, `clipboard-${createHash('sha256').update(source).digest('hex')}.yaml`);
    if (existsSync(path) && readFileSync(path, 'utf8') !== source) path = join(directory, `clipboard-${randomUUID()}.yaml`);
    const created = !existsSync(path);
    if (created) writeFileSync(path, source, { mode: 0o600, flag: 'wx' });
    try { return this.addPaths([path]); } catch (error) { if (created) unlinkSync(path); throw error; }
  }
  addPaths(paths: string[]) {
    for (const path of paths) { const config = new KubeConfig(); config.loadFromFile(path); if (!config.getContexts().length) throw new AppError('INVALID_CONFIG', 'The selected file has no Kubernetes contexts.'); }
    this.imported = [...new Set([...this.imported, ...paths])];
    if (this.settingsPath) { mkdirSync(dirname(this.settingsPath), { recursive: true }); writeFileSync(this.settingsPath, JSON.stringify(this.imported), { mode: 0o600 }); }
    return this.discover();
  }
  private entries = new Map<string, { cluster: Cluster; config: KubeConfig; baseProxy?: string }>();
  discover() {
    const next = new Map<string, { cluster: Cluster; config: KubeConfig; baseProxy?: string }>();
    const warnings: string[] = [];
    // The KUBECONFIG chain (or ~/.kube/config) is merged as kubectl does; kubeconfigs imported into Optic stay isolated.
    // Each file is parsed once. IDs remain sha256(defining file, context name), so settings and approvals keep applying.
    const chain = this.paths ?? kubeconfigChain();
    const add = (merged: ReturnType<typeof mergeKubeconfigs>) => {
      warnings.push(...merged.warnings);
      for (const { name, file, context, cluster, user } of merged.contexts) {
        if (!cluster || !/^https?:\/\//.test(cluster.server)) { warnings.push(`Invalid cluster in context ${name}`); continue; }
        if (context.user && !user) warnings.push(`Context ${name} references a missing user; it connects without credentials.`);
        const id = createHash('sha256').update(`${file}\0${name}`).digest('hex').slice(0, 24);
        if (next.has(id)) continue;
        const config = new KubeConfig(); config.loadFromOptions({ clusters: [cluster], users: user ? [user] : [], contexts: [context], currentContext: name });
        next.set(id, { baseProxy: cluster.proxyUrl, cluster: { id, name, server: cluster.server, source: file, namespace: context.namespace ?? 'default', connected: !this.disconnected.has(id) }, config });
      }
    };
    add(mergeKubeconfigs(chain));
    for (const path of this.imported) if (!chain.includes(resolve(path))) add(mergeKubeconfigs([path]));
    this.entries = next;
    return { clusters: [...next.values()].map(e => e.cluster), warnings };
  }
  get(id: string, allowDisconnected = false) {
    const entry = this.entries.get(id);
    if (!entry) throw new AppError('UNKNOWN_CLUSTER', 'Cluster is unavailable. Refresh the context list.');
    if (!allowDisconnected && this.disconnected.has(id)) throw new AppError('DISCONNECTED', 'Cluster is disconnected. Use Connect to resume.');
    const proxyUrl = this.preferences.get(id, entry.cluster.namespace).proxyUrl || entry.baseProxy;
    if (entry.config.getCurrentCluster()!.proxyUrl !== proxyUrl) entry.config.loadFromOptions({ clusters: entry.config.getClusters().map(c => c.name === entry.config.getCurrentCluster()!.name ? { ...c, proxyUrl } : c), users: entry.config.getUsers(), contexts: entry.config.getContexts(), currentContext: entry.config.getCurrentContext() });
    return entry;
  }
  settings(id: string) { return this.preferences.get(id, this.get(id, true).cluster.namespace); }
  saveSettings(id: string, value: ClusterSettings) {
    this.get(id, true);
    if (value.terminalCwd && (!isAbsolute(value.terminalCwd) || !existsSync(value.terminalCwd) || !statSync(value.terminalCwd).isDirectory())) throw new AppError('INVALID_DIRECTORY', 'Choose an existing absolute terminal working directory.');
    return this.preferences.save(id, value);
  }
  disconnect(id: string) { this.get(id, true).cluster.connected = false; this.disconnected.add(id); }
  async connect(id: string) {
    this.discover(); const entry = this.get(id, true);
    const start = Date.now(); const result = await kubeJson<{ gitVersion: string }>(entry.config, '/version');
    this.disconnected.delete(id); entry.cluster.connected = true;
    return { version: result.gitVersion, latencyMs: Date.now() - start };
  }
  cliConfig(id: string) {
    const { config, cluster } = this.get(id); const settings = this.settings(id);
    const isolated = new KubeConfig(), user = config.getCurrentUser();
    isolated.loadFromOptions({ clusters: [config.getCurrentCluster()!], users: user ? [user] : [], contexts: [{ ...config.getContextObject(cluster.name)!, namespace: settings.defaultNamespace }], currentContext: cluster.name });
    const directory = mkdtempSync(join(tmpdir(), 'optic-session-')); const path = join(directory, 'config');
    try { writeFileSync(path, isolated.exportConfig(), { mode: 0o600 }); } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
    return { path, cleanup: () => { try { rmSync(directory, { recursive: true, force: true, maxRetries: 3 }); } catch { console.warn('Optic could not remove a temporary session kubeconfig.'); } }, settings };
  }
  removeContext(id: string) {
    const { cluster } = this.get(id, true);
    const path = realpathSync(cluster.source), original = readFileSync(path, 'utf8');
    const document = parseDocument(original);
    const contexts = document.get('contexts');
    if (document.errors.length || !isSeq(contexts)) throw new AppError('INVALID_CONFIG', 'Cannot safely edit this kubeconfig.');
    const index = contexts.items.findIndex(item => (item as any)?.get?.('name') === cluster.name);
    if (index < 0) throw new AppError('CONFLICT', 'Context changed on disk. Reload the cluster list.');
    contexts.delete(index);
    if (document.get('current-context') === cluster.name) document.set('current-context', '');
    const backup = `${path}.workbench-${randomUUID()}.bak`, temporary = `${path}.${randomUUID()}.tmp`;
    // Preserve shared users/clusters and YAML comments. Backups contain credentials like the original file.
    writeFileSync(backup, original, { mode: 0o600, flag: 'wx' });
    try {
      writeFileSync(temporary, document.toString(), { mode: statSync(path).mode & 0o777, flag: 'wx' });
      if (readFileSync(path, 'utf8') !== original) throw new AppError('CONFLICT', 'Kubeconfig changed during editing. No changes were applied.');
      renameSync(temporary, path);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    return { ...this.discover(), backup };
  }
  async health(id: string) {
    const start = Date.now();
    const response = await kubeJson<{ gitVersion: string }>(this.get(id).config, '/version');
    return { version: response.gitVersion ?? 'unknown', latencyMs: Date.now() - start };
  }
}
