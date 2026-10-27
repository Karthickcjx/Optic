import { useEffect, useRef, useState } from 'react';
import { Shield, RefreshCw, X } from 'lucide-react';
import { severities, type SecurityDetail, type SecurityReport, type SecuritySnapshot, type Severity } from '../../shared/security';
import { resourceKind } from '../../shared/relationships';
import { catalog } from '../../shared/catalog';
import { useStore } from './store';
import { useResources } from './hooks';
import { request } from './api';

const label = (type: string) => type === 'vulnerabilityreports' ? 'Image vulnerabilities' : 'Configuration audit';
const stamp = (value?: string) => value ? new Date(value).toLocaleString() : 'Scan time unavailable';
const total = (report: SecurityReport) => Object.values(report.counts).reduce((a, b) => a + b, 0);
export function SecurityDashboard() {
  const store = useStore(), clusterId = store.clusterId;
  const allowed = store.clusterSettings[clusterId]?.accessibleNamespaces ?? [];
  const namespace = store.namespace || allowed[0] || '';
  const namespaces = useResources(allowed.length ? '' : clusterId, 'namespaces');
  const [data, setData] = useState<SecuritySnapshot>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0), [automatic, setAutomatic] = useState(true);
  const [search, setSearch] = useState(''), [type, setType] = useState('all'), [severity, setSeverity] = useState<Severity | 'all'>('all'), [page, setPage] = useState(0);
  const [selected, setSelected] = useState<SecurityReport>();
  const [namespaceInput, setNamespaceInput] = useState('');
  useEffect(() => { setData(undefined); setSelected(undefined); setPage(0); }, [clusterId, namespace]);
  useEffect(() => {
    let active = true, running = false;
    const load = async () => {
      if (running) return;
      running = true; setBusy(true);
      try { const next = await request('security:reports', { clusterId, namespace: namespace || undefined }); if (active) { setData(next); setError(''); } }
      catch (e) { if (active) setError((e as Error).message); }
      finally { running = false; if (active) setBusy(false); }
    };
    void load();
    const timer = automatic ? setInterval(() => { if (!document.hidden) void load(); }, 60000) : undefined;
    return () => { active = false; clearInterval(timer); };
  }, [clusterId, namespace, revision, automatic]);
  const reports = data?.sources.flatMap(s => s.reports) ?? [];
  const filtered = reports.filter(r => (type === 'all' || r.type === type) && (severity === 'all' || r.counts[severity] > 0) && `${r.name} ${r.namespace} ${r.owner?.name ?? ''} ${r.container} ${r.image}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => b.counts.CRITICAL - a.counts.CRITICAL || b.counts.HIGH - a.counts.HIGH || total(b) - total(a) || a.name.localeCompare(b.name));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 50) - 1));
  const hasCounts = filtered.some(r => r.summaryAvailable);
  const counts = Object.fromEntries(severities.map(s => [s, filtered.reduce((n, r) => n + r.counts[s], 0)]));
  return <section className="security-page"><header><h1><Shield size={24}/>Security</h1><button onClick={() => store.navigate('helm-charts')}>Manage scanner in Helm</button></header>
    <p className="muted">Trivy Operator reports from this cluster. Scans run in the cluster; Optic reads the latest results. Findings count per report, so an image used by several workloads can appear more than once.</p>
    <details className="security-setup"><summary>Scanner setup and access</summary><p>Install the <code>trivy-operator</code> chart from the Aqua repository <code>https://aquasecurity.github.io/helm-charts/</code> using Helm Charts. Review its version, values and permissions before applying. Existing installations are discovered automatically.</p><p>The selected kubeconfig needs <code>list</code> and <code>get</code> permissions on <code>vulnerabilityreports</code> and <code>configauditreports</code> in <code>aquasecurity.github.io</code>. Choose a namespace when cluster-wide listing is restricted. Refresh reads reports; it does not trigger a new scan.</p></details>
    <div className="security-toolbar"><label>Namespace<select aria-label="Security namespace" value={namespace} onChange={e => store.setNamespace(e.target.value)}>{!allowed.length && <option value="">All namespaces</option>}{[...new Set([...allowed, ...namespaces.items.map(n => n.metadata.name!), ...(namespace ? [namespace] : [])])].map(n => <option key={n}>{n}</option>)}</select></label>
      <label>Report type<select aria-label="Security report type" value={type} onChange={e => { setType(e.target.value); setPage(0); }}><option value="all">All reports</option><option value="vulnerabilityreports">Image vulnerabilities</option><option value="configauditreports">Configuration audit</option></select></label>
      <label>Severity<select aria-label="Security severity" value={severity} onChange={e => { setSeverity(e.target.value as typeof severity); setPage(0); }}><option value="all">All severities</option>{severities.map(s => <option key={s}>{s}</option>)}</select></label>
      <input aria-label="Search security reports" placeholder="Search image, workload or report" value={search} onChange={e => { setSearch(e.target.value); setPage(0); }}/><button disabled={busy} onClick={() => setRevision(v => v + 1)}><RefreshCw size={14}/>Refresh reports</button><label className="check-row"><input type="checkbox" checked={automatic} onChange={e => setAutomatic(e.target.checked)}/>Refresh every minute</label></div>
    {namespaces.error && <><p className="inline-error">Namespace discovery: {namespaces.error}</p>{!allowed.length && <form className="security-toolbar" onSubmit={e => { e.preventDefault(); if (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(namespaceInput) && namespaceInput.length <= 63) store.setNamespace(namespaceInput); }}><input aria-label="Permitted namespace" placeholder="Enter a permitted namespace" value={namespaceInput} onChange={e => setNamespaceInput(e.target.value)} required maxLength={63} pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"/><button type="submit">Use namespace</button></form>}</>}
    {error && <p role="alert" className="inline-error">{error} Previous reports may be stale.</p>}
    {data?.sources.map(s => <div key={s.type} className={s.state === 'ready' && !s.truncated ? 'muted' : 'inline-error'}>{label(s.type)}: {s.state === 'ready' ? `${s.reports.length} reports` : s.message}{s.truncated && ' Results are incomplete; narrow the namespace or retry.'}</div>)}
    {busy && <p role="status">Reading security reports…</p>}
    <div className="security-counts">{severities.map(s => <div key={s}><span className={`security-severity severity-${s.toLowerCase()}`}>{s}</span><strong>{data ? counts[s] : '—'}</strong></div>)}</div>
    <p className="muted">Counts cover the matching reports only. Missing reports, unknown check outcomes and old scans do not establish that a workload is secure.{data && ` Last fetched: ${new Date(data.fetchedAt).toLocaleTimeString()}.`}</p>
    <div className="security-table"><table><thead><tr><th>Report / workload</th><th>Namespace</th><th>Type</th><th>Image / container</th><th>Critical</th><th>High</th><th>Total</th><th>Scanned</th></tr></thead><tbody>{filtered.slice(currentPage * 50, currentPage * 50 + 50).map(r => <tr key={`${r.type}:${r.uid}`}><td><button onClick={() => setSelected(r)}>{r.name}</button><small>{r.owner ? `${r.owner.kind} / ${r.owner.name}` : 'Owner unavailable'}</small></td><td>{r.namespace}</td><td>{label(r.type)}</td><td>{r.image || '—'}<small>{r.container}</small></td><td className={r.counts.CRITICAL ? 'severity-critical' : ''}>{r.summaryAvailable ? r.counts.CRITICAL : '—'}</td><td className={r.counts.HIGH ? 'severity-high' : ''}>{r.summaryAvailable ? r.counts.HIGH : '—'}</td><td>{r.summaryAvailable ? total(r) : 'Unavailable'}</td><td>{stamp(r.updated)}</td></tr>)}</tbody></table></div>
    {!busy && !filtered.length && <p>No matching security reports. Check scanner installation, permissions and filters; scans may still be pending.</p>}
    <footer><span>{filtered.length} reports</span><button disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Previous</button><span>Page {currentPage + 1} / {Math.max(1, Math.ceil(filtered.length / 50))}</span><button disabled={(currentPage + 1) * 50 >= filtered.length} onClick={() => setPage(currentPage + 1)}>Next</button></footer>
    {selected && <SecurityReportDialog key={`${clusterId}:${selected.uid}`} report={selected} clusterId={clusterId} onClose={() => setSelected(undefined)}/>}
  </section>;
}

function SecurityReportDialog({ report, clusterId, onClose }: { report: SecurityReport; clusterId: string; onClose: () => void }) {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [detail, setDetail] = useState<SecurityDetail>(), [error, setError] = useState(''), [revision, setRevision] = useState(0), [loading, setLoading] = useState(true);
  const [severity, setSeverity] = useState('all'), [search, setSearch] = useState(''), [fixable, setFixable] = useState(false), [page, setPage] = useState(0), [opening, setOpening] = useState(false);
  useEffect(() => {
    let active = true; setLoading(true); setError(''); setDetail(undefined);
    void request('security:detail', { clusterId, namespace: report.namespace, type: report.type, name: report.name, uid: report.uid }).then(r => { if (active) setDetail(r); }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [clusterId, report.namespace, report.type, report.name, report.uid, revision]);
  useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, [onClose]);
  const owner = detail?.owner, kind = owner && resourceKind(owner);
  const openOwner = async () => {
    if (!owner || !kind) return;
    setOpening(true); setError('');
    try {
      const resource = await request('resources:get', { clusterId, kind, name: owner.name, namespace: catalog[kind].namespaced ? report.namespace : undefined });
      if (resource.metadata.uid !== owner.uid) throw new Error('The scanned owner was deleted or replaced. Its name now refers to a different resource.');
      const store = useStore.getState();
      // A late response must not pull the user back from another tab or cluster.
      if (!mounted.current || store.clusterId !== clusterId || store.view !== 'security') return;
      store.navigate(kind, clusterId); store.setNamespace(resource.metadata.namespace ?? ''); store.select(resource);
    } catch (e) { setError((e as Error).message); } finally { setOpening(false); }
  };
  const findings = detail?.findings.filter(f => (severity === 'all' || f.severity === severity) && (!fixable || f.fixed.trim()) && `${f.id} ${f.package} ${f.title} ${f.description}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  const currentPage = Math.min(page, Math.max(0, Math.ceil(findings.length / 50) - 1));
  return <div className="modal-backdrop"><section className="security-dialog" role="dialog" aria-modal="true" aria-label="Security report details"><header><h2>{report.name}</h2><button autoFocus aria-label="Close security report" onClick={onClose}><X size={18}/></button></header>
    <p>{report.namespace} · {label(report.type)} · {stamp(detail?.updated)}</p><p>{detail?.image} {detail?.container && ` · ${detail.container}`}</p><p className="muted">Scanner: {detail?.scanner || 'Unavailable'}</p>
    <div className="security-toolbar"><button disabled={!kind || opening} onClick={() => void openOwner()}>{owner ? `Open ${owner.kind} / ${owner.name}` : 'Owner unavailable'}</button><button disabled={loading} onClick={() => setRevision(v => v + 1)}>Reload report</button></div>
    {error && <p role="alert" className="inline-error">{error}</p>}{loading && <p role="status">Loading findings…</p>}
    {detail?.truncated && <p className="inline-error">Finding details are incomplete (at most 5,000 displayed). Summary counts may exceed the visible findings.</p>}
    {detail && report.type === 'configauditreports' && <p>{detail.passed} checks passed · {detail.unknown} unknown outcomes. Passed checks are excluded from findings.</p>}
    <div className="security-toolbar"><input aria-label="Search security findings" placeholder="Search CVE, package or check" value={search} onChange={e => { setSearch(e.target.value); setPage(0); }}/><select aria-label="Finding severity" value={severity} onChange={e => { setSeverity(e.target.value); setPage(0); }}><option value="all">All severities</option>{severities.map(s => <option key={s}>{s}</option>)}</select>{report.type === 'vulnerabilityreports' && <label className="check-row"><input type="checkbox" checked={fixable} onChange={e => { setFixable(e.target.checked); setPage(0); }}/>Fix available</label>}</div>
    <div className="security-table"><table><thead><tr><th>Severity</th><th>Vulnerability / check</th><th>Package</th><th>Installed</th><th>Fixed in</th><th>Score / outcome</th></tr></thead><tbody>{findings.slice(currentPage * 50, currentPage * 50 + 50).map((f, index) => <tr key={index}><td><span className={`security-severity severity-${f.severity.toLowerCase()}`}>{f.severity}</span></td><td><strong>{f.id}</strong><div>{f.title}</div>{f.description && <details><summary>Description</summary><p className="security-description">{f.description}</p></details>}</td><td>{f.package || '—'}</td><td>{f.installed || '—'}</td><td>{f.fixed || 'Not reported'}</td><td>{f.status === 'vulnerability' ? f.score ?? '—' : f.status}</td></tr>)}</tbody></table></div>
    {detail && !findings.length && <p>No matching findings in the returned details.</p>}
    <footer><span>{findings.length} findings</span><button disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Previous</button><span>Page {currentPage + 1} / {Math.max(1, Math.ceil(findings.length / 50))}</span><button disabled={(currentPage + 1) * 50 >= findings.length} onClick={() => setPage(currentPage + 1)}>Next</button></footer>
  </section></div>;
}
