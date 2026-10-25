import { execFile, type ChildProcess } from 'node:child_process';
import type { ClusterManager } from './clusters';
import { ResourceService, resourcePath } from './resources';
import { kubeJson } from './kube-http';
import { AppError } from './errors';
import type { Resource, Target } from '../shared/protocol';
import type { ActionTarget, DeploymentRevision, DrainOptions, DrainPod, DrainPreview } from '../shared/resource-actions';
import { editedFields, type ResourceEdit } from '../shared/resource-editors';
import { deploymentRevisions } from '../shared/relationships';

export function drainArgs(path: string, context: string, name: string, options: DrainOptions) {
  return ['--kubeconfig', path, '--context', context, 'drain', name, `--timeout=${options.timeoutSeconds}s`, '--grace-period=-1',
    ...(options.ignoreDaemonSets ? ['--ignore-daemonsets'] : []), ...(options.deleteEmptyDirData ? ['--delete-emptydir-data'] : []), ...(options.force ? ['--force'] : [])];
}
export function drainFailure(error: { code?: string | number | null; killed?: boolean }, stderr: string) {
  const partial = 'The node may remain cordoned and some Pods may already be evicted. Check the node before retrying.';
  if (error.code === 'ENOENT') return 'kubectl is not installed or is missing from PATH. Install it and restart Optic.';
  if (/disruption budget|cannot evict|429|too many requests/i.test(stderr)) return `Drain was blocked by a PodDisruptionBudget or eviction limit. ${partial}`;
  if (error.killed || /timed out|deadline exceeded/i.test(stderr)) return `Drain timed out waiting for Pods to leave. ${partial}`;
  if (/daemonset/i.test(stderr)) return `Drain found DaemonSet Pods. Review the option to leave them running. ${partial}`;
  if (/local storage|emptydir/i.test(stderr)) return `Drain found Pods with emptyDir data. Review the local-data option. ${partial}`;
  if (/cannot delete|not managed|unmanaged/i.test(stderr)) return `Drain found unmanaged Pods. Review the unmanaged-Pod option. ${partial}`;
  if (/forbidden|unauthorized/i.test(stderr)) return `Drain was denied by cluster permissions. ${partial}`;
  return `Drain failed. Check kubectl, cluster connectivity and Pod events. ${partial}`;
}
export class ResourceActions {
  private busy = new Set<string>();
  private children = new Set<ChildProcess>();
  private disposed = false;
  constructor(private clusters: ClusterManager, private resources: ResourceService) {}
  dispose() { this.disposed = true; for (const child of this.children) child.kill(); }
  isBusy(clusterId: string) { return [...this.busy].some(key => key.startsWith(`${clusterId}/`)); }
  private config(clusterId: string) { return this.clusters.get(clusterId).config; }
  private path(target: Target) { return `${resourcePath(target)}/${encodeURIComponent(target.name)}`; }
  private async mutate<T>(target: Target, run: () => Promise<T>) {
    const key = `${target.clusterId}/${target.kind}/${target.namespace ?? ''}/${target.name}`;
    if (this.disposed) throw new AppError('CLOSED', 'Optic is closing. Reopen it before retrying.');
    if (this.busy.has(key)) throw new AppError('RESOURCE_BUSY', 'An action is already running for this resource.');
    this.busy.add(key); try { return await run(); } finally { this.busy.delete(key); }
  }
  private async current(target: ActionTarget, kind?: string) {
    if (kind && target.kind !== kind) throw new AppError('INVALID_RESOURCE', 'This action does not match the resource type.');
    const resource = await this.resources.get(target);
    if (resource.metadata.uid !== target.uid || resource.metadata.resourceVersion !== target.resourceVersion) throw new AppError('CONFLICT', 'This resource changed since review. Reopen the action and review the current version.');
    return resource;
  }
  private async patch(target: ActionTarget, operations: object[], dryRun = false) {
    try { return await kubeJson(this.config(target.clusterId), this.path(target) + (dryRun ? '?dryRun=All' : ''), { method: 'PATCH', contentType: 'application/json-patch+json', body: [
      { op: 'test', path: '/metadata/uid', value: target.uid }, { op: 'test', path: '/metadata/resourceVersion', value: target.resourceVersion }, ...operations
    ] }); } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 422) await this.current(target);
      throw error;
    }
  }
  async drainPreview(target: Target): Promise<DrainPreview> {
    if (target.kind !== 'nodes') throw new AppError('INVALID_RESOURCE', 'Select a Node to drain.');
    const [node, pods] = await Promise.all([this.resources.get(target), this.resources.list({ clusterId: target.clusterId, kind: 'pods' })]);
    return { node, pods: pods.filter(p => p.spec?.nodeName === target.name).map(p => ({ name: p.metadata.name!, namespace: p.metadata.namespace!, uid: p.metadata.uid!,
      daemonSet: !!(p.metadata.ownerReferences as any[] | undefined)?.some(o => o.kind === 'DaemonSet' && o.controller === true), mirror: !!p.metadata.annotations?.['kubernetes.io/config.mirror'],
      unmanaged: !(p.metadata.ownerReferences as any[] | undefined)?.some(o => o.controller === true), emptyDir: !!p.spec?.volumes?.some((v: any) => v.emptyDir !== undefined)
    } satisfies DrainPod)) };
  }
  async drain(target: ActionTarget, options: DrainOptions) {
    return this.mutate(target, async () => {
      // Node status changes frequently; require stable identity, then let kubectl
      // re-evaluate every current Pod and enforce PDBs at eviction time.
      if (target.kind !== 'nodes' || (await this.resources.get(target)).metadata.uid !== target.uid) throw new AppError('CONFLICT', 'The Node identity changed. Review the drain again.');
      const api = await kubeJson(this.config(target.clusterId), '/api/v1');
      if (!api.resources?.some((r: any) => r.name === 'pods/eviction' && r.verbs?.includes('create'))) throw new AppError('EVICTION_UNAVAILABLE', 'This cluster does not expose Pod eviction. Drain will not bypass disruption budgets using direct deletion.');
      const lease = this.clusters.cliConfig(target.clusterId);
      try {
        await new Promise<void>((resolve, reject) => {
          const child = execFile('kubectl', drainArgs(lease.path, this.clusters.get(target.clusterId).cluster.name, target.name, options), { shell: false, windowsHide: true, timeout: (options.timeoutSeconds + 20) * 1000, maxBuffer: 2_000_000 }, (error, _out, stderr) => {
            this.children.delete(child);
            if (error) reject(new AppError('DRAIN_FAILED', drainFailure(error, stderr))); else resolve();
          }); this.children.add(child);
        });
      } finally { lease.cleanup(); }
      return 'Drain completed. The node remains cordoned; DaemonSet and mirror Pods are left running. Uncordon it when maintenance is finished.';
    });
  }
  async revisions(target: Target): Promise<DeploymentRevision[]> {
    if (target.kind !== 'deployments' || !target.namespace) throw new AppError('INVALID_RESOURCE', 'Select a namespaced Deployment.');
    const deployment = await this.resources.get(target);
    const sets = await this.resources.list({ ...target, kind: 'replicasets' });
    return deploymentRevisions(deployment, sets).flatMap(rs => {
      const revision = Number(rs.metadata.annotations?.['deployment.kubernetes.io/revision']);
      return Number.isSafeInteger(revision) && revision > 0 ? [{ revision, name: rs.metadata.name!, uid: rs.metadata.uid!, images: rs.spec?.template?.spec?.containers?.map((c: any) => c.image) ?? [], current: String(revision) === deployment.metadata.annotations?.['deployment.kubernetes.io/revision'] }] : [];
    });
  }
  async rollback(target: ActionTarget, revision: number, replicaSetUid: string) {
    return this.mutate(target, async () => {
      const deployment = await this.current(target, 'deployments');
      if (deployment.spec?.paused) throw new AppError('PAUSED', 'Resume this Deployment before rolling it back.');
      const sets = deploymentRevisions(deployment, await this.resources.list({ ...target, kind: 'replicasets' }));
      const selected = sets.find(rs => rs.metadata.uid === replicaSetUid && Number(rs.metadata.annotations?.['deployment.kubernetes.io/revision']) === revision);
      if (!selected?.spec?.template || String(revision) === deployment.metadata.annotations?.['deployment.kubernetes.io/revision']) throw new AppError('REVISION_UNAVAILABLE', 'This revision is no longer available for rollback. Reload the retained revisions.');
      const template = structuredClone(selected.spec.template);
      if (template.metadata?.labels) delete template.metadata.labels['pod-template-hash'];
      await this.patch(target, [{ op: 'add', path: '/spec/template', value: template }]);
      return `Rollback to revision ${revision} submitted. Watch Deployment conditions and Pods for rollout completion.`;
    });
  }
  async suspend(target: ActionTarget, suspend: boolean) {
    return this.mutate(target, async () => {
      await this.current(target, 'cronjobs');
      await this.patch(target, [{ op: 'add', path: '/spec/suspend', value: suspend }]);
      return suspend ? 'CronJob suspended. Already running Jobs are unchanged.' : 'CronJob resumed. Missed schedules may run according to its deadline policy.';
    });
  }
  async trigger(target: ActionTarget, jobName: string) {
    return this.mutate(target, async () => {
      const cronjob = await this.current(target, 'cronjobs');
      if (!target.namespace || !cronjob.spec?.jobTemplate?.spec) throw new AppError('INVALID_RESOURCE', 'The CronJob has no usable Job template.');
      const template = cronjob.spec.jobTemplate;
      const job = { apiVersion: 'batch/v1', kind: 'Job', metadata: { name: jobName, namespace: target.namespace, labels: { ...template.metadata?.labels }, annotations: { ...template.metadata?.annotations, 'cronjob.kubernetes.io/instantiate': 'manual' }, ownerReferences: [{ apiVersion: 'batch/v1', kind: 'CronJob', name: target.name, uid: target.uid, controller: true, blockOwnerDeletion: true }] }, spec: structuredClone(template.spec) };
      try { await kubeJson(this.config(target.clusterId), `/apis/batch/v1/namespaces/${encodeURIComponent(target.namespace)}/jobs`, { method: 'POST', body: job }); }
      catch (error) { if ((error as { statusCode?: number }).statusCode === 409) throw new AppError('JOB_EXISTS', 'A Job with this name already exists. Choose a different name before running again.'); throw error; }
      return `Job ${jobName} created. Open Jobs to follow execution; creating a Job does not mean it has finished.`;
    });
  }
  async edit(target: ActionTarget, changes: ResourceEdit, dryRun: boolean) {
    return this.mutate(target, async () => {
      const resource = await this.current(target);
      let field;
      try { field = editedFields(resource, changes); } catch { throw new AppError('INVALID_RESOURCE', 'The editor fields do not match this resource. Reopen the editor and check required fields.'); }
      await this.patch(target, [{ op: 'add', path: field.path, value: field.value }], dryRun);
      return dryRun ? 'Changes passed API-server dry-run validation.' : 'Changes saved. Watch resource conditions for rollout or reconciliation progress.';
    });
  }
}
