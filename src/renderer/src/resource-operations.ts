import { create } from 'zustand';
import type { Target } from '../../shared/protocol';

interface Operation { id: string; target: Target; title: string; status: 'running' | 'succeeded' | 'failed'; message: string }
export const useResourceOperations = create<{ operations: Operation[]; revision: number; dismiss: (id: string) => void }>(set => ({
  operations: [], revision: 0,
  dismiss: id => set(s => ({ operations: s.operations.filter(o => o.id !== id || o.status === 'running') }))
}));
export function startResourceOperation(target: Target, title: string, run: () => Promise<string>) {
  const same = (t: Target) => t.clusterId === target.clusterId && t.kind === target.kind && t.namespace === target.namespace && t.name === target.name;
  if (useResourceOperations.getState().operations.some(o => same(o.target) && o.status === 'running')) return false;
  const id = crypto.randomUUID();
  useResourceOperations.setState(s => ({ operations: [...s.operations, { id, target, title, status: 'running', message: 'Operation in progress. You can close this tab; keep Optic open until it finishes.' }] }));
  const finish = (status: 'succeeded' | 'failed', message: string) => useResourceOperations.setState(s => ({ revision: s.revision + 1, operations: s.operations.map(o => o.id === id ? { ...o, status, message } : o) }));
  void Promise.resolve().then(run).then(message => finish('succeeded', message), error => finish('failed', error instanceof Error ? error.message : 'Resource action failed. Refresh its status before retrying.'));
  return true;
}
