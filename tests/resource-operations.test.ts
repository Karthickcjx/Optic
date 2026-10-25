import { beforeEach, expect, it } from 'vitest';
import { startResourceOperation, useResourceOperations } from '../src/renderer/src/resource-operations';
beforeEach(() => useResourceOperations.setState({ operations: [], revision: 0 }));
it('keeps background operations alive after closing a dialog and replaces running status on failure', async () => {
  const target = { clusterId: 'c', kind: 'nodes' as const, name: 'node' };
  let reject!: (error: Error) => void;
  const pending = new Promise<string>((_resolve, fail) => { reject = fail; });
  expect(startResourceOperation(target, 'Drain', () => pending)).toBe(true);
  expect(startResourceOperation(target, 'Duplicate', async () => '')).toBe(false);
  const id = useResourceOperations.getState().operations[0].id;
  useResourceOperations.getState().dismiss(id);
  expect(useResourceOperations.getState().operations).toHaveLength(1);
  reject(new Error('Budget blocked drain'));
  await expect.poll(() => useResourceOperations.getState().operations[0].status).toBe('failed');
  expect(useResourceOperations.getState().operations[0].message).toBe('Budget blocked drain');
  expect(useResourceOperations.getState().revision).toBe(1);
  useResourceOperations.getState().dismiss(id); expect(useResourceOperations.getState().operations).toHaveLength(0);
});
