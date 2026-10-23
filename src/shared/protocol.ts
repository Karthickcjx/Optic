import { resourceKinds, type CustomType } from './catalog';
export { resourceKinds } from './catalog';
export type ResourceKind = typeof resourceKinds[number];
export interface Resource {
  apiVersion?: string; kind?: string;
  metadata: { name?: string; namespace?: string; uid?: string; resourceVersion?: string; creationTimestamp?: string; labels?: Record<string, string>; [key: string]: unknown };
  spec?: Record<string, any>; status?: Record<string, any>; [key: string]: any;
}
export interface Cluster { id: string; name: string; server: string; source: string; namespace: string }
export interface Scope { clusterId: string; kind: ResourceKind; namespace?: string; custom?: CustomType }
export interface Target extends Scope { name: string }
export interface PodTarget { clusterId: string; namespace: string; pod: string; container?: string }
export interface TerminalOptions { clusterId?: string; pod?: string; namespace?: string; container?: string; cols: number; rows: number }
export interface Fault { code: string; message: string; retryable: boolean }
export type Result<T> = { ok: true; data: T } | { ok: false; error: Fault };
export type StreamEvent =
  | { id: string; type: 'resources'; items: Resource[] }
  | { id: string; type: 'data'; data: string; seq: number }
  | { id: string; type: 'error'; error: Fault }
  | { id: string; type: 'end'; exitCode?: number };
export interface Requests {
  'clusters:remove': { input: { clusterId: string }; output: { clusters: Cluster[]; warnings: string[]; backup: string } };
  'forward:start': { input: { id: string; clusterId: string; namespace: string; kind: 'pods' | 'services'; name: string; localPort: number; remotePort: number }; output: { localPort: number } };
  'clusters:import': { input: undefined; output: { clusters: Cluster[]; warnings: string[] } };
  'metrics:read': { input: { clusterId: string }; output: { nodes: Resource[]; pods: Resource[]; warning?: string } };
  'resources:apply': { input: { clusterId: string; namespace?: string; yaml: string; dryRun: boolean }; output: { name: string; kind: string; namespace?: string } };
  'resources:scale': { input: Target & { replicas: number }; output: void };
  'nodes:cordon': { input: { clusterId: string; name: string; unschedulable: boolean }; output: void };
  'clusters:list': { input: undefined; output: { clusters: Cluster[]; warnings: string[] } };
  'clusters:health': { input: { clusterId: string }; output: { version: string; latencyMs: number } };
  'resources:list': { input: Scope; output: Resource[] };
  'resources:watch': { input: Scope & { id: string }; output: void };
  'resources:yaml': { input: Target; output: string };
  'resources:replace': { input: Target & { yaml: string }; output: void };
  'resources:delete': { input: Target; output: void };
  'resources:restart': { input: Target; output: void };
  'logs:start': { input: PodTarget & { id: string; tailLines?: number; previous?: boolean }; output: void };
  'terminal:open': { input: TerminalOptions & { id: string }; output: void };
  'terminal:write': { input: { id: string; data: string }; output: void };
  'terminal:resize': { input: { id: string; cols: number; rows: number }; output: void };
  'stream:ack': { input: { id: string; seq: number }; output: void };
  'stream:close': { input: { id: string }; output: void };
}
export const channels: (keyof Requests)[] = ['clusters:remove', 'forward:start', 'clusters:import', 'metrics:read', 'resources:apply', 'resources:scale', 'nodes:cordon', 'clusters:list', 'clusters:health', 'resources:list', 'resources:watch', 'resources:yaml', 'resources:replace', 'resources:delete', 'resources:restart', 'logs:start', 'terminal:open', 'terminal:write', 'terminal:resize', 'stream:ack', 'stream:close'];
export interface DesktopAPI {
  request<K extends keyof Requests>(channel: K, input: Requests[K]['input']): Promise<Result<Requests[K]['output']>>;
  subscribe(listener: (event: StreamEvent) => void): () => void;
}
