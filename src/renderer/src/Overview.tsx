import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Cpu, MemoryStick, Box, RefreshCw } from 'lucide-react';
import { useResources } from './hooks';
import { request } from './api';
import { useStore } from './store';
import { quantity, memory } from '../../shared/quantities';
import { selectNodes, scopedUsage } from '../../shared/metrics';
import type { Resource } from '../../shared/protocol';
import { resourceStatus } from '../../shared/status';
import type { Requests } from '../../shared/protocol';

function Gauge({ label, used, capacity, requests, limits, format, available }: { label: string; used: number; capacity: number; requests?: number; limits?: number; format: (n: number) => string; available: boolean }) {
  const values = [used, requests, limits].filter(v => v !== undefined) as number[];
  return <div className="gauge"><h3>{label}</h3><svg viewBox="0 0 130 130" role="img" aria-label={`${label}: ${available ? format(used) : 'unavailable'} used`}>
    {values.map((v, i) => <g key={i}><circle cx="65" cy="65" r={49 - i * 8} fill="none" stroke="#34383c" strokeWidth="5"/><circle cx="65" cy="65" r={49 - i * 8} fill="none" stroke={['#b45bd0', '#51ac60', '#469bd0'][i]} strokeWidth="5" pathLength="100" strokeDasharray={`${capacity ? Math.min(100, 100 * v / capacity) : 0} 100`} transform="rotate(-90 65 65)"/></g>)}
    <text x="65" y="69" textAnchor="middle">{available && capacity ? `${Math.round(100 * used / capacity)}%` : '—'}</text></svg>
    <ul><li><i style={{ background: '#b45bd0' }}/>Usage: {available ? format(used) : 'Unavailable'}</li>{requests !== undefined && <li><i style={{ background: '#51ac60' }}/>Requests: {format(requests)}</li>}{limits !== undefined && <li><i style={{ background: '#469bd0' }}/>Limits: {format(limits)}</li>}<li><i/>Allocatable: {format(capacity)}</li></ul>
  </div>;
}
export function Overview() {
  const clusterId = useStore(s => s.clusterId), navigate = useStore(s => s.navigate);
  const settings = useStore(s => s.clusterSettings[clusterId]);
  const metricsHidden = settings?.hiddenMetrics.includes('Cluster') || settings?.metricsSource === 'none';
  const nodes = useResources(clusterId, 'nodes'), pods = useResources(clusterId, 'pods'), events = useResources(clusterId, 'events');
  const [metrics, setMetrics] = useState<Requests['metrics:read']['output']>({ nodes: [], pods: [] });
  const [history, setHistory] = useState<{ time: number; nodes: Resource[] }[]>([]);
  const [scope, setScope] = useState('all'), [windowMinutes, setWindowMinutes] = useState(15), [percent, setPercent] = useState(false);
  const [mode, setMode] = useState<'cpu' | 'memory'>('cpu'); const [refresh, setRefresh] = useState(0);
  useEffect(() => { setHistory([]); setScope('all'); setMetrics({ nodes: [], pods: [] }); }, [clusterId, metricsHidden]);
  useEffect(() => {
    let active = true, running = false;
    const poll = async () => { if (running) return; running = true; try { const data = await request('metrics:read', { clusterId }); if (active) { setMetrics(data); if (data.nodes.length) setHistory(old => [...old, { time: Date.now(), nodes: data.nodes }].filter(sample => sample.time >= Date.now() - 3600000).slice(-500)); } } catch (e) { if (active) setMetrics(old => ({ ...old, warning: (e as Error).message })); } finally { running = false; } };
    if (metricsHidden) return;
    void poll(); const timer = setInterval(poll, 15000); return () => { active = false; clearInterval(timer); };
  }, [clusterId, refresh, metricsHidden]);
  const selectedNodes = selectNodes(nodes.items, scope);
  const selectedNames = new Set(selectedNodes.map(n => n.metadata.name));
  const selectedPods = pods.items.filter(p => scope === 'all' || selectedNames.has(p.spec?.nodeName));
  const usage = scopedUsage(metrics.nodes, selectedNodes, scope === 'all');
  const cpuCapacity = selectedNodes.reduce((n, r) => n + quantity(r.status?.allocatable?.cpu), 0);
  const memCapacity = selectedNodes.reduce((n, r) => n + quantity(r.status?.allocatable?.memory), 0);
  const podCapacity = selectedNodes.reduce((n, r) => n + quantity(r.status?.allocatable?.pods), 0);
  const usageCpu = usage.cpu, usageMem = usage.memory;
  const containers = selectedPods.filter(p => !['Succeeded', 'Failed'].includes(p.status?.phase)).flatMap(p => p.spec?.containers ?? []);
  const sum = (field: string, key: string) => containers.reduce((n: number, c: any) => n + quantity(c.resources?.[field]?.[key]), 0);
  const problems = pods.items.filter(p => /Crash|Error|Failed|BackOff|Pending/.test(resourceStatus(p)));
  const end = history.at(-1)?.time ?? Date.now(), start = end - windowMinutes * 60000;
  const capacity = mode === 'cpu' ? cpuCapacity : memCapacity;
  const series = history.filter(sample => sample.time >= start).map(sample => ({ time: sample.time, ...scopedUsage(sample.nodes, selectedNodes, scope === 'all') })).filter(sample => sample.available).map(sample => ({ time: sample.time, value: percent ? (capacity ? sample[mode] / capacity * 100 : 0) : sample[mode] }));
  const max = Math.max(...series.map(p => p.value), percent ? 100 : capacity, 1);
  const x = (time: number) => 60 + (time - start) / (end - start) * 530;
  const y = (value: number) => 180 - value / max * 160;
  const points = series.map(p => `${x(p.time)},${y(p.value)}`).join(' ');
  const formatValue = (value: number) => percent ? `${value.toFixed(1)}%` : mode === 'cpu' ? `${value.toFixed(2)} cores` : memory(value);
  const timeLabel = (time: number) => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const warningEvents = events.items.filter(e => e.type === 'Warning').slice(-6).reverse();
  return <div className="overview-page"><div className="overview-toolbar"><select aria-label="Monitor nodes" value={scope} onChange={e => setScope(e.target.value)}><option value="all">All nodes</option><option value="masters">Control-plane / Master nodes</option><option value="workers">Worker nodes</option>{nodes.items.map(node => <option key={node.metadata.name} value={`node:${node.metadata.name}`}>{node.metadata.name}</option>)}</select><select aria-label="Metrics time range" value={windowMinutes} onChange={e => setWindowMinutes(Number(e.target.value))}><option value={5}>5 minutes</option><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>1 hour</option></select><button aria-pressed={percent} onClick={() => setPercent(v => !v)}> {percent ? '% of allocatable' : 'Absolute units'}</button><span className="muted">Live samples · 15s</span><button className={mode === 'cpu' ? 'active' : ''} onClick={() => setMode('cpu')}><Cpu size={15}/>CPU</button><button className={mode === 'memory' ? 'active' : ''} onClick={() => setMode('memory')}><MemoryStick size={15}/>Memory</button><button title="Refresh overview" onClick={() => { nodes.refresh(); pods.refresh(); events.refresh(); setRefresh(v => v + 1); }}><RefreshCw size={14}/></button></div>
    {(nodes.error || pods.error) && <div className="inline-error">{nodes.error || pods.error}</div>}
    {!metricsHidden && <div className="metrics-grid"><div className="history-chart"><h3>{percent ? `${mode === 'cpu' ? 'CPU' : 'Memory'} usage (% of allocatable)` : mode === 'cpu' ? 'CPU usage (cores)' : 'Memory usage'}</h3><svg viewBox="0 0 620 215" role="img" aria-label="Live usage history">{[0, 1, 2, 3, 4].map(i => <g key={i}><line x1="60" x2="590" y1={20 + i * 40} y2={20 + i * 40} stroke="#35393d"/><text x="54" y={24 + i * 40} textAnchor="end" className="chart-axis">{formatValue(max * (4 - i) / 4)}</text></g>)}{[0, 1, 2, 3, 4].map(i => <text key={i} x={60 + i * 132.5} y="205" textAnchor="middle" className="chart-axis">{timeLabel(start + i * (end - start) / 4)}</text>)}{series.length > 0 && <polyline points={points} fill="none" stroke="#429ccc" strokeWidth="2"/>}{series.map((point, index) => <circle key={index} cx={x(point.time)} cy={y(point.value)} r="3" fill="#429ccc"><title>{new Date(point.time).toLocaleTimeString()}: {formatValue(point.value)}</title></circle>)}</svg><span>{history.length ? `Observed since ${new Date(history[0].time).toLocaleTimeString()}` + (history.length === 1 ? ' - first sample; next sample in 15 seconds' : '') : metrics.warning ? 'Metrics unavailable' : 'Waiting for metrics…'}</span></div><div className="gauges"><Gauge label="CPU" used={usageCpu} capacity={cpuCapacity} requests={sum('requests', 'cpu')} limits={sum('limits', 'cpu')} format={n => n.toFixed(2)} available={usage.available}/><Gauge label="MEMORY" used={usageMem} capacity={memCapacity} requests={sum('requests', 'memory')} limits={sum('limits', 'memory')} format={memory} available={usage.available}/>{!settings?.hiddenMetrics.includes('Pod') && <Gauge label="PODS" used={selectedPods.filter(p => !['Succeeded','Failed'].includes(p.status?.phase)).length} capacity={podCapacity} format={String} available={!pods.loading && !pods.error}/>}</div></div>}
    {!metricsHidden && scope !== 'all' && <p className="metrics-note">{selectedNodes.length ? usage.available ? `Monitoring ${selectedNodes.length} selected node(s).` : 'No matching per-node metrics are available. Check Prometheus node/instance labels and scrape targets.' : 'No nodes match this selection.'}</p>}
    {!metricsHidden && <p className="metrics-note">Timeline shows samples collected while this overview is open; empty time periods have no recorded samples. Percentages use current allocatable capacity.</p>}
    {metricsHidden && <p className="metrics-note">Cluster metrics are hidden or disabled in cluster settings.</p>}
    {metrics.source && <p className="metrics-note">Source: {metrics.source}</p>}
    {metrics.warning && <div className="metrics-note"><Activity size={15}/>{metrics.warning}</div>}
    <div className="overview-counts"><button onClick={() => navigate('nodes')}><Cpu size={19}/><strong>{nodes.items.length}</strong>Nodes</button><button onClick={() => navigate('pods')}><Box size={19}/><strong>{pods.items.length}</strong>Pods</button><button onClick={() => navigate('events')}><Activity size={19}/><strong>{events.items.length}</strong>Events</button></div>
    <div className="cluster-issues">{!problems.length && !warningEvents.length && !pods.loading && !pods.error && !events.error ? <div className="all-clear"><CheckCircle2 size={38}/><h3>No workload issues detected</h3><p>Pods and recent events show no warnings.</p></div> : <><h3><AlertTriangle size={17}/>Cluster observations</h3>{problems.map(p => <button key={p.metadata.uid} onClick={() => navigate('pods')}><strong>{p.metadata.name}</strong><span>{p.metadata.namespace}</span><span className="warning-text">{resourceStatus(p)}</span></button>)}{warningEvents.map(e => <div className="overview-event" key={e.metadata.uid}><b>{e.reason}</b><span>{e.message}</span></div>)}{events.error && <p className="muted">Events could not be read with this context.</p>}</>}</div>
  </div>;
}
