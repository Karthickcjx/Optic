import { parse } from 'yaml';
import { execFile, type ChildProcess } from 'node:child_process';
import type { ClusterManager } from './clusters';
import type { MonitoringChange, MonitoringComponent } from '../shared/cluster-settings';
import { AppError } from './errors';
import { helmFailure, helmReleaseStatuses } from './helm-cli';
const repo = 'https://prometheus-community.github.io/helm-charts';
export function monitoringArgs(change: MonitoringChange): string[] {
  const release = `optic-${change.component}`;
  if (change.action === 'uninstall') return ['uninstall', release, '--namespace', 'optic-monitoring', '--wait', '--timeout', '3m'];
  const args = ['upgrade', '--install', release, change.component, '--repo', repo, '--version', change.version, '--namespace', 'optic-monitoring', '--create-namespace', '--wait', '--timeout', '3m'];
  if (change.component === 'prometheus') args.push('--set', 'alertmanager.enabled=false,kube-state-metrics.enabled=false,prometheus-node-exporter.enabled=false,prometheus-pushgateway.enabled=false');
  // Exporter startup can race the chart's zero-delay probes before :9100 binds.
  if (change.component === 'prometheus-node-exporter') args.push('--set', 'readinessProbe.initialDelaySeconds=5,readinessProbe.timeoutSeconds=3,livenessProbe.initialDelaySeconds=10,livenessProbe.timeoutSeconds=3');
  return args;
}
export class Monitoring {
  private children = new Set<ChildProcess>();
  private busy = new Set<string>();
  constructor(private clusters: ClusterManager) {}
  private catalog?: { expires: number; entries: Record<string, unknown> };
  private catalogRequest?: Promise<Record<string, unknown>>;
  private async chartCatalog(): Promise<Record<string, unknown>> {
    if (this.catalog && this.catalog.expires > Date.now()) return this.catalog.entries;
    if (this.catalogRequest) return this.catalogRequest;
    this.catalogRequest = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await fetch(`${repo}/index.yaml`, { signal: controller.signal });
        if (!response.ok || !response.body) throw new Error('Chart repository unavailable');
        const chunks: Uint8Array[] = []; let size = 0;
        const reader = response.body.getReader();
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          size += chunk.byteLength;
          if (size > 32_000_000) { controller.abort(); throw new Error('Chart catalog exceeds limit'); }
          chunks.push(chunk);
        }
        const catalog = parse(Buffer.concat(chunks).toString('utf8'));
        if (catalog?.apiVersion !== 'v1' || !catalog.entries || typeof catalog.entries !== 'object') throw new Error('Invalid catalog');
        this.catalog = { expires: Date.now() + 300000, entries: catalog.entries };
        return catalog.entries;
      } catch {
        throw new AppError('CHART_LOOKUP_FAILED', 'Could not read the Prometheus community chart repository. Check internet access, then retry or enter a chart version manually. Cluster access and Helm are not needed for this lookup.');
      } finally { clearTimeout(timer); }
    })();
    try { return await this.catalogRequest; } finally { this.catalogRequest = undefined; }
  }
  async latestVersion(component: MonitoringComponent) {
    const entries = (await this.chartCatalog())[component];
    const versions = (Array.isArray(entries) ? entries : []).filter((entry: any) => entry?.name === component && !entry.deprecated && typeof entry.version === 'string' && /^\d+\.\d+\.\d+$/.test(entry.version)).map((entry: any) => entry.version as string);
    versions.sort((a, b) => {
      const av = a.split('.').map(BigInt), bv = b.split('.').map(BigInt);
      for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return av[i] > bv[i] ? -1 : 1;
      return 0;
    });
    if (!versions.length) throw new AppError('CHART_LOOKUP_FAILED', 'No stable chart version was found for this component. Retry or enter a version manually.');
    return { version: versions[0] };
  }
  private async run(id: string, args: string[]) {
    const lease = this.clusters.cliConfig(id);
    try {
      return await new Promise<string>((resolve, reject) => {
        const child = execFile('helm', [...args, '--kubeconfig', lease.path], { windowsHide: true, timeout: 210000, maxBuffer: 2_000_000 }, (error, stdout, stderr) => { this.children.delete(child); error ? reject(new AppError('HELM_FAILED', helmFailure(error, stderr))) : resolve(stdout); });
        this.children.add(child);
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('HELM_FAILED', 'Helm could not start. Verify that Helm is installed and allowed by your operating system application-control policy.');
    } finally { lease.cleanup(); }
  }
  async status(id: string) {
    const entries = JSON.parse(await this.run(id, ['list', '--namespace', 'optic-monitoring', ...helmReleaseStatuses, '--output', 'json']));
    return entries.filter((e: any) => /^optic-(prometheus|kube-state-metrics|prometheus-node-exporter)$/.test(e.name)).map((e: any) => ({ name: String(e.name), status: String(e.status), chart: String(e.chart) }));
  }
  isBusy(id: string) { return this.busy.has(id); }
  dispose() { for (const child of this.children) child.kill(); this.children.clear(); }
  async apply(id: string, changes: MonitoringChange[]) {
    if (this.busy.has(id)) throw new AppError('BUSY', 'A monitoring operation is already running for this context.');
    this.busy.add(id); const completed: string[] = [];
    try {
      for (const change of changes) { await this.run(id, monitoringArgs(change)); completed.push(`${change.action}: ${change.component}`); }
      return { completed };
    } catch (e) { return { completed, error: (e as Error).message }; } finally { this.busy.delete(id); }
  }
}
