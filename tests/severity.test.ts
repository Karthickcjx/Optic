import { expect, it } from 'vitest';
import { conditionSeverity, containerSeverity, logSeverity, resourceSeverity } from '../src/shared/severity';

it('highlights errors in plain and structured logs while respecting explicit levels', () => {
  for (const line of ['ERROR connection refused', '{"level":"error","msg":"request rejected"}', 'panic: stopped', 'Unhandled Exception']) expect(logSeverity(line)).toBe('error');
  expect(logSeverity('level=warn retrying')).toBe('warning');
  expect(logSeverity('level=info no error found')).toBe('normal');
  expect(logSeverity('0 errors')).toBe('normal');
  expect(logSeverity('errors=0')).toBe('normal');
  expect(logSeverity('server ready')).toBe('normal');
});
it('uses condition polarity instead of treating every false condition as an error', () => {
  expect(conditionSeverity({ type: 'Ready', status: 'False' })).toBe('error');
  expect(conditionSeverity({ type: 'DiskPressure', status: 'True' })).toBe('error');
  expect(conditionSeverity({ type: 'DiskPressure', status: 'False' })).toBe('normal');
  expect(conditionSeverity({ type: 'Complete', status: 'False' })).toBe('normal');
  expect(containerSeverity({ terminated: { exitCode: 0, reason: 'Completed' } })).toBe('normal');
  expect(containerSeverity({ terminated: { exitCode: 137, reason: 'OOMKilled' } })).toBe('error');
});
it('includes init-container failures and failing resources beyond pods', () => {
  expect(resourceSeverity({ kind: 'Pod', metadata: {}, status: { initContainerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff' } } }] } })).toBe('error');
  expect(resourceSeverity({ kind: 'PersistentVolume', metadata: {}, status: { phase: 'Failed' } })).toBe('error');
  expect(resourceSeverity({ kind: 'Deployment', metadata: {}, status: { conditions: [{ type: 'Available', status: 'False' }] } })).toBe('error');
});
