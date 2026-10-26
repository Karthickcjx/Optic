import type { OverviewHistory } from './metrics';
import type { ResourceMetricRequest, ResourceMetricResult } from './resource-metrics';
import type { ActionTarget, DeploymentRevision, DrainOptions, DrainPreview } from './resource-actions';
import type { ResourceEdit } from './resource-editors';
import type { HelmRepository, HelmChart, HelmRelease, HelmTarget, HelmInstall, HelmDetails, HelmPreview } from './helm';
import type { ClusterSettings, CostResult, MonitoringChange, MonitoringComponent } from './cluster-settings';
import { resourceKinds, type CustomType } from './catalog';
export { resourceKinds } from './catalog';
export type ResourceKind = typeof resourceKinds[number];
export interface Resource {
  apiVersion?: string; kind?: string;
  metadata: { name?: string; namespace?: string; uid?: string; resourceVersion?: string; creationTimestamp?: string; labels?: Record<string, string>; annotations?: Record<string, string>; [key: string]: unknown };
  spec?: Record<string, any>; status?: Record<string, any>; [key: string]: any;
}
export interface Cluster { id: string; name: string; server: string; source: string; namespace: string; connected?: boolean }
export interface Scope { clusterId: string; kind: ResourceKind; namespace?: string; custom?: CustomType }
export interface Target extends Scope { name: string }
export interface PodTarget { clusterId: string; namespace: string; pod: string; container?: string }
export interface TerminalOptions { node?: string; clusterId?: string; pod?: string; namespace?: string; container?: string; shell?: string; cols: number; rows: number }
export interface Fault { code: string; message: string; retryable: boolean }
export type Result<T> = { ok: true; data: T } | { ok: false; error: Fault };
export type StreamEvent =
  | { id: string; type: 'resources'; items: Resource[] }
  | { id: string; type: 'data'; data: string; seq: number }
  | { id: string; type: 'error'; error: Fault }
  | { id: string; type: 'end'; exitCode?: number; reason?: 'closed' };
export interface Requests {
  'nodes:drain-preview': { input: Target; output: DrainPreview };
  'nodes:drain': { input: ActionTarget & { options: DrainOptions }; output: string };
  'deployments:revisions': { input: Target; output: DeploymentRevision[] };
  'deployments:rollback': { input: ActionTarget & { revision: number; replicaSetUid: string }; output: string };
  'cronjobs:trigger': { input: ActionTarget & { jobName: string }; output: string };
  'cronjobs:suspend': { input: ActionTarget & { suspend: boolean }; output: string };
  'resources:edit': { input: ActionTarget & { changes: ResourceEdit; dryRun: boolean }; output: string };
  'helm:repositories': { input: undefined; output: HelmRepository[] };
  'helm:repository-save': { input: { repository: HelmRepository; remove: boolean }; output: HelmRepository[] };
  'helm:charts': { input: { repository: string; refresh?: boolean }; output: HelmChart[] };
  'helm:versions': { input: { repository: string; chart: string }; output: { version: string; appVersion: string }[] };
  'helm:chart-info': { input: { repository: string; chart: string; version: string }; output: { values: string; readme: string } };
  'helm:releases': { input: { clusterId: string; namespace?: string }; output: HelmRelease[] };
  'helm:details': { input: HelmTarget; output: HelmDetails };
  'helm:preview': { input: HelmInstall; output: HelmPreview };
  'helm:apply': { input: { plan: HelmInstall; token: string }; output: void };
  'helm:rollback': { input: HelmTarget & { revision: number }; output: void };
  'helm:uninstall': { input: HelmTarget; output: void };

  'settings:get': { input: { clusterId: string }; output: ClusterSettings };
  'settings:save': { input: { clusterId: string; settings: ClusterSettings }; output: ClusterSettings };
  'settings:directory': { input: undefined; output: string | undefined };
  'settings:reveal': { input: { clusterId: string }; output: void };
  'clusters:connect': { input: { clusterId: string }; output: { version: string; latencyMs: number } };
  'clusters:disconnect': { input: { clusterId: string }; output: void };
  'cost:read': { input: { clusterId: string }; output: CostResult };
  'monitoring:version': { input: { component: MonitoringComponent }; output: { version: string } };
  'monitoring:status': { input: { clusterId: string }; output: { name: string; status: string; chart: string }[] };
  'monitoring:apply': { input: { clusterId: string; changes: MonitoringChange[] }; output: { completed: string[]; error?: string } };
  'nodeshell:open': { input: { clusterId: string; node: string; id: string; cols: number; rows: number }; output: void };
  'clusters:remove': { input: { clusterId: string }; output: { clusters: Cluster[]; warnings: string[]; backup: string } };
  'forward:start': { input: { id: string; clusterId: string; namespace: string; kind: 'pods' | 'services'; name: string; localPort: number; remotePort: number }; output: { localPort: number } };
  'clusters:import-clipboard': { input: { yaml: string }; output: { clusters: Cluster[]; warnings: string[] } };
  'clusters:import': { input: undefined; output: { clusters: Cluster[]; warnings: string[] } };
  'metrics:resource': { input: ResourceMetricRequest; output: ResourceMetricResult };
  'metrics:history': { input: { clusterId: string; minutes: number }; output: OverviewHistory };
  'metrics:read': { input: { clusterId: string }; output: { nodes: Resource[]; pods: Resource[]; warning?: string; source?: string } };
  'resources:apply': { input: { clusterId: string; namespace?: string; yaml: string; dryRun: boolean }; output: { name: string; kind: string; namespace?: string } };
  'resources:scale': { input: Target & { replicas: number }; output: void };
  'nodes:cordon': { input: { clusterId: string; name: string; unschedulable: boolean }; output: void };
  'clusters:list': { input: undefined; output: { clusters: Cluster[]; warnings: string[] } };
  'clusters:health': { input: { clusterId: string }; output: { version: string; latencyMs: number } };
  'resources:get': { input: Target; output: Resource };
  'resources:list': { input: Scope; output: Resource[] };
  'resources:watch': { input: Scope & { id: string }; output: void };
  'resources:yaml': { input: Target; output: string };
  'resources:replace': { input: Target & { yaml: string }; output: void };
  'resources:delete': { input: Target; output: void };
  'resources:restart': { input: Target; output: void };
  'logs:start': { input: PodTarget & { id: string; tailLines?: number; previous?: boolean; sinceTime?: string }; output: void };
  'logs:export': { input: { text: string }; output: { saved: boolean } };
  'terminal:open': { input: TerminalOptions & { id: string }; output: void };
  'terminal:write': { input: { id: string; data: string }; output: void };
  'terminal:resize': { input: { id: string; cols: number; rows: number }; output: void };
  'stream:ack': { input: { id: string; seq: number }; output: void };
  'stream:close': { input: { id: string }; output: void };
}
export const channels: (keyof Requests)[] = ['metrics:history', 'nodes:drain-preview', 'nodes:drain', 'deployments:revisions', 'deployments:rollback', 'cronjobs:trigger', 'cronjobs:suspend', 'resources:edit', 'metrics:resource', 'resources:get', 'helm:repositories', 'helm:repository-save', 'helm:charts', 'helm:versions', 'helm:chart-info', 'helm:releases', 'helm:details', 'helm:preview', 'helm:apply', 'helm:rollback', 'helm:uninstall', 'settings:get', 'settings:save', 'settings:directory', 'settings:reveal', 'clusters:connect', 'clusters:disconnect', 'cost:read', 'monitoring:version', 'monitoring:status', 'monitoring:apply', 'nodeshell:open', 'clusters:remove', 'forward:start', 'clusters:import', 'clusters:import-clipboard', 'metrics:read', 'resources:apply', 'resources:scale', 'nodes:cordon', 'clusters:list', 'clusters:health', 'resources:list', 'resources:watch', 'resources:yaml', 'resources:replace', 'resources:delete', 'resources:restart', 'logs:start', 'logs:export', 'terminal:open', 'terminal:write', 'terminal:resize', 'stream:ack', 'stream:close'];
export interface DesktopAPI {
  request<K extends keyof Requests>(channel: K, input: Requests[K]['input']): Promise<Result<Requests[K]['output']>>;
  subscribe(listener: (event: StreamEvent) => void): () => void;
}
