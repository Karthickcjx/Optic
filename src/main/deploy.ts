import { randomUUID, createHash } from 'node:crypto';
import { execFile, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent, fetch as secureFetch } from 'undici';
import { parse, parseAllDocuments, stringify } from 'yaml';
import { AppError, fault } from './errors';
import { kubeJson } from './kube-http';
import type { ClusterManager } from './clusters';
import { Imports, inspectArchive } from './imports';
import type { DeployInput, DeployOperation, DeployPreview, DeployRow, RemoteChart } from '../shared/deploy';

function invalid(message: string): never { throw new AppError('INVALID_DEPLOY', message); }
export function parseBatch(files: { name: string; text: string }[]) {
  if (files.reduce((sum, f) => sum + Buffer.byteLength(f.text), 0) > 20 * 1024 * 1024) invalid('Manifest input exceeds 20 MiB.');
  const result: { source: string; body: any }[] = [];
  const add = (body: any, source: string, depth = 0) => {
    if (!body) return;
    if (depth > 10) invalid('List nesting exceeds the limit.');
    if (body.kind === 'List' && body.apiVersion === 'v1' && Array.isArray(body.items)) { for (const item of body.items) add(item, source, depth + 1); return; }
    if (typeof body.apiVersion !== 'string' || !/^(v1|[a-z0-9.-]+\/v\d+(?:(?:alpha|beta)\d+)?)$/.test(body.apiVersion) || typeof body.kind !== 'string' || !/^[A-Za-z][A-Za-z0-9]+$/.test(body.kind) || typeof body.metadata?.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,252}$/.test(body.metadata.name)) invalid(`${source}: each document needs apiVersion, kind and metadata.name.`);
    if (body.metadata.namespace !== undefined && (typeof body.metadata.namespace !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(body.metadata.namespace))) invalid(`${source}: invalid namespace.`);
    delete body.status; delete body.metadata.managedFields; delete body.metadata.resourceVersion; delete body.metadata.uid; delete body.metadata.creationTimestamp;
    if (body.metadata.annotations) delete body.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];
    result.push({ source, body }); if (result.length > 500) invalid('A deployment is limited to 500 resources.');
  };
  for (const file of files) {
    let docs; try { docs = parseAllDocuments(file.text); } catch { invalid(`${file.name}: invalid YAML.`); }
    for (const [i, doc] of docs.entries()) {
      if (doc.errors.length) invalid(`${file.name}, document ${i + 1}: malformed YAML.`);
      let body; try { body = doc.toJS({ maxAliasCount: 50 }); } catch { invalid(`${file.name}: YAML alias limit exceeded.`); }
      add(body, `${file.name}:${i + 1}`);
    }
  }
  if (!result.length) invalid('No resource documents selected.');
  return result.sort((a, b) => stage(a.body) - stage(b.body));
}
const stage = (b: any) => b.kind === 'Namespace' && b.apiVersion === 'v1' ? 0 : b.kind === 'CustomResourceDefinition' && b.apiVersion === 'apiextensions.k8s.io/v1' ? 1 : 2;
export function redacted(body: any) { const copy = structuredClone(body); if (copy.kind === 'Secret') { if (copy.data) copy.data = { redacted: '[hidden]' }; if (copy.stringData) copy.stringData = { redacted: '[hidden]' }; } return copy; }
type Entry = { body: any; row: DeployRow; path: string; deferred: boolean };
type Plan = { owner: number; fingerprint: string; input: DeployInput; preview: DeployPreview; entries: Entry[]; dir: string; chartPath?: string; valuesPaths: string[] };
export class Deployments {
  private plans = new Map<string, Plan>();
  private operations = new Map<string, DeployOperation>();
  private children = new Set<ChildProcess>();
  private busy = new Set<string>();
  private stopRequests = new Set<string>();
  private stopped = false;
  private timer = setInterval(() => { for (const [id, plan] of this.plans) if (plan.preview.expires < Date.now()) { rmSync(plan.dir, { recursive: true, force: true }); this.plans.delete(id); } }, 60000).unref();
  constructor(private clusters: ClusterManager, private imports: Imports, private otherBusy: (id: string) => boolean, private journal?: string) {
    if (journal && existsSync(journal)) try { const records = JSON.parse(readFileSync(journal, 'utf8')); for (const op of records.slice(-30)) this.operations.set(op.id, { ...op, rows: [], status: op.status === 'running' ? 'interrupted' : op.status, message: op.status === 'running' ? 'Optic exited during this operation. Inspect cluster resources and Helm release status before retrying.' : op.message }); } catch { /* ignore malformed local history */ }
  }
  isBusy(id: string) { return this.busy.has(id); }
  private fingerprint(id: string) { const config = this.clusters.get(id).config; return createHash('sha256').update(config.exportConfig ? config.exportConfig() : JSON.stringify(config)).digest('hex'); }
  stop(id: string) { const op = this.operations.get(id); if (op?.status === 'running' && op.canStop) { this.stopRequests.add(id); op.message = 'Stopping after the current resource. Completed changes will be retained.'; } }
  status() { return [...this.operations.values()].map(op => structuredClone(op)); }
  dismiss(id: string) { if (this.operations.get(id)?.status !== 'running') this.operations.delete(id); this.persist(); }
  private persist() { if (this.journal) try { writeFileSync(this.journal, JSON.stringify([...this.operations.values()].slice(-30).map(({ rows, ...op }) => op)), { mode: 0o600 }); } catch { /* notifications still work in memory */ } }
  close() { this.stopped = true; clearInterval(this.timer); for (const child of this.children) child.kill(); for (const plan of this.plans.values()) rmSync(plan.dir, { recursive: true, force: true }); this.plans.clear(); }
  private command(executable: 'helm' | 'kubectl', args: string[], dir: string, input?: string) {
    if (this.stopped) return Promise.reject(new AppError('CLOSED', 'Optic is closing.'));
    const home = join(dir, 'helm-home'); mkdirSync(home, { recursive: true });
    return new Promise<string>((resolve, reject) => {
      const child = execFile(executable, args, { windowsHide: true, shell: false, timeout: 360000, maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, HELM_PLUGINS: join(home, 'no-plugins'), HELM_CONFIG_HOME: home, HELM_CACHE_HOME: join(home, 'cache'), HELM_DATA_HOME: join(home, 'data'), HELM_REGISTRY_CONFIG: join(home, 'registry.json') } }, (error, stdout) => {
        this.children.delete(child); if (error) reject(new AppError('DEPLOY_COMMAND_FAILED', `${executable} failed. Check installation, source dependencies, registry access, chart values and cluster permissions. Changes may be partial; inspect the release before retrying.`)); else resolve(stdout);
      });
      this.children.add(child); child.stdin?.end(input);
    });
  }
  async remote(input: RemoteChart, owner: number) {
    const dir = mkdtempSync(join(tmpdir(), 'optic-fetch-'));
    let agent: Agent | undefined;
    try {
      let caPath: string | undefined;
      if (input.caId) { const ca = this.imports.get(input.caId, owner); if (ca.source.kind !== 'certificate' || ca.source.files.length !== 1) invalid('Select one CA certificate.'); caPath = join(dir, 'ca.pem'); writeFileSync(caPath, readFileSync(join(ca.directory, ca.source.files[0])), { mode: 0o600 }); agent = new Agent({ connect: { ca: readFileSync(caPath, 'utf8') } }); }
      if (input.reference.startsWith('oci://')) {
        const url = new URL(input.reference); if (url.username || url.password || url.search || url.hash) invalid('Use an OCI chart reference without embedded credentials.');
        if (!input.version || input.version.startsWith('-')) invalid('Pin an explicit OCI chart version.');
        if (input.password) await this.command('helm', ['registry', 'login', url.host, '--username', input.username, '--password-stdin', ...(caPath ? ['--ca-file', caPath] : [])], dir, input.password);
        await this.command('helm', ['pull', input.reference, '--version', input.version, '--destination', dir, ...(caPath ? ['--ca-file', caPath] : [])], dir);
      } else {
        const url = new URL(input.reference); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) invalid('Use an HTTPS chart archive URL without embedded credentials.');
        const download = async (target: URL) => {
          if (target.protocol !== 'https:' || target.username || target.password) invalid('Repository artifacts must use HTTPS without embedded credentials.');
          const response = await secureFetch(target, { dispatcher: agent, redirect: 'error', signal: AbortSignal.timeout(60000), headers: input.password && target.origin === url.origin ? { Authorization: `Basic ${Buffer.from(`${input.username}:${input.password}`).toString('base64')}` } : {} });
          if (!response.ok || !response.body) { await response.body?.cancel(); invalid('Chart download failed. Check the URL and credentials.'); }
          const chunks: Uint8Array[] = []; let bytes = 0;
          for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 20 * 1024 * 1024) invalid('Download exceeds 20 MiB.'); chunks.push(chunk); }
          return Buffer.concat(chunks);
        };
        let artifact = url;
        if (input.chart) {
          const base = new URL(url.href.replace(/\/$/, '') + '/'); const index = parse((await download(new URL('index.yaml', base))).toString('utf8'), { maxAliasCount: 50 });
          const entry = index?.entries?.[input.chart]?.find((e: any) => e.version === input.version);
          if (!entry || typeof entry.urls?.[0] !== 'string') invalid('The repository does not contain the selected chart and pinned version.');
          artifact = new URL(entry.urls[0], base);
        }
        writeFileSync(join(dir, 'download.tgz'), await download(artifact), { mode: 0o600 });
      }
      const archive = readdirSync(dir).find(f => f.endsWith('.tgz')); if (!archive) invalid('Registry did not return a chart archive.');
      return await this.imports.add('archive', [join(dir, archive)], owner);
    } finally { await agent?.close(); rmSync(dir, { recursive: true, force: true }); }
  }
  private async manifests(input: DeployInput, owner: number, dir: string) {
    if (!input.sourceId) return parseBatch([{ name: 'Pasted YAML', text: input.yaml ?? '' }]);
    const source = this.imports.get(input.sourceId, owner);
    if (source.source.kind === 'kustomize') {
      const selected = input.files.find(f => source.source.files.includes(f) && /(?:^|\/)(kustomization\.ya?ml|Kustomization)$/.test(f));
      if (!selected) invalid('Select a Kustomize overlay.');
      // Every external resource reference and generator input is constrained to the staged tree.
      for (const file of source.source.files.filter(f => /(?:^|\/)(kustomization\.ya?ml|Kustomization)$/.test(f))) {
        const doc = parse(readFileSync(join(source.directory, file), 'utf8'), { maxAliasCount: 50 });
        if (doc?.helmCharts?.length || doc?.generators?.length || doc?.transformers?.length) invalid('Kustomize executable generators, custom transformers and Helm inflation are disabled.');
        if (/(?:https?:|git::|github\.com|gitlab\.com|ssh:|oci:)/i.test(stringify(doc))) invalid('Remote Kustomize references require a separate fetch and review workflow. Use local bases.');
        for (const reference of [...(doc?.resources ?? []), ...(doc?.bases ?? []), ...(doc?.components ?? [])]) {
          if (typeof reference !== 'string') invalid('Kustomize resources must refer to local paths.');
          const path = resolve(dirname(join(source.directory, file)), reference); const within = relative(source.directory, path);
          if (isAbsolute(reference) || within.startsWith('..') || isAbsolute(within) || !existsSync(path)) invalid('Kustomize bases and resources must exist inside the selected directory. Select a parent directory containing all local bases.');
        }
      }
      return parseBatch([{ name: selected, text: await this.command('kubectl', ['kustomize', dirname(join(source.directory, selected))], dir) }]);
    }
    if (!['folder', 'manifests'].includes(source.source.kind)) invalid('Choose a manifest source.');
    if (!input.files.length || input.files.some(f => !source.source.files.includes(f))) invalid('Select files from this import.');
    return parseBatch(input.files.map(name => ({ name, text: readFileSync(join(source.directory, name), 'utf8') })));
  }
  async dependencies(id: string, owner: number) {
    const source = this.imports.get(id, owner);
    if (source.source.kind !== 'chart') invalid('Dependency builds require a chart directory.');
    const dir = mkdtempSync(join(tmpdir(), 'optic-dependencies-'));
    try {
      const chartDir = join(dir, 'chart'); mkdirSync(chartDir);
      for (const file of source.source.files) { const path = join(chartDir, file); const { dirname } = await import('node:path'); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, readFileSync(join(source.directory, file)), { mode: 0o600 }); }
      for (const filename of ['Chart.yaml', 'Chart.lock']) {
        if (!existsSync(join(chartDir, filename))) continue;
        const document = parse(readFileSync(join(chartDir, filename), 'utf8'), { maxAliasCount: 50 });
        for (const dependency of document?.dependencies ?? []) {
          const repository = dependency.repository;
          if (typeof repository !== 'string' || !/^https:\/\//.test(repository)) invalid('Automatic dependency build supports public HTTPS repositories only. Vendor private or local dependencies before import.');
          const url = new URL(repository); if (url.username || url.password || url.search || url.hash) invalid('Dependency repository URLs cannot contain credentials.');
        }
      }
      await this.command('helm', ['dependency', 'build', chartDir], dir);
      const result = await this.imports.add('chart', [chartDir], owner);
      const stored = this.imports.get(result.id, owner);
      try { for (const file of result.files.filter(f => f.endsWith('.tgz'))) await inspectArchive(join(stored.directory, file)); }
      catch (error) { this.imports.dispose(result.id, owner); throw error; }
      return result;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  async prepare(input: DeployInput, owner: number): Promise<DeployPreview> {
    if (this.plans.size >= 30) invalid('Too many pending previews. Close unused import dialogs.');
    this.clusters.get(input.clusterId);
    const dir = mkdtempSync(join(tmpdir(), 'optic-plan-')); const id = randomUUID();
    const plan: Plan = { owner, fingerprint: this.fingerprint(input.clusterId), input: structuredClone(input), dir, entries: [], valuesPaths: [], preview: { id, expires: Date.now() + 600000, rows: [], manifest: '', chart: false, warnings: [] } };
    try {
      const source = input.sourceId ? this.imports.get(input.sourceId, owner) : undefined;
      if (source && ['chart', 'archive'].includes(source.source.kind)) {
        if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(input.release) || input.release.length > 53) invalid('Enter a valid Helm release name (up to 53 characters).');
        // Copy only already bounded, inspected source files into an immutable per-plan snapshot.
        const chartDir = join(dir, 'chart'); mkdirSync(chartDir);
        for (const file of source.source.files) { const path = join(chartDir, file); const { dirname } = await import('node:path'); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, readFileSync(join(source.directory, file)), { mode: 0o600 }); }
        plan.chartPath = source.source.kind === 'archive' ? join(chartDir, 'chart.tgz') : chartDir;
        for (const file of source.source.files.filter(f => f.endsWith('.tgz'))) await inspectArchive(join(chartDir, file));
        for (const valuesId of input.valuesIds) {
          const values = this.imports.get(valuesId, owner); if (values.source.kind !== 'values') invalid('Invalid values source.');
          for (const file of values.source.files) this.values(plan, readFileSync(join(values.directory, file), 'utf8'));
        }
        this.values(plan, input.values);
        const config = this.clusters.cliConfig(input.clusterId); let rendered: string;
        try { rendered = await this.command('helm', ['template', input.release, plan.chartPath, '--namespace', input.namespace, '--include-crds', ...(input.action === 'upgrade' ? ['--is-upgrade'] : []), ...plan.valuesPaths.flatMap(p => ['--values', p]), '--kubeconfig', config.path], dir); } finally { config.cleanup(); }
        const entries = parseBatch([{ name: source.source.label, text: rendered }]);
        plan.preview.chart = true; plan.preview.rows = entries.map(({ source, body }) => ({ source, kind: body.kind, name: body.metadata.name, namespace: body.metadata.namespace, intent: 'unknown', state: 'rendered' }));
        plan.preview.manifest = entries.map(e => stringify(redacted(e.body))).join('---\n');
        plan.preview.warnings = ['Helm template rendering is not server validation. Hooks and CRDs may change cluster state. Helm waits up to five minutes for readiness.', 'Dependencies must be vendored into the chart before import. Original chart files are never modified.'];
      } else {
        const entries = await this.manifests(input, owner, dir); const config = this.clusters.get(input.clusterId).config;
        const namespaces = new Set(entries.filter(e => stage(e.body) === 0).map(e => e.body.metadata.name));
        const definitions = entries.filter(e => stage(e.body) === 1).map(e => e.body);
        const seen = new Set<string>(); const discovery = new Map<string, any>();
        for (const entry of entries) {
          const b = entry.body; const root = b.apiVersion === 'v1' ? '/api/v1' : `/apis/${b.apiVersion}`;
          let descriptor: any;
          try { if (!discovery.has(root)) discovery.set(root, await kubeJson(config, root)); descriptor = discovery.get(root).resources.find((r: any) => r.kind === b.kind && !r.name.includes('/') && r.verbs.includes('patch')); } catch (error) { if ((error as any).statusCode !== 404) throw error; }
          const crd = definitions.find(d => `${d.spec?.group}/${d.spec?.versions?.find((v: any) => v.name === b.apiVersion.split('/')[1] && v.served)?.name}` === b.apiVersion && d.spec?.names?.kind === b.kind);
          if (!descriptor && crd) descriptor = { name: crd.spec.names.plural, namespaced: crd.spec.scope === 'Namespaced' };
          if (!descriptor) invalid(`${entry.source}: ${b.kind} is not a discoverable, patchable API resource.`);
          if (descriptor.namespaced) b.metadata.namespace ??= input.namespace; else delete b.metadata.namespace;
          const path = `${root}${descriptor.namespaced ? `/namespaces/${encodeURIComponent(b.metadata.namespace)}` : ''}/${encodeURIComponent(descriptor.name)}/${encodeURIComponent(b.metadata.name)}`;
          const identity = `${b.apiVersion.split('/').length === 1 ? '' : b.apiVersion.split('/')[0]}|${b.kind}|${b.metadata.namespace ?? ''}|${b.metadata.name}`;
          if (seen.has(identity)) invalid(`Duplicate resource: ${b.kind}/${b.metadata.name}.`); seen.add(identity);
          let intent: DeployRow['intent'] = 'unknown';
          try { await kubeJson(config, path); intent = 'update'; } catch (error) { if ((error as any).statusCode === 404) intent = 'create'; }
          let deferred = false;
          try { await this.patch(input.clusterId, path, b, true); } catch (error) {
            if ((error as any).statusCode === 404 && (crd || namespaces.has(b.metadata.namespace))) deferred = true; else throw error;
          }
          plan.entries.push({ body: b, path, deferred, row: { source: entry.source, kind: b.kind, name: b.metadata.name, namespace: b.metadata.namespace, intent, state: deferred ? 'deferred' : 'validated' } });
        }
        plan.preview.rows = plan.entries.map(e => e.row); plan.preview.manifest = plan.entries.map(e => stringify(redacted(e.body))).join('---\n');
        plan.preview.warnings = ['Apply stops on the first error. Successful resources are retained; this batch is not transactional.'];
        if (plan.entries.some(e => e.deferred)) plan.preview.warnings.push('Some resources need a new Namespace or CRD. They will be validated after prerequisites become ready and before they are applied.');
      }
      this.plans.set(id, plan); return structuredClone(plan.preview);
    } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
  }
  private values(plan: Plan, text: string) {
    let value; try { value = parse(text || '{}', { maxAliasCount: 50 }); } catch { invalid('Values must contain valid YAML.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Each values file must contain a YAML mapping.');
    const path = join(plan.dir, `values-${plan.valuesPaths.length}.yaml`); writeFileSync(path, text || '{}', { mode: 0o600 }); plan.valuesPaths.push(path);
  }
  discard(id: string, owner: number) { const plan = this.plans.get(id); if (plan?.owner === owner) { this.plans.delete(id); rmSync(plan.dir, { recursive: true, force: true }); } }
  start(id: string, owner: number) {
    const plan = this.plans.get(id); if (!plan || plan.owner !== owner || plan.preview.expires < Date.now()) invalid('Preview expired. Review the deployment again.');
    if (this.fingerprint(plan.input.clusterId) !== plan.fingerprint) invalid('Cluster configuration changed. Review the deployment again.');
    if (this.busy.has(plan.input.clusterId) || this.otherBusy(plan.input.clusterId)) invalid('Another cluster operation is running. Wait for it to finish.');
    this.plans.delete(id); this.busy.add(plan.input.clusterId);
    const operation: DeployOperation = { id, clusterId: plan.input.clusterId, title: plan.preview.chart ? `${plan.input.action} ${plan.input.release}` : `Apply ${plan.entries.length} resources`, started: Date.now(), status: 'running', rows: plan.preview.rows.map(r => ({ ...r, state: 'pending' })), message: 'Applying in the background. Keep Optic open.' };
    operation.canStop = !plan.preview.chart;
    this.operations.set(id, operation); this.persist(); void this.run(plan, operation); return structuredClone(operation);
  }
  private patch(clusterId: string, path: string, body: any, dryRun: boolean) { return kubeJson(this.clusters.get(clusterId).config, `${path}?fieldManager=optic-import${dryRun ? '&dryRun=All' : ''}`, { method: 'PATCH', contentType: 'application/apply-patch+yaml', body }); }
  private async ready(plan: Plan, entry: Entry) {
    for (let i = 0; i < 60; i++) {
      if (this.stopped) invalid('Optic is closing; reconcile cluster state before retrying.');
      const live = await kubeJson(this.clusters.get(plan.input.clusterId).config, entry.path);
      if (stage(entry.body) === 0 ? live.status?.phase === 'Active' : live.status?.conditions?.some((c: any) => c.type === 'Established' && c.status === 'True')) return;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    invalid('Prerequisite did not become ready within one minute. Inspect the Namespace or CRD.');
  }
  private async run(plan: Plan, op: DeployOperation) {
    try {
      if (plan.chartPath) {
        const config = this.clusters.cliConfig(plan.input.clusterId);
        try { await this.command('helm', [plan.input.action, plan.input.release, plan.chartPath, '--namespace', plan.input.namespace, ...plan.valuesPaths.flatMap(p => ['--values', p]), '--kubeconfig', config.path, '--wait', '--timeout', '5m', ...(plan.input.action === 'install' ? ['--create-namespace'] : ['--reset-values'])], plan.dir); } finally { config.cleanup(); }
        op.rows.forEach(r => { r.state = 'succeeded'; });
      } else for (let i = 0; i < plan.entries.length; i++) {
        if (this.stopped) invalid('Optic is closing; reconcile cluster state before retrying.');
        if (this.stopRequests.has(op.id)) invalid('Stopped at your request. Completed resources are retained; remaining resources were skipped.');
        if (this.fingerprint(plan.input.clusterId) !== plan.fingerprint) invalid('Cluster configuration changed during deployment. Remaining resources were skipped.');
        const entry = plan.entries[i]; const row = op.rows[i]; row.state = 'running';
        try {
          // Revalidate immediately before mutation, including all deferred resources.
          await this.patch(plan.input.clusterId, entry.path, entry.body, true);
          await this.patch(plan.input.clusterId, entry.path, entry.body, false); row.state = 'succeeded';
          if (stage(entry.body) < 2) await this.ready(plan, entry);
        } catch (error) { row.state = 'failed'; row.message = fault(error).message; throw error; }
      }
      op.status = 'succeeded'; op.message = 'Deployment completed.';
    } catch (error) { op.status = 'failed'; op.message = fault(error).message; op.rows.forEach(r => { if (r.state === 'pending') { r.state = plan.chartPath ? 'failed' : 'skipped'; if (plan.chartPath) r.message = 'Helm did not complete. This resource may have changed; inspect the release and cluster before retrying.'; } }); }
    finally { this.stopRequests.delete(op.id); this.busy.delete(plan.input.clusterId); rmSync(plan.dir, { recursive: true, force: true }); this.persist(); }
  }
}
