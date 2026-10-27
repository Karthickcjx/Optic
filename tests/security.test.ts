import { beforeEach, expect, it, vi } from 'vitest';
import { SecurityReports, securityReport } from '../src/main/security';
import { kubeJson } from '../src/main/kube-http';
import { schemas } from '../src/main/validation';
vi.mock('../src/main/kube-http', () => ({ kubeJson: vi.fn() }));
const metadata = { name: 'pod-api-server', namespace: 'team', uid: 'report-1', ownerReferences: [{ kind: 'Pod', apiVersion: 'v1', name: 'api', uid: 'owner-1', controller: true }] };
const raw = () => ({ metadata, report: { updateTimestamp: '2026-10-26T12:00:00Z', scanner: { name: 'Trivy', version: 'test' }, artifact: { repository: 'app', digest: 'sha256:test' }, registry: { server: 'registry.test' }, vulnerabilities: [{ vulnerabilityID: 'CVE-test', severity: 'CRITICAL', resource: 'libssl', installedVersion: '1', fixedVersion: '2', score: 9.8 }] } });
const clusters = { get: vi.fn(() => ({ config: {} })) };
const service = new SecurityReports(clusters as any);
beforeEach(() => { vi.clearAllMocks(); });
it('normalizes image, owner, timestamp and findings without exposing unrelated fields', () => {
  const report = securityReport({ ...raw(), sensitive: 'not-for-renderer' }, 'vulnerabilityreports', true);
  expect(report.image).toBe('registry.test/app@sha256:test');
  expect(report.counts.CRITICAL).toBe(1); expect(report.summaryAvailable).toBe(true);
  expect(report.owner?.uid).toBe('owner-1'); expect(report.findings[0]).toMatchObject({ id: 'CVE-test', installed: '1', fixed: '2', score: 9.8 });
  expect(JSON.stringify(report)).not.toContain('not-for-renderer');
});
it('does not count passed configuration checks as vulnerabilities and exposes unknown outcomes', () => {
  const result = securityReport({ metadata, report: { checks: [{ checkID: 'pass', severity: 'CRITICAL', success: true }, { checkID: 'fail', severity: 'HIGH', success: false, messages: ['Do not run as root'] }, { checkID: 'unknown', severity: 'invented' }] } }, 'configauditreports', true);
  expect(result.counts).toEqual({ CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0, UNKNOWN: 1 });
  expect(result.passed).toBe(1); expect(result.unknown).toBe(1);
  expect(result.findings[0]).toMatchObject({ id: 'fail', status: 'failed', description: 'Do not run as root' });
  expect(result.findings[1].status).toBe('unknown');
});
it('distinguishes absent findings from a valid empty report and caps detail rows', () => {
  expect(securityReport({ metadata, report: {} }, 'vulnerabilityreports', true)).toMatchObject({ summaryAvailable: false, truncated: true });
  expect(securityReport({ metadata, report: { vulnerabilities: [] } }, 'vulnerabilityreports', true)).toMatchObject({ summaryAvailable: true, truncated: false });
  const result = securityReport({ metadata, report: { vulnerabilities: Array.from({ length: 5001 }, () => ({ severity: 'LOW' })) } }, 'vulnerabilityreports', true);
  expect(result.findings).toHaveLength(5000); expect(result.counts.LOW).toBe(5001); expect(result.truncated).toBe(true);
});
it('rejects malformed reports and sanitizes nonfinite score and invalid timestamp', () => {
  expect(() => securityReport({}, 'vulnerabilityreports')).toThrow('invalid security report');
  const value = raw(); value.report.updateTimestamp = 'invalid'; value.report.vulnerabilities[0].score = Infinity;
  expect(securityReport(value, 'vulnerabilityreports', true)).toMatchObject({ updated: undefined, findings: [expect.objectContaining({ score: undefined })] });
});
it('reads namespace-scoped reports through paginated GETs and keeps independent source failures', async () => {
  vi.mocked(kubeJson).mockImplementation(async (_config, path) => {
    if (path.includes('configauditreports')) throw Object.assign(new Error('private server response'), { statusCode: 403 });
    return { items: [raw()], metadata: { continue: path.includes('continue=') ? '' : 'next+page' } };
  });
  const result = await service.read({ clusterId: 'cluster', namespace: 'team' });
  expect(result.sources[0].reports).toHaveLength(1); expect(result.sources[1].state).toBe('forbidden');
  expect(JSON.stringify(result)).not.toContain('private server response');
  expect(vi.mocked(kubeJson).mock.calls.some(call => call[1].includes('/namespaces/team/vulnerabilityreports?limit=50&continue=next%2Bpage'))).toBe(true);
  expect(vi.mocked(kubeJson).mock.calls.every(call => !call[2]?.method || call[2].method === 'GET')).toBe(true);
});
it('distinguishes absent report APIs from network failures and marks partial pages', async () => {
  vi.mocked(kubeJson).mockRejectedValue(Object.assign(new Error('not installed'), { statusCode: 404 }));
  expect((await service.read({ clusterId: 'cluster' })).sources.every(s => s.state === 'missing')).toBe(true);
  vi.mocked(kubeJson).mockImplementation(async (_config, path) => {
    if (path.includes('continue=') || path.includes('configauditreports')) throw new Error('credentials must not leak');
    return { items: [raw()], metadata: { continue: 'next' } };
  });
  const report = (await service.read({ clusterId: 'cluster' })).sources[0];
  expect(report.state).toBe('error'); expect(report.truncated).toBe(true); expect(report.reports).toHaveLength(1);
});
it('bounds repeated pagination tokens and exposes incomplete coverage', async () => {
  vi.mocked(kubeJson).mockResolvedValue({ items: [raw()], metadata: { continue: 'same' } });
  const result = await service.read({ clusterId: 'cluster' });
  expect(result.sources.every(s => s.truncated)).toBe(true); expect(vi.mocked(kubeJson).mock.calls.length).toBeLessThanOrEqual(40);
});
it('refuses details for a report whose name has been reused', async () => {
  vi.mocked(kubeJson).mockResolvedValue(raw());
  await expect(service.detail({ clusterId: 'cluster', namespace: 'team', type: 'vulnerabilityreports', name: metadata.name, uid: 'old-uid' })).rejects.toThrow('replaced');
});
it('validates the read-only IPC boundary and prevents arbitrary API paths', () => {
  expect(schemas['security:reports'].safeParse({ clusterId: 'c' }).success).toBe(true);
  expect(schemas['security:detail'].safeParse({ clusterId: 'c', type: 'secrets', namespace: 'team', name: 'x', uid: 'x' }).success).toBe(false);
  expect(schemas['security:reports'].safeParse({ clusterId: 'c', namespace: '../secrets' }).success).toBe(false);
  expect(schemas['security:reports'].safeParse({ clusterId: 'c', method: 'DELETE' }).success).toBe(false);
});

it('reads ClusterRole reports without a namespace and validates their IPC scope', async () => {
  vi.mocked(kubeJson).mockResolvedValue({ metadata: { ...metadata, namespace: undefined }, report: { checks: [] } });
  const result = await service.detail({ clusterId: 'c', type: 'clusterrbacassessmentreports', name: metadata.name, uid: metadata.uid });
  expect(result.namespace).toBe('');
  expect(vi.mocked(kubeJson).mock.calls[0][1]).toBe('/apis/aquasecurity.github.io/v1alpha1/clusterrbacassessmentreports/pod-api-server');
  expect(schemas['security:detail'].safeParse({ clusterId: 'c', type: 'clusterrbacassessmentreports', name: 'x', uid: 'u' }).success).toBe(true);
  expect(schemas['security:detail'].safeParse({ clusterId: 'c', type: 'clusterrbacassessmentreports', namespace: 'team', name: 'x', uid: 'u' }).success).toBe(false);
  expect(schemas['security:detail'].safeParse({ clusterId: 'c', type: 'rbacassessmentreports', name: 'x', uid: 'u' }).success).toBe(false);
  expect(schemas['resources:get'].safeParse({ clusterId: 'c', kind: 'clusterroles', name: 'system:controller:test' }).success).toBe(true);
});
it('redacts secret matches, file paths and descriptions from exposed-secret details', () => {
  const result = securityReport({ metadata, report: { secrets: [{ ruleID: 'aws-key', category: 'AWS', severity: 'CRITICAL', match: 'TOP_SECRET', target: 'PRIVATE_FILE', description: 'TOP_SECRET', messages: ['TOP_SECRET'] }] } }, 'exposedsecretreports', true);
  expect(result.counts.CRITICAL).toBe(1); expect(result.findings[0].status).toBe('secret');
  expect(JSON.stringify(result)).not.toContain('TOP_SECRET'); expect(JSON.stringify(result)).not.toContain('PRIVATE_FILE');
});
