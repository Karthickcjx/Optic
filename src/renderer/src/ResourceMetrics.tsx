import { useEffect, useState } from 'react';
import type { Resource, Target } from '../../shared/protocol';
import { emptyMetricSeries, type MetricKey, type MetricPoint, type ResourceMetricResult } from '../../shared/resource-metrics';
import { memory } from '../../shared/quantities';
import { request } from './api';

export function MetricChart({ title, series, keys, format, start, end, unavailable }: { title: string; series: ResourceMetricResult['series']; keys: MetricKey[]; format: (value: number) => string; start: number; end: number; unavailable?: string }) {
  const points = keys.flatMap(key => series[key]).filter(p => p[0] >= start && p[0] <= end);
  const maximum = Math.max(...points.map(p => p[1]), 0) * 1.1 || 1;
  const x = (t: number) => 72 + (t - start) / Math.max(1, end - start) * 332;
  const y = (v: number) => 135 - v / maximum * 110;
  return <section className="drawer-metric"><h3>{title}</h3>{!points.length ? <p className="muted">{unavailable ?? 'No samples available yet.'}</p> : <><svg viewBox="0 0 430 170" role="img" aria-label={`${title} history`}>
    {[0, .5, 1].map(ratio => <g key={ratio}><line x1="72" x2="404" y1={y(maximum * ratio)} y2={y(maximum * ratio)} stroke="#414a53"/><text x="67" y={y(maximum * ratio) + 4} textAnchor="end">{format(maximum * ratio)}</text></g>)}
    {[0, .5, 1].map(ratio => <text key={ratio} x={72 + 332 * ratio} y="158" textAnchor={ratio === 0 ? 'start' : ratio === 1 ? 'end' : 'middle'}>{new Date(start + (end - start) * ratio).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</text>)}
    {keys.map((key, index) => <g key={key} stroke={index ? '#bd85ef' : '#51b9e7'} fill={index ? '#bd85ef' : '#51b9e7'}>{series[key].filter(p => p[0] >= start && p[0] <= end).map((p, i, values) => <g key={p[0]}>{i > 0 && p[0] - values[i - 1][0] <= Math.max(45000, (end - start) / 100) && <line x1={x(values[i - 1][0])} y1={y(values[i - 1][1])} x2={x(p[0])} y2={y(p[1])}/>}<circle cx={x(p[0])} cy={y(p[1])} r="2"><title>{new Date(p[0]).toLocaleString()}: {format(p[1])}</title></circle></g>)}</g>)}
  </svg><div className="metric-legend">{keys.map((key, i) => <span key={key} style={{ color: i ? '#bd85ef' : '#51b9e7' }}>{key === 'networkRx' ? 'Receive' : key === 'networkTx' ? 'Transmit' : 'Usage'}: {series[key].length ? format(series[key].at(-1)![1]) : 'Unavailable'}</span>)}</div></>}</section>;
}
export function ResourceMetrics({ resource, target }: { resource: Resource; target: Target }) {
  const [container, setContainer] = useState(''), [minutes, setMinutes] = useState(15), [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<ResourceMetricResult>(), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true, running = false;
    setData(undefined); setError(''); setLoading(true);
    const load = async () => {
      if (running) return;
      running = true;
      try {
        const result = await request('metrics:resource', { ...target, uid: resource.metadata.uid!, container: container || undefined, minutes });
        if (!active) return;
        setError('');
        setData(old => {
          if (result.history || !old || old.history || result.source !== old.source) return result;
          const series = emptyMetricSeries();
          for (const key of Object.keys(series) as MetricKey[]) series[key] = [...old.series[key], ...result.series[key]].filter(p => p[0] >= Date.now() - minutes * 60000).slice(-250);
          return { ...result, series };
        });
      } catch (e) { if (active) setError((e as Error).message); }
      finally { running = false; if (active) setLoading(false); }
    };
    void load(); const timer = setInterval(() => void load(), 15000);
    return () => { active = false; clearInterval(timer); };
  }, [target.clusterId, target.kind, target.name, target.namespace, resource.metadata.uid, container, minutes, refresh]);
  const end = Date.now(), start = end - minutes * 60000;
  const containers = data?.containers ?? [...(resource.spec?.containers ?? []), ...(resource.spec?.initContainers ?? []), ...(resource.spec?.ephemeralContainers ?? [])].map((c: any) => c.name);
  const series = data?.series ?? emptyMetricSeries();
  const chart = (title: string, keys: MetricKey[], format: (n: number) => string) => <MetricChart title={title} keys={keys} format={format} series={series} start={start} end={end} unavailable={data?.unavailable[keys[0]]}/>;
  return <div className="resource-metrics"><div className="drawer-metric-controls"><label>Container<select aria-label="Metrics container" value={container} onChange={e => setContainer(e.target.value)}><option value="">All containers</option>{[...new Set([...containers, ...(container ? [container] : [])])].map(name => <option key={name}>{name}</option>)}</select></label><label>Time range<select aria-label="Resource metrics time range" value={minutes} onChange={e => setMinutes(Number(e.target.value))}>{[5, 15, 30, 60].map(n => <option value={n} key={n}>{n} minutes</option>)}</select></label><button onClick={() => setRefresh(v => v + 1)} disabled={loading}>Refresh metrics</button></div>
    {loading && <p role="status">Loading resource metrics…</p>}{error && <p className="inline-error" role="alert">{error}{data && Object.values(data.series).some(points => points.length) ? ' Previous samples may be stale.' : ''}</p>}
    {data && <p className="muted">Source: {data.source} · {data.podCount} Pod(s) · refreshes every 15 seconds</p>}{data?.warning && <p className="muted">{data.warning}</p>}
    {chart('CPU (cores)', ['cpu'], n => n.toFixed(3))}{chart('Memory working set', ['memory'], memory)}{chart('Network (bytes/s)', ['networkRx', 'networkTx'], n => `${n.toFixed(0)} B/s`)}{chart('Container filesystem', ['filesystem'], memory)}
  </div>;
}
