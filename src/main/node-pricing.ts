import { fetch } from 'undici';
import { quantity } from '../shared/quantities';
import type { ClusterSettings } from '../shared/cluster-settings';
import type { NodePrice } from '../shared/cost';

// These are public price feeds, never cluster-authenticated requests. No node names or credentials are sent.
const cache = new Map<string, { expires: number; value: Promise<any> }>();
async function publicJson(url: string) {
  const old = cache.get(url); if (old && old.expires > Date.now()) return old.value;
  const value = (async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Price feed unavailable'); }
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body!) { size += chunk.length; if (size > 8_000_000) throw new Error('Price feed too large'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  })();
  cache.set(url, { expires: Date.now() + 86400000, value });
  if (cache.size > 64) cache.delete(cache.keys().next().value!);
  try { return await value; } catch (error) { cache.delete(url); throw error; }
}
export function nodeFacts(node: any): Omit<NodePrice, 'hourly' | 'cpuHourly' | 'memoryHourly' | 'source'> {
  const labels = node.metadata?.labels ?? {}, id = node.spec?.providerID ?? '';
  return { node: node.metadata.name, cloud: id.startsWith('aws:') ? 'AWS' : id.startsWith('azure:') ? 'Azure' : id.startsWith('gce:') ? 'GCP' : 'Unknown',
    region: labels['topology.kubernetes.io/region'] ?? labels['failure-domain.beta.kubernetes.io/region'] ?? '',
    instanceType: labels['node.kubernetes.io/instance-type'] ?? labels['beta.kubernetes.io/instance-type'] ?? '',
    spot: labels['karpenter.sh/capacity-type'] === 'spot' || labels['eks.amazonaws.com/capacityType'] === 'SPOT' || labels['cloud.google.com/gke-spot'] === 'true' || labels['cloud.google.com/gke-preemptible'] === 'true' || labels['kubernetes.azure.com/scalesetpriority'] === 'spot' || labels['node.kubernetes.io/instance-lifecycle'] === 'spot',
    cpu: quantity(node.status?.capacity?.cpu), memoryGiB: quantity(node.status?.capacity?.memory) / 1024 ** 3 };
}
export function awsHourly(data: any, region: string, type: string): number | undefined {
  if (data?.manifest?.currencyCode !== 'USD') return;
  const rows = Object.values(data.regions?.[region] ?? {}).filter((r: any) => r['Instance Type'] === type && r['Operating System'] === 'Linux' && r['Pre Installed S/W'] === 'NA') as any[];
  const prices = [...new Set(rows.map(r => Number(r.price)).filter(p => Number.isFinite(p) && p > 0))];
  return prices.length === 1 ? prices[0] : undefined;
}
export function azureHourly(data: any, region: string, type: string, spot: boolean): number | undefined {
  const rows = (data?.Items ?? []).filter((r: any) => r.armRegionName === region && r.armSkuName === type && r.currencyCode === 'USD' && r.type === 'Consumption' && r.unitOfMeasure === '1 Hour' && r.isPrimaryMeterRegion === true && !/Windows/i.test(r.productName) && !/Low Priority/i.test(r.meterName) && /Spot/i.test(r.meterName) === spot && Number.isFinite(r.retailPrice) && r.retailPrice > 0);
  const prices = [...new Set<number>(rows.map((r: any) => r.retailPrice))];
  return prices.length === 1 ? prices[0] : undefined;
}
export async function priceNode(node: any, settings: ClusterSettings, readJson = publicJson): Promise<NodePrice> {
  const facts = nodeFacts(node), cpuRate = settings.estimatedCpuHourlyCost, memoryRate = settings.estimatedMemoryHourlyCost;
  const fallback = facts.cpu * cpuRate + facts.memoryGiB * memoryRate;
  let hourly = settings.estimatedNodeHourlyCost || fallback, source = settings.estimatedNodeHourlyCost ? 'Configured node rate' : 'Configured CPU/RAM fallback rates', fetchedAt: number | undefined;
  if (!settings.estimatedNodeHourlyCost && settings.estimatePublicPrices && facts.instanceType && facts.region && /^[a-zA-Z0-9._-]+$/.test(facts.instanceType) && /^[a-zA-Z0-9-]+$/.test(facts.region) && (node.metadata?.labels?.['kubernetes.io/os'] ?? node.status?.nodeInfo?.operatingSystem) !== 'windows') {
    try {
      let price: number | undefined;
      if (facts.cloud === 'AWS') {
        const locations = await readJson('https://b0.p.awsstatic.com/locations/1.0/aws/current/locations.json');
        const location = Object.values(locations).find((l: any) => l.code === facts.region && l.type === 'AWS Region') as any;
        if (typeof location?.name === 'string') price = awsHourly(await readJson(`https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/${encodeURIComponent(location.name)}/Linux/index.json`), location.name, facts.instanceType);
        if (price !== undefined) source = facts.spot ? 'AWS Linux on-demand reference (spot price unavailable)' : 'AWS Linux on-demand list price';
      } else if (facts.cloud === 'Azure') {
        const filter = `serviceName eq 'Virtual Machines' and armRegionName eq '${facts.region}' and armSkuName eq '${facts.instanceType}' and priceType eq 'Consumption'`;
        price = azureHourly(await readJson(`https://prices.azure.com/api/retail/prices?${new URLSearchParams({ '$filter': filter, currencyCode: 'USD', 'api-version': '2023-01-01-preview' })}`), facts.region, facts.instanceType, facts.spot);
        if (price !== undefined) source = facts.spot ? 'Azure Linux spot retail price' : 'Azure Linux retail price';
      }
      if (price !== undefined) { hourly = price; fetchedAt = Date.now(); }
    } catch { /* Offline or unsupported prices keep the explicitly labelled fallback. */ }
  }
  // Divide the complete machine price using the user's CPU/RAM cost weights; preserve the machine total.
  const factor = fallback > 0 ? hourly / fallback : 1;
  return { ...facts, hourly, cpuHourly: cpuRate * factor, memoryHourly: memoryRate * factor, source, fetchedAt };
}
