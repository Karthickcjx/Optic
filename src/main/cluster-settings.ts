import { z } from 'zod';
import { validContainerShell } from '../shared/logs';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaultClusterSettings, metricCategories, type ClusterSettings } from '../shared/cluster-settings';
const name = z.string().regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/).max(253);
const endpoint = z.object({ namespace: name, service: z.union([name, z.literal('')]), port: z.number().int().min(1).max(65535) });
export const clusterSettingsSchema = z.object({
  displayName: z.string().max(60), color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  proxyUrl: z.string().max(2048).refine(value => { if (!value) return true; try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash; } catch { return false; } }, 'Use an HTTP(S) proxy URL without embedded credentials.'),
  terminalCwd: z.string().max(4096).refine(v => !/[\0\r\n]/.test(v)), defaultNamespace: name,
  containerShell: z.string().refine(validContainerShell).default('/bin/sh'),
  accessibleNamespaces: z.array(name).max(200), metricsSource: z.enum(['automatic', 'prometheus', 'metrics-server', 'none']),
  hiddenMetrics: z.array(z.enum(metricCategories)).max(metricCategories.length), prometheus: endpoint,
  costSource: z.enum(['automatic', 'kubecost', 'opencost', 'estimate', 'off']), costEndpoint: endpoint,
  estimatedNodeHourlyCost: z.number().finite().min(0).max(100000),
  nodeShellImage: z.string().min(1).max(512).regex(/^[a-zA-Z0-9][a-zA-Z0-9./_:@-]*$/), nodeShellPullSecret: z.union([name, z.literal('')])
});
export class ClusterSettingsStore {
  private values: Record<string, ClusterSettings> = {};
  constructor(private path?: string) {
    if (path && existsSync(path)) { try { const data = JSON.parse(readFileSync(path, 'utf8')); for (const [id, value] of Object.entries(data)) { const parsed = clusterSettingsSchema.safeParse(value); if (parsed.success) this.values[id] = parsed.data; } } catch {} }
  }
  get(id: string, namespace = 'default'): ClusterSettings { return structuredClone(this.values[id] ?? { ...defaultClusterSettings, defaultNamespace: namespace }); }
  save(id: string, value: ClusterSettings) {
    const next = { ...this.values, [id]: clusterSettingsSchema.parse(value) };
    if (this.path) { mkdirSync(dirname(this.path), { recursive: true }); const temp = `${this.path}.tmp`; writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 }); renameSync(temp, this.path); }
    this.values = next; return this.get(id);
  }
}
