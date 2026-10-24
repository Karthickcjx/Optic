export interface HelmRepository { name: string; url: string }
export interface HelmChart { name: string; description: string; version: string; appVersion: string; repository: string; deprecated: boolean }
export interface HelmRelease { name: string; namespace: string; revision: string; updated: string; status: string; chart: string; app_version: string }
export interface HelmRevision { revision: number; updated: string; status: string; chart: string; app_version: string; description: string }
export interface HelmTarget { clusterId: string; namespace: string; release: string }
export interface HelmInstall extends HelmTarget { action: 'install' | 'upgrade'; repository: string; chart: string; version: string; values: string }
export interface HelmDetails { diagnostic?: string; status: string; values: string; manifest: string; notes: string; history: HelmRevision[] }
export interface HelmPreview { token: string; manifest: string; resources: number }
