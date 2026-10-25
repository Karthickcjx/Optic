import { execFile, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { parse, parseAllDocuments, stringify } from 'yaml';
import { AppError } from './errors';
import { helmFailure, helmReleaseStatuses } from './helm-cli';
import type { ClusterManager } from './clusters';
import type { HelmRepository, HelmChart, HelmTarget, HelmInstall, HelmDetails, HelmRelease, HelmRevision } from '../shared/helm';

const defaults: HelmRepository[] = [{ name: 'argo', url: 'https://argoproj.github.io/argo-helm' }, { name: 'bitnami', url: 'https://charts.bitnami.com/bitnami' }, { name: 'prometheus-community', url: 'https://prometheus-community.github.io/helm-charts' }];
export function publicUrl(value: string, oci = false) {
  try { const url = new URL(value); return (url.protocol === 'https:' || (oci && url.protocol === 'oci:')) && !url.username && !url.password && !url.hash && !url.search; } catch { return false; }
}
export function validateValues(value: string) {
  try { const data = parse(value); if (data !== null && data !== undefined && (typeof data !== 'object' || Array.isArray(data))) throw new Error(); }
  catch { throw new AppError('INVALID_VALUES', 'Values must be valid YAML containing a mapping.'); }
}
export function redactManifest(value: string) {
  const docs = parseAllDocuments(value);
  if (docs.some(d => d.errors.length)) throw new AppError('HELM_OUTPUT', 'Helm returned an invalid manifest.');
  const clean = (obj: any): any => {
    if (!obj || typeof obj !== 'object') return obj;
    if (obj.kind === 'Secret') { obj.data = { redacted: '[hidden]' }; delete obj.stringData; }
    if (obj.metadata?.annotations) delete obj.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];
    if (Array.isArray(obj.items)) obj.items = obj.items.map(clean);
    return obj;
  };
  return { manifest: docs.map(d => stringify(clean(d.toJS({ maxAliasCount: 100 })))).join('---\n'), resources: docs.filter(d => d.contents).length };
}
export function installArgs(input: HelmInstall, reference: string, valuesPath: string, preview = false) {
  const args = [preview ? 'template' : input.action, input.release, reference, '--version', input.version, '--namespace', input.namespace, '--values', valuesPath];
  if (preview) args.push('--include-crds', ...(input.action === 'upgrade' ? ['--is-upgrade'] : []));
  else args.push('--wait', '--timeout', '5m', ...(input.action === 'install' ? ['--create-namespace'] : ['--reset-values']));
  return args;
}
export class HelmService {
  private repos = defaults;
  private indexes = new Map<string, { expires: number; entries: Record<string, any[]> }>();
  private children = new Set<ChildProcess>();
  private busy = new Set<string>();
  private previews = new Map<string, { hash: string; reference: string; expires: number }>();
  private chartCommands = new Map<string, Promise<void>>();
  private disposed = false;
  constructor(private clusters: ClusterManager, private path: string, private otherBusy: (id: string) => boolean = () => false) {
    if (existsSync(path)) { try { const value = JSON.parse(readFileSync(path, 'utf8')); if (Array.isArray(value) && value.every(r => /^[a-z0-9][a-z0-9-]{0,62}$/.test(r.name) && publicUrl(r.url))) this.repos = value; } catch {} }
  }
  repositories() { return this.repos.map(r => ({ ...r })); }
  saveRepository(repository: HelmRepository, remove = false) {
    const next = remove ? this.repos.filter(r => r.name !== repository.name) : [...this.repos.filter(r => r.name !== repository.name), repository];
    mkdirSync(dirname(this.path), { recursive: true }); writeFileSync(`${this.path}.tmp`, JSON.stringify(next), { mode: 0o600 }); renameSync(`${this.path}.tmp`, this.path);
    this.repos = next; this.indexes.clear(); this.previews.clear(); return this.repositories();
  }
  private repository(name: string) { const repo = this.repos.find(r => r.name === name); if (!repo) throw new AppError('UNKNOWN_REPOSITORY', 'Select a configured Helm repository.'); return repo; }
  private async index(name: string, refresh = false) {
    const repo = this.repository(name), cached = this.indexes.get(name);
    if (!refresh && cached && cached.expires > Date.now()) return cached.entries;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(`${repo.url.replace(/\/$/, '')}/index.yaml`, { signal: controller.signal });
      if (!response.ok || !response.body) throw new Error();
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 64_000_000) { controller.abort(); throw new Error(); } chunks.push(value); }
      const data = parse(Buffer.concat(chunks).toString('utf8'));
      if (data?.apiVersion !== 'v1' || !data.entries || typeof data.entries !== 'object') throw new Error();
      this.indexes.set(name, { entries: data.entries, expires: Date.now() + 300000 }); return data.entries as Record<string, any[]>;
    } catch { throw new AppError('REPOSITORY_UNAVAILABLE', 'Could not read the repository index. Check its HTTPS URL and network access. Catalogs larger than 64 MB are not supported.'); }
    finally { clearTimeout(timer); }
  }
  private versionsFrom(entries: Record<string, any[]>, chart: string) {
    return (Array.isArray(entries[chart]) ? entries[chart] : []).filter(e => e.name === chart && typeof e.version === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.+-]+)?$/.test(e.version)).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  }
  async charts(repository: string, refresh = false): Promise<HelmChart[]> {
    const entries = await this.index(repository, refresh);
    return Object.keys(entries).flatMap(name => { const versions = this.versionsFrom(entries, name); const e = versions.find(v => !v.version.includes('-')) ?? versions[0]; return e ? [{ name, description: String(e.description ?? '').slice(0, 2000), version: e.version, appVersion: String(e.appVersion ?? ''), repository, deprecated: !!e.deprecated }] : []; });
  }
  async versions(repository: string, chart: string) { return this.versionsFrom(await this.index(repository), chart).map(e => ({ version: e.version as string, appVersion: String(e.appVersion ?? '') })); }
  private async reference(repository: string, chart: string, version: string) {
    const e = this.versionsFrom(await this.index(repository), chart).find(e => e.version === version);
    if (!e || !Array.isArray(e.urls)) throw new AppError('CHART_NOT_FOUND', 'This chart version is not in the repository index. Refresh the catalog.');
    for (const url of e.urls) { if (typeof url !== 'string') continue; const resolved = new URL(url, `${this.repository(repository).url.replace(/\/$/, '')}/`).href; if (publicUrl(resolved, true)) return resolved; }
    throw new AppError('CHART_NOT_FOUND', 'This chart has no supported HTTPS or public OCI package URL.');
  }
  isBusy(id: string) { return this.busy.has(id); }
  dispose() { this.disposed = true; for (const child of this.children) child.kill(); this.children.clear(); this.previews.clear(); }
  private async chartCommand(reference: string, args: string[]) {
    // Helm's Windows content cache cannot rename concurrent downloads of the same chart.
    const previous = this.chartCommands.get(reference) ?? Promise.resolve();
    const result = previous.then(() => this.command(args));
    const settled = result.then(() => {}, () => {});
    this.chartCommands.set(reference, settled);
    try { return await result; }
    finally { if (this.chartCommands.get(reference) === settled) this.chartCommands.delete(reference); }
  }
  private async command(args: string[]) {
    if (this.disposed) throw new AppError('HELM_CLOSED', 'The Helm service has closed. Reopen Optic before retrying.');
    try {
      return await new Promise<string>((resolve, reject) => {
        const child = execFile('helm', args, { shell: false, windowsHide: true, timeout: 360000, maxBuffer: 8_000_000 }, (error, stdout, stderr) => {
          this.children.delete(child);
          if (error) reject(new AppError('HELM_FAILED', helmFailure(error, stderr)));
          else resolve(stdout);
        }); this.children.add(child);
      });
    } catch (e) { if (e instanceof AppError) throw e; throw new AppError('HELM_BLOCKED', 'Helm could not start. Verify installation and Windows application-control approval.'); }
  }
  private async withConfig<T>(id: string, fn: (path: string) => Promise<T>) { const lease = this.clusters.cliConfig(id); try { return await fn(lease.path); } finally { lease.cleanup(); } }
  private json(text: string) { try { return JSON.parse(text); } catch { throw new AppError('HELM_OUTPUT', 'Helm returned unexpected JSON output. Check your Helm version.'); } }
  async chartInfo(repository: string, chart: string, version: string) {
    const reference = await this.reference(repository, chart, version);
    const [values, readme] = await Promise.all([this.chartCommand(reference, ['show', 'values', reference, '--version', version]), this.chartCommand(reference, ['show', 'readme', reference, '--version', version])]);
    return { values, readme };
  }
  async releases(clusterId: string, namespace?: string): Promise<HelmRelease[]> {
    return this.withConfig(clusterId, async path => {
      const rows: HelmRelease[] = [];
      for (let offset = 0; offset < 10000; offset += 256) {
        const page = this.json(await this.command(['list', ...helmReleaseStatuses, ...(namespace ? ['--namespace', namespace] : ['--all-namespaces']), '--max', '256', '--offset', String(offset), '--output', 'json', '--kubeconfig', path]));
        if (!Array.isArray(page)) throw new AppError('HELM_OUTPUT', 'Unexpected release list.');
        rows.push(...page); if (page.length < 256) return rows;
      }
      throw new AppError('HELM_LIMIT', 'More than 10,000 releases. Select a namespace to narrow the list.');
    });
  }
  async details(input: HelmTarget): Promise<HelmDetails> {
    return this.withConfig(input.clusterId, async path => {
      const flags = ['--namespace', input.namespace, '--kubeconfig', path];
      const results = await Promise.allSettled([
        this.command(['status', input.release, '--output', 'json', ...flags]), this.command(['get', 'values', input.release, '--output', 'yaml', ...flags]),
        this.command(['get', 'manifest', input.release, ...flags]), this.command(['history', input.release, '--max', '256', '--output', 'json', ...flags]), this.command(['get', 'notes', input.release, ...flags])
      ]);
      const failure = results.find(r => r.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      const [status, values, manifest, history, notes] = results.map(r => (r as PromiseFulfilledResult<string>).value);
      const revisions = this.json(history); if (!Array.isArray(revisions)) throw new AppError('HELM_OUTPUT', 'Unexpected release history.');
      const info = this.json(status)?.info;
      return { diagnostic: info?.status === 'failed' ? helmFailure({}, String(info.description ?? '')) : undefined, status: String(info?.status ?? 'unknown'), values: /^null\s*$/.test(values) ? '{}\n' : values, manifest: redactManifest(manifest).manifest, history: revisions as HelmRevision[], notes };
    });
  }
  private digest(input: HelmInstall) { return createHash('sha256').update(JSON.stringify(input)).digest('hex'); }
  async preview(input: HelmInstall) {
    validateValues(input.values); const reference = await this.reference(input.repository, input.chart, input.version);
    const result = await this.withConfig(input.clusterId, async path => {
      const valuesPath = join(dirname(path), 'values.yaml'); writeFileSync(valuesPath, input.values || '{}', { mode: 0o600, flag: 'wx' });
      return redactManifest(await this.chartCommand(reference, [...installArgs(input, reference, valuesPath, true), '--kubeconfig', path]));
    });
    for (const [token, p] of this.previews) if (p.expires < Date.now()) this.previews.delete(token);
    if (this.previews.size >= 50) this.previews.delete(this.previews.keys().next().value!);
    const token = randomUUID(); this.previews.set(token, { hash: this.digest(input), reference, expires: Date.now() + 600000 }); return { ...result, token };
  }
  private async mutation<T>(id: string, fn: () => Promise<T>) {
    if (this.busy.has(id) || this.otherBusy(id)) throw new AppError('HELM_BUSY', 'A Helm operation is already running in this cluster.');
    this.busy.add(id); try { return await fn(); } finally { this.busy.delete(id); }
  }
  async apply(input: HelmInstall, token: string) {
    const preview = this.previews.get(token);
    if (!preview || preview.expires < Date.now() || preview.hash !== this.digest(input)) throw new AppError('PREVIEW_REQUIRED', 'Preview these exact settings again before applying. Preview expires after 10 minutes.');
    return this.mutation(input.clusterId, async () => {
      this.previews.delete(token);
      await this.withConfig(input.clusterId, async path => {
        const valuesPath = join(dirname(path), 'values.yaml'); writeFileSync(valuesPath, input.values || '{}', { mode: 0o600, flag: 'wx' });
        await this.chartCommand(preview.reference, [...installArgs(input, preview.reference, valuesPath), '--kubeconfig', path]);
      });
    });
  }
  async rollback(input: HelmTarget, revision: number) {
    return this.mutation(input.clusterId, () => this.withConfig(input.clusterId, async path => { await this.command(['rollback', input.release, String(revision), '--namespace', input.namespace, '--wait', '--timeout', '5m', '--kubeconfig', path]); }));
  }
  async uninstall(input: HelmTarget) {
    return this.mutation(input.clusterId, () => this.withConfig(input.clusterId, async path => { await this.command(['uninstall', input.release, '--namespace', input.namespace, '--wait', '--timeout', '5m', '--kubeconfig', path]); }));
  }
}
