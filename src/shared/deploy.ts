export type ImportKind = 'manifests' | 'folder' | 'kustomize' | 'chart' | 'archive' | 'values' | 'certificate';
export interface ImportSource { id: string; kind: ImportKind; label: string; files: string[]; chart?: { name: string; version: string; dependencies: string[] } }
export interface DeployInput {
  clusterId: string; namespace: string; sourceId?: string; files: string[]; yaml?: string;
  release: string; action: 'install' | 'upgrade'; valuesIds: string[]; values: string;
}
export interface DeployRow { source: string; kind: string; name: string; namespace?: string; intent: 'create' | 'update' | 'unknown'; state: 'validated' | 'deferred' | 'rendered' | 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'; message?: string }
export interface DeployPreview { id: string; expires: number; rows: DeployRow[]; manifest: string; chart: boolean; warnings: string[] }
export interface DeployOperation { id: string; clusterId: string; title: string; status: 'running' | 'succeeded' | 'failed' | 'interrupted'; rows: DeployRow[]; message: string; started: number; canStop?: boolean }
export interface RemoteChart { reference: string; version: string; username: string; password: string; chart?: string; caId?: string }
