import type { Target } from './protocol';
export const metricWorkloads = ['pods', 'deployments', 'statefulsets', 'daemonsets', 'replicasets', 'replicationcontrollers', 'jobs', 'cronjobs'] as const;
export type MetricKey = 'cpu' | 'memory' | 'networkRx' | 'networkTx' | 'filesystem';
export type MetricPoint = [number, number];
export interface ResourceMetricRequest extends Target { uid: string; container?: string; minutes: number }
export interface ResourceMetricResult {
  source: string; podCount: number; containers: string[]; warning?: string;
  history: boolean; series: Record<MetricKey, MetricPoint[]>;
  unavailable: Partial<Record<MetricKey, string>>;
}
export const emptyMetricSeries = (): ResourceMetricResult['series'] => ({ cpu: [], memory: [], networkRx: [], networkTx: [], filesystem: [] });
