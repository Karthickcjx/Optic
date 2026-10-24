import { beforeEach, expect, it } from 'vitest';
import { startHelmOperation, useHelmOperations } from '../src/renderer/src/helm-operations';

beforeEach(() => useHelmOperations.setState({ operations: [], revision: 0 }));
it('keeps a running notification, prevents duplicate cluster operations and reports completion', async () => {
  let complete!: () => void;
  const pending = new Promise<void>(resolve => { complete = resolve; });
  expect(startHelmOperation('cluster', 'Install web', () => pending)).toBe(true);
  expect(startHelmOperation('cluster', 'Install twice', async () => {})).toBe(false);
  const id = useHelmOperations.getState().operations[0].id;
  useHelmOperations.getState().dismiss(id);
  expect(useHelmOperations.getState().operations[0].status).toBe('running');
  complete();
  await expect.poll(() => useHelmOperations.getState().operations[0].status).toBe('succeeded');
  expect(useHelmOperations.getState().revision).toBe(1);
  useHelmOperations.getState().dismiss(id);
  expect(useHelmOperations.getState().operations).toEqual([]);
});
it('retains a failure notification and releases the cluster for retry', async () => {
  startHelmOperation('cluster', 'Install web', async () => { throw new Error('Image pull timeout'); });
  await expect.poll(() => useHelmOperations.getState().operations[0].status).toBe('failed');
  expect(useHelmOperations.getState().operations[0].message).toBe('Image pull timeout');
  expect(startHelmOperation('cluster', 'Retry web', async () => {})).toBe(true);
  await expect.poll(() => useHelmOperations.getState().operations[1].status).toBe('succeeded');
});
