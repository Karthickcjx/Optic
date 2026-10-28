import type { Resource } from './protocol';
import { severities, type SecurityPage, type SecurityReport, type Severity } from './security';

export interface SecurityRow {
  id: string; name: string; kind: string; namespace: string; reports: SecurityReport[];
  counts: Record<Severity, number>; secretCount?: number; scanned: boolean; updated?: string;
}
const empty = (): Record<Severity, number> => ({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 });
export const findingCount = (counts: Record<Severity, number>) => Object.values(counts).reduce((a, b) => a + b, 0);
const newest = (a: SecurityReport, b: SecurityReport) => (Date.parse(b.updated ?? '') || 0) - (Date.parse(a.updated ?? '') || 0) || a.uid.localeCompare(b.uid);
const digest = (image: string) => image.match(/sha256:[a-f0-9]{64}$/i)?.[0].toLowerCase();
const imageKey = (image: string) => {
  image = image.replace(/^(?:docker-pullable|docker|containerd):\/\//, '').replace(/^(?:index\.docker\.io|docker\.io)\//, '');
  if (image.startsWith('library/')) image = image.slice(8);
  return image;
};
function row(reports: SecurityReport[], id: string, name: string, kind: string, namespace: string): SecurityRow {
  const sorted = [...reports].sort(newest), counts = empty();
  // One latest vulnerability scan per image; retain all reports for owner inspection.
  const representative = kind === 'Image' ? sorted.find(r => r.type === 'vulnerabilityreports') : sorted[0];
  if (representative?.summaryAvailable) Object.assign(counts, representative.counts);
  const secrets = sorted.find(r => r.type === 'exposedsecretreports');
  return { id, name, kind, namespace, reports: sorted, counts, scanned: !!representative?.summaryAvailable, updated: representative?.updated,
    secretCount: secrets?.summaryAvailable ? findingCount(secrets.counts) : undefined };
}
export function securityRows(page: SecurityPage, reports: SecurityReport[], pods: Resource[] = [], roles: Resource[] = []): SecurityRow[] {
  const images = new Map<string, SecurityReport[]>();
  for (const report of reports.filter(r => ['vulnerabilityreports', 'exposedsecretreports'].includes(r.type))) {
    const key = report.image ? imageKey(report.image) : `unidentified:${report.uid}`;
    images.set(key, [...(images.get(key) ?? []), report]);
  }
  const imageRows = [...images.entries()].map(([key, rs]) => row(rs, `image:${key}`, rs[0].image || rs[0].name, 'Image', [...new Set(rs.map(r => r.namespace))].sort().join(', ')));
  for (const pod of pods) for (const container of [...(pod.spec?.containers ?? []), ...(pod.spec?.initContainers ?? []), ...(pod.spec?.ephemeralContainers ?? [])]) {
    if (typeof container.image !== 'string') continue;
    const statuses = [...(pod.status?.containerStatuses ?? []), ...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.ephemeralContainerStatuses ?? [])];
    const currentDigest = digest(String(statuses.find(s => s.name === container.name)?.imageID ?? ''));
    // A matching mutable tag does not establish coverage for a different digest.
    const known = imageRows.find(r => currentDigest ? digest(r.name) === currentDigest : !digest(r.name) && imageKey(r.name) === imageKey(container.image));
    if (known) {
      known.namespace = [...new Set([...known.namespace.split(', ').filter(Boolean), ...(pod.metadata.namespace ? [pod.metadata.namespace] : [])])].sort().join(', ');
      continue;
    }
    const key = currentDigest ? `${imageKey(container.image).split('@')[0]}@${currentDigest}` : imageKey(container.image);
    const existing = imageRows.find(r => r.id === `image:${key}`);
    if (existing) existing.namespace = [...new Set([...existing.namespace.split(', ').filter(Boolean), pod.metadata.namespace ?? ''].filter(Boolean))].sort().join(', ');
    else imageRows.push(row([], `image:${key}`, currentDigest && !container.image.includes(currentDigest) ? `${container.image} (${currentDigest})` : container.image, 'Image', pod.metadata.namespace ?? ''));
  }
  const configs = reports.filter(r => r.type === 'configauditreports').map(r => row([r], r.uid, r.owner?.name ?? r.name, r.owner?.kind ?? 'Resource', r.namespace));
  const assessments = reports.filter(r => r.type === 'rbacassessmentreports' || r.type === 'clusterrbacassessmentreports').map(r => row([r], r.uid, r.owner?.name ?? r.name, r.owner?.kind ?? (r.type === 'clusterrbacassessmentreports' ? 'ClusterRole' : 'Role'), r.namespace));
  for (const resource of roles) if (!assessments.some(r => r.reports.some(report => report.owner?.uid === resource.metadata.uid))) {
    assessments.push(row([], `role:${resource.metadata.uid}`, resource.metadata.name ?? 'Unknown', resource.kind ?? 'Role', resource.metadata.namespace ?? ''));
  }
  return page === 'images' ? imageRows : page === 'resources' ? configs : page === 'roles' ? assessments : [...imageRows, ...configs, ...assessments];
}

/** Current scanner pod failures and recent warnings, without exposing logs or credentials. */
export function scannerIssues(pods: Resource[], events: Resource[], now = Date.now()) {
  const scanner = (name: string) => /^(trivy-operator|scan-vulnerabilityreport-|node-collector-)/.test(name);
  const issues = new Map<string, { namespace: string; name: string; message: string }>();
  for (const pod of pods) {
    const name = pod.metadata.name ?? '', namespace = pod.metadata.namespace ?? '';
    if (!scanner(name)) continue;
    const statuses = [...(pod.status?.containerStatuses ?? []), ...(pod.status?.initContainerStatuses ?? [])];
    const failure = statuses.find(s => s.state?.waiting && s.state.waiting.reason !== 'ContainerCreating' || s.state?.terminated?.exitCode > 0);
    const condition = pod.status?.conditions?.find((c: any) => c.type === 'PodScheduled' && c.status === 'False');
    const message = failure?.state?.waiting?.reason ?? failure?.state?.terminated?.reason ?? condition?.message ?? (pod.status?.phase === 'Failed' ? pod.status?.message || 'Scanner pod failed' : '');
    if (message) issues.set(`${namespace}/${name}`, { namespace, name, message: String(message).slice(0, 1200) });
  }
  const recent = [...events].sort((a, b) => Date.parse(b.lastTimestamp || b.eventTime || b.metadata.creationTimestamp || '') - Date.parse(a.lastTimestamp || a.eventTime || a.metadata.creationTimestamp || ''));
  for (const event of recent) {
    const name = event.involvedObject?.name ?? '', namespace = event.metadata.namespace ?? '';
    const time = Date.parse(event.lastTimestamp || event.eventTime || event.metadata.creationTimestamp || '');
    if (event.type !== 'Warning' || !scanner(name) || !Number.isFinite(time) || now - time > 3600000 || issues.has(`${namespace}/${name}`)) continue;
    issues.set(`${namespace}/${name}`, { namespace, name, message: `${event.reason ?? 'Warning'}: ${event.message ?? ''}`.slice(0, 1200) });
  }
  return [...issues.values()].slice(0, 5);
}
export function securityStatistics(rows: SecurityRow[]) {
  return {
    scanned: rows.filter(r => r.scanned).length, unknown: rows.filter(r => !r.scanned).length,
    withFindings: rows.filter(r => r.scanned && findingCount(r.counts) > 0).length,
    withoutFindings: rows.filter(r => r.scanned && findingCount(r.counts) === 0).length,
    counts: Object.fromEntries(severities.map(s => [s, rows.reduce((n, r) => n + r.counts[s], 0)])) as Record<Severity, number>
  };
}
