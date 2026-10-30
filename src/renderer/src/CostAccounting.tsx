import { useState } from 'react';
import { availableCostComponents, componentSummary, costComponents, costLabels, effectiveRate, rateUnits, type CostAllocation, type CostComponent, type CostReport } from '../../shared/cost';
import { Chart } from './Chart';

const value = (n: number | undefined) => n === undefined ? 'Unavailable' : n.toLocaleString(undefined, { maximumFractionDigits: 6 });
export function AllocationAccounting({ allocation, currency, components = [...costComponents] }: { allocation: CostAllocation; currency: string; components?: CostComponent[] }) {
  return <div className="cost-accounting-detail"><h3>Resource usage and charges</h3><div className="cost-table"><table><thead><tr><th>Resource</th><th>Allocated quantity</th><th>Cost ({currency})</th></tr></thead><tbody>
    {(['cpu', 'memory', 'gpu', 'storage'] as const).map((key, i) => components.includes(key) && <tr key={key}><td>{costLabels[key]}</td><td>{value(allocation.usage?.[(['cpuCoreHours', 'memoryGiBHours', 'gpuHours', 'storageGiBHours'] as const)[i]])} {rateUnits[key]}s</td><td>{value(allocation.components[key])}</td></tr>)}
    {components.includes('network') && <tr><td>Network</td><td>{value(allocation.usage?.networkGiB)} GiB transferred</td><td>{value(allocation.components.network)}</td></tr>}
  </tbody></table></div>{components.includes('network') && allocation.network && <p className="muted">Network breakdown: zone {value(allocation.network?.zone)}, region {value(allocation.network?.region)}, internet {value(allocation.network?.internet)} ({currency}). These amounts are already part of network cost; adjustments may differ.</p>}</div>;
}

export function CostAccounting({ report }: { report: CostReport }) {
  const components = availableCostComponents(report);
  const [chosenComponent, setComponent] = useState<CostComponent>('cpu');
  const component = components.includes(chosenComponent) ? chosenComponent : components[0] ?? 'cpu';
  const rates = (Object.keys(rateUnits) as (keyof typeof rateUnits)[]).filter(key => components.includes(key));
  const [chosenRate, setRate] = useState<keyof typeof rateUnits>('cpu');
  const rate = rates.includes(chosenRate) ? chosenRate : rates[0] ?? 'cpu';
  const [page, setPage] = useState(0);
  const points = report.buckets.map(b => ({ ...b, summary: componentSummary(b.allocations, component), rate: effectiveRate(b.allocations.filter(a => !a.name.includes('__idle__')), rate) }));
  const max = Math.max(0.01, ...points.map(p => Math.abs(p.summary.total ?? 0)));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(points.length / 24) - 1));
  const missing = points.filter(p => p.summary.reported < p.summary.count).length;
  return <section className="cost-accounting" aria-label="Detailed cost accounting">
    <h2>Resource cost breakdown</h2>
    <div className="cost-accounting-cards">{components.map(key => {
      const summary = componentSummary(report.allocations, key);
      return <article key={key}><span>{costLabels[key]}</span><strong>{value(summary.total)}</strong><small>{report.currency} · {summary.reported}/{summary.count} allocations reported{summary.reported && summary.reported < summary.count ? ' · partial' : ''}</small></article>;
    })}</div>
    {report.estimated && <p className="muted">CPU/RAM estimate only. For storage, network, GPU and provider-priced history (including GCP), select OpenCost or Kubecost in Cluster Settings → Cost and configure that provider's pricing and telemetry. No cloud credentials are stored in this dashboard.</p>}
    {!!components.length && <><div className="cost-controls"><label>Chart component<select aria-label="Cost chart component" value={component} onChange={e => setComponent(e.target.value as CostComponent)}>{components.map(key => <option key={key} value={key}>{costLabels[key]}</option>)}</select></label></div>
    <Chart className="cost-timeline" viewBox="0 0 900 220" role="img" aria-label="Component cost timeline" samples={points.map(p => ({ x: 65 + ((p.start + p.end) / 2 - report.start) / (report.end - report.start) * 815, title: new Date(p.start).toLocaleString(), values: [`${costLabels[component]}: ${value(p.summary.total)} ${report.currency}`, `${p.summary.reported}/${p.summary.count} allocations reported`] }))}>
      <line x1="65" x2="880" y1="105" y2="105" stroke="#58616a"/>
      {[-1, 0, 1].map(t => <text key={t} x="60" y={109 - t * 75} textAnchor="end" className="chart-axis">{value(max * t)}</text>)}
      {points.filter(p => p.summary.total !== undefined).map(p => <rect key={p.start} x={65 + (p.start - report.start) / (report.end - report.start) * 815} y={p.summary.total! >= 0 ? 105 - Math.abs(p.summary.total!) / max * 75 : 105} width={Math.max(1, (p.end - p.start) / (report.end - report.start) * 815 - 2)} height={Math.max(1, Math.abs(p.summary.total!) / max * 75)} fill={p.summary.reported < p.summary.count ? '#ca9b50' : '#429ccc'}/>)}
      {[0, .5, 1].map(t => <text key={t} x={65 + t * 815} y="205" textAnchor={t === 0 ? 'start' : t === 1 ? 'end' : 'middle'} className="chart-axis">{new Date(report.start + t * (report.end - report.start)).toLocaleString()}</text>)}
    </Chart>
    <p className="muted">{missing ? `${missing} intervals have missing component fields. Amber bars are partial sums.` : 'Components are shown as reported by the source.'} Missing intervals are not drawn as zero.</p></>}
    {!report.estimated && !!rates.length && <><h3>Historical effective rates</h3><p className="muted">Interval cost divided by allocated units, excluding idle allocations. These are blended effective rates, not cloud price-list changes. Missing cost or quantity suppresses the rate; credits can produce negative rates.</p>
    <label>Rate resource<select aria-label="Historical rate resource" value={rate} onChange={e => setRate(e.target.value as keyof typeof rateUnits)}>{Object.keys(rateUnits).filter(key => components.includes(key as CostComponent)).map(key => <option key={key} value={key}>{costLabels[key as CostComponent]}</option>)}</select></label>
    <div className="cost-table"><table><thead><tr><th>Interval start</th><th>Interval end</th><th>{report.currency}/{rateUnits[rate]}</th><th>Change from previous interval</th></tr></thead><tbody>{points.slice(currentPage * 24, (currentPage + 1) * 24).map((p, i) => {
      const previous = points[currentPage * 24 + i - 1];
      const change = p.rate !== undefined && previous?.rate !== undefined && previous.end === p.start ? p.rate - previous.rate : undefined;
      return <tr key={p.start}><td>{new Date(p.start).toLocaleString()}</td><td>{new Date(p.end).toLocaleString()}</td><td>{value(p.rate)}</td><td>{value(change)}</td></tr>;
    })}</tbody></table></div>
    {!points.length && <p>No dated intervals available.</p>}<div className="pagination"><button disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Earlier rates</button><span>{currentPage + 1} / {Math.max(1, Math.ceil(points.length / 24))}</span><button disabled={(currentPage + 1) * 24 >= points.length} onClick={() => setPage(currentPage + 1)}>Later rates</button></div>
    {!!report.priceHistory?.length && <ProviderPriceHistory report={report}/>}</>}
  </section>;
}

function ProviderPriceHistory({ report }: { report: CostReport }) {
  const [selected, setSelected] = useState(0), [page, setPage] = useState(0);
  const history = report.priceHistory ?? [], series = history[selected];
  const current = Math.min(page, Math.max(0, Math.ceil((series?.samples.length ?? 0) / 24) - 1));
  return <div><h3>Recorded provider prices</h3><p className="muted">Actual exported rate samples, separate from blended effective rates above. Enable price history in Cluster Settings → Cost. Rates reflect provider configuration, including custom/fallback prices; they are not invoice verification. Sampling can miss changes between observations.</p>
    {!history.length ? <p>No recorded provider prices loaded.</p> : <><label>Priced resource<select aria-label="Priced resource" value={selected} onChange={e => { setSelected(Number(e.target.value)); setPage(0); }}>{history.map((row, i) => <option key={i} value={i}>{row.cloud} · {row.cluster ? `${row.cluster}/` : ''}{row.identity} · {costLabels[row.resource]}</option>)}</select></label>
    <div className="cost-table"><table><thead><tr><th>Observed at</th><th>Price ({series.unit})</th><th>Change since preceding sample</th></tr></thead><tbody>{series.samples.slice(current * 24, (current + 1) * 24).map((sample, i) => {
      const previous = series.samples[current * 24 + i - 1];
      return <tr key={sample.time}><td>{new Date(sample.time).toLocaleString()}</td><td>{value(sample.price)}</td><td>{value(previous ? sample.price - previous.price : undefined)}</td></tr>;
    })}</tbody></table></div><div className="pagination"><button disabled={!current} onClick={() => setPage(current - 1)}>Previous prices</button><span>{current + 1} / {Math.max(1, Math.ceil(series.samples.length / 24))}</span><button disabled={(current + 1) * 24 >= series.samples.length} onClick={() => setPage(current + 1)}>Next prices</button></div></>}
  </div>;
}
