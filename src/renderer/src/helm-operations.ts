import { create } from 'zustand';

export interface HelmOperation {
  id: string;
  clusterId: string;
  title: string;
  status: 'running' | 'succeeded' | 'failed';
  message: string;
}
export const useHelmOperations = create<{
  operations: HelmOperation[];
  revision: number;
  dismiss: (id: string) => void;
}>(set => ({
  operations: [], revision: 0,
  dismiss: id => set(s => ({ operations: s.operations.filter(o => o.id !== id || o.status === 'running') }))
}));

// The promise belongs to the application, not the chart dialog or workspace tab.
export function startHelmOperation(clusterId: string, title: string, run: () => Promise<unknown>) {
  if (useHelmOperations.getState().operations.some(o => o.clusterId === clusterId && o.status === 'running')) return false;
  const id = crypto.randomUUID();
  useHelmOperations.setState(s => ({ operations: [...s.operations, { id, clusterId, title, status: 'running', message: 'Helm is running. You can switch or close tabs. Keep Optic open until it finishes.' }] }));
  const finish = (status: 'succeeded' | 'failed', message: string) => useHelmOperations.setState(s => ({
    revision: s.revision + 1,
    operations: s.operations.map(o => o.id === id ? { ...o, status, message } : o)
  }));
  void Promise.resolve().then(run).then(
    () => finish('succeeded', 'Operation completed successfully.'),
    error => finish('failed', error instanceof Error ? error.message : 'Helm operation failed. Check release status before retrying.')
  );
  return true;
}
