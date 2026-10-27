export const securityTypes = ['vulnerabilityreports', 'configauditreports'] as const;
export type SecurityType = typeof securityTypes[number];
export const severities = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] as const;
export type Severity = typeof severities[number];
export interface SecurityScope { clusterId: string; namespace?: string }
export interface SecurityTarget extends SecurityScope { namespace: string; type: SecurityType; name: string; uid: string }
export interface SecurityFinding {
  id: string; severity: Severity; title: string; description: string;
  package: string; installed: string; fixed: string; score?: number;
  status: 'vulnerability' | 'failed' | 'unknown';
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
export interface SecuritySnapshot { fetchedAt: number; sources: SecuritySource[] }
