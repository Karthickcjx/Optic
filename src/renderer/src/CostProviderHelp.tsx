import type { ClusterSettings } from '../../shared/cluster-settings';
export function CostProviderHelp({ value, onChange }: { value: ClusterSettings; onChange: (enabled: boolean) => void }) {
  return <fieldset><legend>Storage, network, GPU and historical pricing</legend>
    <p>Select OpenCost or Kubecost above for resource allocations priced by the provider. CPU/RAM Estimate mode does not include those charges.</p>
    <label><input type="checkbox" checked={value.costPriceHistory} onChange={e => onChange(e.target.checked)}/>Read retained provider price history from Prometheus</label>
    <p>Choose a cluster-scoped Prometheus service under Metrics and scrape the cost exporter. Price history shows recorded CPU, memory, GPU and volume rates; it cannot recreate prices before collection began. The history display does not change allocation totals.</p>
    <details><summary>GCP pricing setup</summary><ol>
      <li>Deploy OpenCost in the GKE cluster, then configure its GCP pricing integration and service-account permissions on the cluster.</li>
      <li>Configure the OpenCost service namespace, name and port here. Optic accesses it through your Kubernetes API credentials.</li>
      <li>Scrape OpenCost's metrics endpoint with Prometheus to retain price changes. Keep exporter currency in USD for the price-metric view.</li>
      <li>Check OpenCost pricing status before trusting allocations. Provider custom/fallback prices may still be used when GCP pricing access fails.</li>
    </ol><p>Provider configuration: https://opencost.io/docs/configuration/gcp/</p><p>Cloud billing exports are configured on the provider, not pasted into Optic. Network costs need classified egress telemetry, storage costs need PV prices, and GPUs need allocation and device pricing data. Raw network byte counters alone are not billed egress.</p></details>
  </fieldset>;
}
