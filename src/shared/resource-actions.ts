import type { Resource, Target } from './protocol';

export interface ActionTarget extends Target { uid: string; resourceVersion: string }
export interface DrainOptions { ignoreDaemonSets: boolean; deleteEmptyDirData: boolean; force: boolean; timeoutSeconds: number }
export interface DrainPod { name: string; namespace: string; uid: string; daemonSet: boolean; mirror: boolean; unmanaged: boolean; emptyDir: boolean }
export interface DrainPreview { node: Resource; pods: DrainPod[] }
export interface DeploymentRevision { revision: number; name: string; uid: string; images: string[]; current: boolean }
