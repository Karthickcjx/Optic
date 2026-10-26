export const metricCategories = ['Cluster', 'Node', 'Pod', 'Deployment', 'StatefulSet', 'Container', 'Ingress', 'PersistentVolumeClaim', 'ReplicaSet', 'DaemonSet', 'Job'] as const;
export interface ServiceEndpoint { namespace: string; service: string; port: number }
export interface ClusterSettings {
  displayName: string; color: string; proxyUrl: string; terminalCwd: string; containerShell: string; defaultNamespace: string; accessibleNamespaces: string[];
  metricsSource: 'automatic' | 'prometheus' | 'metrics-server' | 'none'; hiddenMetrics: string[]; prometheus: ServiceEndpoint;
  costSource: 'automatic' | 'kubecost' | 'opencost' | 'estimate' | 'off'; costEndpoint: ServiceEndpoint; estimatedNodeHourlyCost: number; estimatePublicPrices: boolean; estimatedCpuHourlyCost: number; estimatedMemoryHourlyCost: number;
  nodeShellImage: string; nodeShellPullSecret: string;
}
export const defaultClusterSettings: ClusterSettings = {
  displayName: '', color: '#4b91bd', proxyUrl: '', terminalCwd: '', containerShell: '/bin/sh', defaultNamespace: 'default', accessibleNamespaces: [],
  metricsSource: 'automatic', hiddenMetrics: [], prometheus: { namespace: 'monitoring', service: '', port: 9090 },
  costSource: 'automatic', costEndpoint: { namespace: 'opencost', service: '', port: 9003 }, estimatedNodeHourlyCost: 0, estimatePublicPrices: true, estimatedCpuHourlyCost: 0.03, estimatedMemoryHourlyCost: 0.004,
  nodeShellImage: 'alpine:3.21', nodeShellPullSecret: ''
};
export type MonitoringComponent = 'prometheus' | 'kube-state-metrics' | 'prometheus-node-exporter';
export interface MonitoringChange { component: MonitoringComponent; action: 'install' | 'uninstall'; version: string }
export interface CostResult { source: string; currency: string; total: number | null; window: string; allocations: { name: string; cost: number }[]; warning?: string }
