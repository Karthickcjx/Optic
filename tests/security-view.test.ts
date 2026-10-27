import { expect, it } from 'vitest';
import { securityRows, securityStatistics } from '../src/shared/security-view';
import { securityReport } from '../src/main/security';
const metadata = { name: 'pod-api-server', namespace: 'team', uid: 'a' };
const scan = (uid: string, count: number, updated: string) => securityReport({ metadata: { ...metadata, uid }, report: { updateTimestamp: updated, artifact: { repository: 'app', tag: '1' }, vulnerabilities: Array.from({ length: count }, () => ({ severity: 'CRITICAL' })) } }, 'vulnerabilityreports');
it('groups duplicate image reports using the latest scan without double counting', () => {
  const rows = securityRows('images', [scan('old', 10, '2026-10-25'), scan('new', 2, '2026-10-26')]);
  expect(rows).toHaveLength(1); expect(rows[0].reports).toHaveLength(2); expect(rows[0].counts.CRITICAL).toBe(2);
  expect(securityStatistics(rows)).toMatchObject({ scanned: 1, withFindings: 1 });
});
it('does not claim an unscanned image digest is covered by a matching tag', () => {
  const report = scan('report', 0, '2026-10-26'); report.image = 'app@sha256:' + 'a'.repeat(64);
  const pods = [{ metadata: { namespace: 'team' }, spec: { containers: [{ name: 'app', image: 'app:1' }] }, status: { containerStatuses: [{ name: 'app', imageID: 'containerd://sha256:' + 'b'.repeat(64) }] } }];
  const rows = securityRows('images', [report], pods);
  expect(rows).toHaveLength(2); expect(securityStatistics(rows).unknown).toBe(1);
});
it('matches a known digest and includes init containers without reports', () => {
  const report = scan('report', 0, '2026-10-26'); report.image = 'app@sha256:' + 'a'.repeat(64);
  const rows = securityRows('images', [report], [{ metadata: { namespace: 'other' }, spec: { containers: [{ name: 'app', image: 'app:1' }], initContainers: [{ image: 'init:2' }] }, status: { containerStatuses: [{ name: 'app', imageID: 'containerd://sha256:' + 'a'.repeat(64) }] } }]);
  expect(rows).toHaveLength(2); expect(rows[0].namespace).toBe('other, team'); expect(rows[1].scanned).toBe(false);
});
it('keeps cluster roles and namespaced roles separate and marks missing reports unknown', () => {
  const report = securityReport({ metadata: { ...metadata, namespace: undefined, ownerReferences: [{ kind: 'ClusterRole', apiVersion: 'rbac.authorization.k8s.io/v1', uid: 'cluster-role', name: 'admin' }] }, report: { checks: [] } }, 'clusterrbacassessmentreports');
  const roles = [{ kind: 'ClusterRole', metadata: { name: 'admin', uid: 'cluster-role' } }, { kind: 'Role', metadata: { name: 'admin', namespace: 'team', uid: 'role' } }];
  const rows = securityRows('roles', [report], [], roles);
  expect(rows).toHaveLength(2); expect(rows[0]).toMatchObject({ namespace: '', scanned: true }); expect(rows[1]).toMatchObject({ namespace: 'team', scanned: false });
});
