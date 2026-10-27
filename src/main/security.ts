import type { ClusterManager } from './clusters';
import { kubeJson } from './kube-http';
import { AppError, fault } from './errors';
import { securityTypes, severities, type SecurityFinding, type SecurityType, type SecurityReport, type SecurityDetail, type SecurityScope, type SecurityTarget, type SecuritySnapshot, type SecuritySource, type Severity } from '../shared/security';

const root = '/apis/aquasecurity.github.io/v1alpha1';
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const text = (value: unknown, limit = 1024) => typeof value === 'string' ? value.slice(0, limit) : '';
const severity = (value: unknown): Severity => severities.find(s => s === text(value).toUpperCase()) ?? 'UNKNOWN';
const emptyCounts = () => ({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 });

/** Only documented report fields cross IPC; arbitrary CRD contents are not exposed. */
export function securityReport(raw: unknown, type: SecurityType, details = false): SecurityDetail {
  const resource = object(raw), metadata = object(resource.metadata), report = object(resource.report);
  if (!text(metadata.name) || !text(metadata.namespace) || !text(metadata.uid) || !resource.report || typeof resource.report !== 'object' || Array.isArray(resource.report)) throw new AppError('SECURITY_REPORT', 'The operator returned an invalid security report.');
  const owner = Array.isArray(metadata.ownerReferences) ? metadata.ownerReferences.find((o: any) => o?.controller === true) ?? metadata.ownerReferences[0] : undefined;
  const labels = object(metadata.labels), artifact = object(report.artifact), registry = object(report.registry), scanner = object(report.scanner);
  const counts = emptyCounts(), summary = object(report.summary);
  const vulnerabilities = Array.isArray(report.vulnerabilities) ? report.vulnerabilities : undefined;
  const checks = Array.isArray(report.checks) ? report.checks : undefined;
  const entries = type === 'vulnerabilityreports' ? vulnerabilities : checks;
  let summaryAvailable = entries !== undefined, passed = 0, unknown = 0;
  const failures: any[] = [];
  if (entries) for (const rawEntry of entries) {
    const entry = object(rawEntry);
    if (type === 'configauditreports' && entry.success === true) { passed++; continue; }
    if (type === 'configauditreports' && entry.success !== false) unknown++;
    counts[severity(entry.severity)]++;
    if (details && failures.length < 5000) failures.push(entry);
  }
  if (type === 'vulnerabilityreports' && !entries) {
    summaryAvailable = severities.every(s => Number.isSafeInteger(summary[`${s.toLowerCase()}Count`]) && summary[`${s.toLowerCase()}Count`] >= 0);
    if (summaryAvailable) for (const s of severities) counts[s] = summary[`${s.toLowerCase()}Count`];
  }
  const updated = text(report.updateTimestamp);
  return {
    type, name: text(metadata.name), namespace: text(metadata.namespace), uid: text(metadata.uid),
    owner: owner && text(owner.kind) && text(owner.name) && text(owner.uid) ? { kind: text(owner.kind), apiVersion: text(owner.apiVersion), name: text(owner.name), uid: text(owner.uid) } : undefined,
    container: text(labels['trivy-operator.container.name']),
    image: [text(registry.server), text(artifact.repository)].filter(Boolean).join('/') + (text(artifact.digest) ? `@${text(artifact.digest)}` : text(artifact.tag) ? `:${text(artifact.tag)}` : ''),
    scanner: [text(scanner.name), text(scanner.version)].filter(Boolean).join(' '),
    updated: updated && Number.isFinite(Date.parse(updated)) ? updated : undefined,
    counts, summaryAvailable, passed, unknown,
    truncated: details && (!!entries && entries.length - passed > failures.length || !entries),
    findings: failures.map((entry): SecurityFinding => ({
      id: text(type === 'vulnerabilityreports' ? entry.vulnerabilityID : entry.checkID) || 'Unknown ID',
      severity: severity(entry.severity), title: text(entry.title),
      description: text(entry.description, 8192) || (Array.isArray(entry.messages) ? entry.messages.slice(0, 20).map((m: unknown) => text(m)).join('\n') : ''),
      package: text(entry.resource), installed: text(entry.installedVersion), fixed: text(entry.fixedVersion),
      score: typeof entry.score === 'number' && Number.isFinite(entry.score) && entry.score >= 0 && entry.score <= 10 ? entry.score : undefined,
      status: type === 'vulnerabilityreports' ? 'vulnerability' : entry.success === false ? 'failed' : 'unknown'
    })).sort((a, b) => severities.indexOf(a.severity) - severities.indexOf(b.severity))
  };
}

export class SecurityReports {
  constructor(private clusters: ClusterManager) {}
  async read(scope: SecurityScope): Promise<SecuritySnapshot> {
    const config = this.clusters.get(scope.clusterId).config;
    const signal = AbortSignal.timeout(45000);
    const sources = await Promise.all(securityTypes.map(async (type): Promise<SecuritySource> => {
      const reports: SecurityReport[] = [];
      try {
        let continuation = '';
        for (let page = 0; page < 20; page++) {
          const query = new URLSearchParams({ limit: '50', ...(continuation ? { continue: continuation } : {}) });
          const path = `${root}${scope.namespace ? `/namespaces/${encodeURIComponent(scope.namespace)}` : ''}/${type}?${query}`;
          const result = await kubeJson(config, path, { signal });
          if (!Array.isArray(result?.items)) throw new AppError('SECURITY_REPORT', 'The operator returned an invalid report list.');
          for (const item of result.items.slice(0, 1000 - reports.length)) {
            const { findings, passed, unknown, truncated, ...report } = securityReport(item, type);
            reports.push(report);
          }
          continuation = text(result.metadata?.continue, 8192);
          if (!continuation && result.items.length <= 50) return { type, state: 'ready', truncated: false, reports };
          if (reports.length >= 1000 || !continuation) return { type, state: 'ready', truncated: true, reports };
        }
        return { type, state: 'ready', truncated: true, reports };
      } catch (error) {
        const code = (error as { statusCode?: number }).statusCode;
        return { type, state: code === 404 ? 'missing' : code === 401 || code === 403 ? 'forbidden' : 'error', reports, truncated: reports.length > 0,
          message: code === 404 ? 'Report API unavailable. Install or enable Trivy Operator for this report type.' : code === 401 || code === 403 ? 'Access denied. Grant list/get access to this report type, or choose a permitted namespace.' : fault(error).message };
      }
    }));
    return { fetchedAt: Date.now(), sources };
  }
  async detail(target: SecurityTarget): Promise<SecurityDetail> {
    const config = this.clusters.get(target.clusterId).config;
    const raw = await kubeJson(config, `${root}/namespaces/${encodeURIComponent(target.namespace)}/${target.type}/${encodeURIComponent(target.name)}`);
    const result = securityReport(raw, target.type, true);
    if (result.uid !== target.uid) throw new AppError('CONFLICT', 'This report was replaced. Refresh security reports before opening it.');
    return result;
  }
}
