export const securityTypes = ['vulnerabilityreports', 'configauditreports', 'rbacassessmentreports', 'clusterrbacassessmentreports', 'exposedsecretreports'] as const;
export type SecurityType = typeof securityTypes[number];
export const severities = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] as const;
export type Severity = typeof severities[number];
export interface SecurityScope { clusterId: string; namespace?: string }
export interface SecurityTarget extends SecurityScope { namespace?: string; type: SecurityType; name: string; uid: string }
export interface SecurityFinding {
  id: string; severity: Severity; title: string; description: string;
  package: string; installed: string; fixed: string; score?: number;
  status: 'vulnerability' | 'failed' | 'unknown' | 'secret';
}
export interface SecurityReport {
  type: SecurityType; name: string; namespace: string; uid: string;
  owner?: { kind: string; apiVersion: string; name: string; uid: string };
  container: string; image: string; scanner: string; updated?: string;
  counts: Record<Severity, number>; summaryAvailable: boolean;
}
export interface SecurityDetail extends SecurityReport {
  findings: SecurityFinding[]; truncated: boolean; passed: number; unknown: number;
}
export interface SecuritySource {
  type: SecurityType; state: 'ready' | 'missing' | 'forbidden' | 'error';
  message?: string; truncated: boolean; reports: SecurityReport[];
}
export interface SecuritySnapshot { fetchedAt: number; sources: SecuritySource[]; operator?: 'ready' | 'unavailable' | 'absent' | 'unknown' }

export type SecurityPage = 'overview' | 'images' | 'resources' | 'roles';
export const securityPageTypes: Record<SecurityPage, readonly SecurityType[]> = {
  overview: securityTypes, images: ['vulnerabilityreports', 'exposedsecretreports'],
  resources: ['configauditreports'], roles: ['rbacassessmentreports', 'clusterrbacassessmentreports']
};
export const securityLabels: Record<SecurityType, string> = {
  vulnerabilityreports: 'Image vulnerabilities', configauditreports: 'Configuration audit',
  rbacassessmentreports: 'Role assessment', clusterrbacassessmentreports: 'ClusterRole assessment',
  exposedsecretreports: 'Exposed secrets'
};
export const clusterSecurityType = (type: SecurityType) => type === 'clusterrbacassessmentreports';

export const trivyInstallCommands = [
  'helm repo add aqua https://aquasecurity.github.io/helm-charts/',
  'helm repo update',
  'helm upgrade --install trivy-operator aqua/trivy-operator --namespace trivy-system --create-namespace'
].join('\n');
