import type { ClusterManager } from './clusters';
import type { CostQuery, HistoricalPrice } from '../shared/cost';
import { kubeJson } from './kube-http';
import { serviceProxy } from './providers';
import { AppError } from './errors';

const metrics = { node_cpu_hourly_cost: ['cpu', 'USD/core-hour'], node_ram_hourly_cost: ['memory', 'USD/GiB-hour'], node_gpu_hourly_cost: ['gpu', 'USD/GPU-hour'], pv_hourly_cost: ['storage', 'USD/GiB-hour'] } as const;
export function parsePriceHistory(response: any, query: CostQuery): HistoricalPrice[] {
  if (response?.status !== 'success' || response.data?.resultType !== 'matrix' || !Array.isArray(response.data.result)) throw new AppError('COST_PRICES', 'Pricing history response is unavailable.');
  if (response.data.result.length > 2000) throw new AppError('COST_LIMIT', 'Price history exceeds 2,000 series. Use a cluster-scoped Prometheus endpoint.');
  const rows = new Map<string, HistoricalPrice>();
  for (const raw of response.data.result) {
    const metric = raw.metric ?? {}, definition = metrics[metric.__name__ as keyof typeof metrics];
    if (!definition) continue;
    const identity = definition[0] === 'storage' ? metric.persistentvolume : metric.node;
    if (typeof identity !== 'string' || identity.length > 1024 || !Array.isArray(raw.values) || raw.values.length > 301) throw new AppError('COST_PRICES', 'Pricing history contains invalid resource identities or too many samples.');
    const provider = typeof metric.provider_id === 'string' ? metric.provider_id : '';
    const cloud = provider.startsWith('gce:') ? 'GCP' : provider.startsWith('aws:') ? 'AWS' : provider.startsWith('azure:') ? 'Azure' : 'Provider';
    const cluster = typeof metric.cluster === 'string' ? metric.cluster : '';
    const key = JSON.stringify([definition[0], identity, cluster]);
    if (rows.has(key)) throw new AppError('COST_PRICES', 'Pricing history has conflicting providers for one resource; scope the Prometheus endpoint to one cluster.');
    const samples = [];
    for (const pair of raw.values) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'number' || typeof pair[1] !== 'string' || !pair[1].trim()) continue;
      const time = pair[0] * 1000, price = Number(pair[1]);
      if (Number.isFinite(time) && time >= query.start && time <= query.end && Number.isFinite(price) && price >= 0) samples.push({ time, price });
    }
    samples.sort((a, b) => a.time - b.time);
    if (samples.length) rows.set(key, { resource: definition[0], identity, cloud, cluster, unit: definition[1], samples });
  }
  return [...rows.values()];
}
export async function readPriceHistory(clusters: ClusterManager, query: CostQuery) {
  const settings = clusters.settings(query.clusterId);
  if (!settings.prometheus.service || settings.metricsSource === 'none') throw new AppError('COST_PRICES', 'Select a Prometheus service in Metrics to read retained provider price history.');
  const step = Math.max(60, Math.ceil((query.end - query.start) / 1000 / 288));
  // Preserve cluster and provider identity. Collapse duplicate exporter scrapes only.
  const expression = `max by (__name__,cluster,node,provider_id,persistentvolume) ({__name__=~"${Object.keys(metrics).join('|')}"})`;
  const params = new URLSearchParams({ query: expression, start: String(query.start / 1000), end: String(query.end / 1000), step: String(step), timeout: '15s' });
  const response = await kubeJson(clusters.get(query.clusterId).config, `${serviceProxy(settings.prometheus)}/api/v1/query_range?${params}`);
  if (response.warnings?.length) throw new AppError('COST_PRICES', 'Prometheus reported partial price-history results.');
  return parsePriceHistory(response, query);
}
