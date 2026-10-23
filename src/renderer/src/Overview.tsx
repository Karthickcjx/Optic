import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Cpu, MemoryStick, Box, RefreshCw } from 'lucide-react';
import { useResources } from './hooks';
import { request } from './api';
import { useStore } from './store';
import { quantity, memory } from '../../shared/quantities';
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
  const nodes = useResources(clusterId, 'nodes'), pods = useResources(clusterId, 'pods'), events = useResources(clusterId, 'events');
  const [metrics, setMetrics] = useState<Requests['metrics:read']['output']>({ nodes: [], pods: [] });
  const [history, setHistory] = useState<{ time: number; cpu: number; memory: number }[]>([]);
  const [mode, setMode] = useState<'cpu' | 'memory'>('cpu'); const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true, running = false; setHistory([]); setMetrics({ nodes: [], pods: [] });
    const poll = async () => { if (running) return; running = true; try { const data = await request('metrics:read', { clusterId }); if (active) { setMetrics(data); if (data.nodes.length) setHistory(old => [...old, { time: Date.now(), cpu: data.nodes.reduce((n, r) => n + quantity(r.usage?.cpu), 0), memory: data.nodes.reduce((n, r) => n + quantity(r.usage?.memory), 0) }].slice(-60)); } } catch (e) { if (active) setMetrics({ nodes: [], pods: [], warning: (e as Error).message }); } finally { running = false; } };
    void poll(); const timer = setInterval(poll, 15000); return () => { active = false; clearInterval(timer); };
  }, [clusterId, refresh]);
  const cpuCapacity = nodes.items.reduce((n, r) => n + quantity(r.status?.allocatable?.cpu), 0);
  const memCapacity = nodes.items.reduce((n, r) => n + quantity(r.status?.allocatable?.memory), 0);
  const podCapacity = nodes.items.reduce((n, r) => n + quantity(r.status?.allocatable?.pods), 0);
  const usageCpu = metrics.nodes.reduce((n, r) => n + quantity(r.usage?.cpu), 0), usageMem = metrics.nodes.reduce((n, r) => n + quantity(r.usage?.memory), 0);
  const containers = pods.items.filter(p => !['Succeeded', 'Failed'].includes(p.status?.phase)).flatMap(p => p.spec?.containers ?? []);
  const sum = (field: string, key: string) => containers.reduce((n: number, c: any) => n + quantity(c.resources?.[field]?.[key]), 0);
  const problems = pods.items.filter(p => /Crash|Error|Failed|BackOff|Pending/.test(resourceStatus(p)));
  const series = history.map(p => p[mode]); const max = Math.max(...series, mode === 'cpu' ? cpuCapacity : memCapacity, 1);
  const points = series.map((v, i) => `${i * 600 / Math.max(1, series.length - 1)},${180 - v / max * 160}`).join(' ');
  const warningEvents = events.items.filter(e => e.type === 'Warning').slice(-6).reverse();
  return <div className="overview-page"><div className="overview-toolbar"><span>All nodes</span><span className="muted">Live samples · 15s</span><button className={mode === 'cpu' ? 'active' : ''} onClick={() => setMode('cpu')}><Cpu size={15}/>CPU</button><button className={mode === 'memory' ? 'active' : ''} onClick={() => setMode('memory')}><MemoryStick size={15}/>Memory</button><button title="Refresh overview" onClick={() => { nodes.refresh(); pods.refresh(); events.refresh(); setRefresh(v => v + 1); }}><RefreshCw size={14}/></button></div>
    {(nodes.error || pods.error) && <div className="inline-error">{nodes.error || pods.error}</div>}
    <div className="metrics-grid"><div className="history-chart"><h3>{mode === 'cpu' ? 'CPU usage (cores)' : 'Memory usage'}</h3><svg viewBox="0 0 620 210" preserveAspectRatio="none" role="img" aria-label="Live usage history">{[20, 60, 100, 140, 180].map(y => <line key={y} x1="0" x2="600" y1={y} y2={y} stroke="#35393d"/>)}{series.length > 0 && <polyline points={points} fill="none" stroke="#429ccc" strokeWidth="3"/>}</svg><span>{history.length ? `Observed since ${new Date(history[0].time).toLocaleTimeString()}` : metrics.warning ? 'Metrics unavailable' : 'Waiting for metrics…'}</span></div><div className="gauges"><Gauge label="CPU" used={usageCpu} capacity={cpuCapacity} requests={sum('requests', 'cpu')} limits={sum('limits', 'cpu')} format={n => n.toFixed(2)} available={metrics.nodes.length > 0}/><Gauge label="MEMORY" used={usageMem} capacity={memCapacity} requests={sum('requests', 'memory')} limits={sum('limits', 'memory')} format={memory} available={metrics.nodes.length > 0}/><Gauge label="PODS" used={pods.items.filter(p => !['Succeeded','Failed'].includes(p.status?.phase)).length} capacity={podCapacity} format={String} available={!pods.loading && !pods.error}/></div></div>
    {metrics.warning && <div className="metrics-note"><Activity size={15}/>{metrics.warning}</div>}
    <div className="overview-counts"><button onClick={() => navigate('nodes')}><Cpu size={19}/><strong>{nodes.items.length}</strong>Nodes</button><button onClick={() => navigate('pods')}><Box size={19}/><strong>{pods.items.length}</strong>Pods</button><button onClick={() => navigate('events')}><Activity size={19}/><strong>{events.items.length}</strong>Events</button></div>
    <div className="cluster-issues">{!problems.length && !warningEvents.length && !pods.loading && !pods.error && !events.error ? <div className="all-clear"><CheckCircle2 size={38}/><h3>No workload issues detected</h3><p>Pods and recent events show no warnings.</p></div> : <><h3><AlertTriangle size={17}/>Cluster observations</h3>{problems.map(p => <button key={p.metadata.uid} onClick={() => navigate('pods')}><strong>{p.metadata.name}</strong><span>{p.metadata.namespace}</span><span className="warning-text">{resourceStatus(p)}</span></button>)}{warningEvents.map(e => <div className="overview-event" key={e.metadata.uid}><b>{e.reason}</b><span>{e.message}</span></div>)}{events.error && <p className="muted">Events could not be read with this context.</p>}</>}</div>
  </div>;
}
