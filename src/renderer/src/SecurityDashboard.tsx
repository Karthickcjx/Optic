import { useEffect, useRef, useState } from 'react';
import { Shield, RefreshCw, X } from 'lucide-react';
import { trivyInstallCommands, clusterSecurityType, securityLabels, securityPageTypes, severities, type SecurityPage, type SecurityDetail, type SecurityReport, type SecuritySnapshot, type Severity } from '../../shared/security';
import { securityRows, securityStatistics, findingCount, type SecurityRow } from '../../shared/security-view';
import { resourceKind } from '../../shared/relationships';
import { catalog } from '../../shared/catalog';
import { useStore } from './store';
import { useResources } from './hooks';
import { request } from './api';
import { Chart } from './Chart';

const label = (type: SecurityReport['type']) => securityLabels[type];
const stamp = (value?: string) => value ? new Date(value).toLocaleString() : 'Scan time unavailable';
const pages = { overview: 'Overview', images: 'Images', resources: 'Resources', roles: 'Roles' };
const severityColors = ['#e75764', '#ec973e', '#d7c257', '#6eafcc', '#89919b'];

function SecurityDonut({ title, values, known }: { title: string; values: { name: string; value: number; color: string }[]; known: boolean }) {
  const total = values.reduce((n, v) => n + v.value, 0);
  let offset = 0;
  return <section className="security-donut"><h3>{title}</h3><div><Chart viewBox="0 0 160 160" role="img" aria-label={`${title} security chart`} samples={known ? [{ x: 80, title, values: values.map(v => `${v.name}: ${v.value}`) }] : []}>
    <circle cx="80" cy="80" r="64" fill="none" stroke="#34393d" strokeWidth="12"/>
    {known && total > 0 && values.map(v => { const start = offset; offset += v.value / total * 100; return <circle key={v.name} cx="80" cy="80" r="64" fill="none" stroke={v.color} strokeWidth="12" pathLength="100" strokeDasharray={`${v.value / total * 100} 100`} strokeDashoffset={-start} transform="rotate(-90 80 80)"/>; })}
    <text x="80" y="86" textAnchor="middle">{known ? total : '-'}</text>
  </Chart><ul>{values.map(v => <li key={v.name}><i style={{ background: v.color }}/>{v.name}<strong>{known ? v.value : '-'}</strong></li>)}</ul></div></section>;
}
function InstallInstructions({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState('');
  const command = trivyInstallCommands;
  return <div className="modal-backdrop"><section className="security-dialog security-install" role="dialog" aria-modal="true" aria-label="Install Trivy Operator"><header><h2>Install Trivy Operator</h2><button autoFocus aria-label="Close install instructions" onClick={onClose}><X size={18}/></button></header><p>The operator scans cluster workloads and publishes reports that Optic can display. Install it through Helm Charts to choose a version and review the configuration.</p><button onClick={() => useStore.getState().navigate('helm-charts')}>Open Helm Charts</button><p>Alternatively, run these commands with the intended kubeconfig context. Add <code>--version</code> with your reviewed chart version to pin the installation.</p><pre>{command}</pre><p className="muted">Reading reports needs list/get access to the aquasecurity.github.io report APIs. Refreshing this page reads results; it does not initiate a scan.</p>{error && <p role="alert">{error}</p>}<footer><button onClick={onClose}>Close</button><button className="primary" onClick={() => void request('security:copy-install', undefined).then(() => setCopied(true)).catch(() => setError('Copy unavailable. Select and copy the commands above.'))}>{copied ? 'Copied' : 'Copy commands'}</button></footer></section></div>;
}
export function SecurityDashboard({ page: mode = 'overview' }: { page?: SecurityPage }) {
  const store = useStore(), clusterId = store.clusterId;
  const allowed = store.clusterSettings[clusterId]?.accessibleNamespaces ?? [];
  const namespace = store.namespace || allowed[0] || '';
  const namespaces = useResources(allowed.length ? '' : clusterId, 'namespaces');
  const imagePage = mode === 'overview' || mode === 'images', rolePage = mode === 'overview' || mode === 'roles';
  const pods = useResources(imagePage ? clusterId : '', 'pods', namespace);
  const roles = useResources(rolePage ? clusterId : '', 'roles', namespace);
  const clusterRoles = useResources(rolePage ? clusterId : '', 'clusterroles');
  const [data, setData] = useState<SecuritySnapshot>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0), [automatic, setAutomatic] = useState(true), [install, setInstall] = useState(false);
  const [search, setSearch] = useState(''), [severity, setSeverity] = useState<Severity | 'all'>('all'), [page, setPage] = useState(0);
  const [selected, setSelected] = useState<SecurityReport>(), [related, setRelated] = useState<SecurityReport[]>([]);
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
  const sources = data?.sources.filter(s => securityPageTypes[mode].includes(s.type)) ?? [];
  const rows = securityRows(mode, sources.flatMap(s => s.reports), pods.items, [...roles.items, ...clusterRoles.items]);
  const filtered = rows.filter(r => (severity === 'all' || r.counts[severity] > 0) && `${r.name} ${r.namespace} ${r.kind} ${r.reports.map(p => p.name + ' ' + p.container).join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  const secretReports = filtered.map(r => r.reports.find(p => p.type === 'exposedsecretreports')).filter((r): r is SecurityReport => !!r);
  const stats = securityStatistics(filtered), known = !!data && sources.some(s => s.state === 'ready');
  const tableRows = (mode === 'overview' ? filtered.filter(r => r.counts.CRITICAL > 0) : [...filtered]).sort((a, b) => mode === 'overview' ? (Date.parse(b.updated ?? '') || 0) - (Date.parse(a.updated ?? '') || 0) || b.counts.CRITICAL - a.counts.CRITICAL : b.counts.CRITICAL - a.counts.CRITICAL || b.counts.HIGH - a.counts.HIGH || a.name.localeCompare(b.name));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(tableRows.length / 50) - 1));
  const missing = !!data && data.sources.every(s => s.state === 'missing');
  const open = (row: SecurityRow) => { const report = row.reports.find(r => r.type === 'vulnerabilityreports') ?? row.reports[0]; if (report) { setRelated(row.reports); setSelected(report); } };
  const badges = (row: SecurityRow) => !row.scanned ? <span className="muted">Unknown</span> : <span className="security-badges">{severities.filter(s => row.counts[s] > 0).map(s => <span key={s} className={`severity-${s.toLowerCase()}`} title={s}>{s}: {row.counts[s]}</span>)}{!findingCount(row.counts) && 'None reported'}</span>;
  return <section className="security-page security-center">
    {missing && <div className="security-install-banner"><span>Enable cluster security reports by installing <strong>Trivy Operator</strong>.</span><button onClick={() => setInstall(true)}>Open install instructions</button></div>}
    <header><h1><Shield size={22}/>Security {pages[mode]}</h1><button onClick={() => setInstall(true)}>Scanner setup</button></header>
    <div className="security-toolbar"><label>Namespace<select aria-label="Security namespace" value={namespace} onChange={e => store.setNamespace(e.target.value)}>{!allowed.length && <option value="">All namespaces</option>}{[...new Set([...allowed, ...namespaces.items.map(n => n.metadata.name!), ...(namespace ? [namespace] : [])])].map(n => <option key={n}>{n}</option>)}</select></label>
      <input aria-label="Search security reports" placeholder={`Search ${pages[mode].toLowerCase()}...`} value={search} onChange={e => { setSearch(e.target.value); setPage(0); }}/>
      <select aria-label="Security severity" value={severity} onChange={e => { setSeverity(e.target.value as typeof severity); setPage(0); }}><option value="all">All severities</option>{severities.map(s => <option key={s}>{s}</option>)}</select>
      <button disabled={busy} onClick={() => { setRevision(v => v + 1); pods.refresh(); roles.refresh(); clusterRoles.refresh(); }}><RefreshCw size={14}/>Refresh reports</button><label className="check-row"><input type="checkbox" checked={automatic} onChange={e => setAutomatic(e.target.checked)}/>Auto refresh</label></div>
    {namespaces.error && <><p className="inline-error">Namespace discovery: {namespaces.error}</p>{!allowed.length && <form className="security-toolbar" onSubmit={e => { e.preventDefault(); if (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(namespaceInput) && namespaceInput.length <= 63) store.setNamespace(namespaceInput); }}><input aria-label="Permitted namespace" placeholder="Enter a permitted namespace" value={namespaceInput} onChange={e => setNamespaceInput(e.target.value)} required maxLength={63} pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"/><button type="submit">Use namespace</button></form>}</>}
    {error && <p role="alert" className="inline-error">{error} Previous reports may be stale.</p>}
    {sources.filter(s => !missing && (s.state !== 'ready' || s.truncated)).map(s => <p key={s.type} className="inline-error">{label(s.type)}: {s.message}{s.truncated && ' Results are incomplete; narrow the namespace or retry.'}</p>)}
    {[['Images', pods.error], ['Roles', roles.error], ['ClusterRoles', clusterRoles.error]].filter(([, e]) => e).map(([name, e]) => <p key={name} className="inline-error">{name} inventory: {e} Coverage is incomplete.</p>)}
    {busy && <p role="status">Reading security reports...</p>}
    <div className={`security-overview-charts ${mode === 'images' ? 'with-secret-chart' : ''}`}>
      <SecurityDonut title="Status" known={known} values={[{ name: 'Scanned', value: stats.scanned, color: '#4ba875' }, { name: 'No usable scan', value: stats.unknown, color: '#7d8791' }]}/>
      <SecurityDonut title="Results" known={known} values={[{ name: 'With findings', value: stats.withFindings, color: '#e75764' }, { name: 'None reported', value: stats.withoutFindings, color: '#4ba875' }, { name: 'Unknown', value: stats.unknown, color: '#7d8791' }]}/>
      <SecurityDonut title="Vulnerabilities" known={known && stats.scanned > 0} values={severities.map((s, i) => ({ name: s, value: stats.counts[s], color: severityColors[i] }))}/>
      {mode === 'images' && <SecurityDonut title="Exposed secrets" known={secretReports.some(r => r.summaryAvailable)} values={severities.map((s, i) => ({ name: s, value: secretReports.reduce((n, r) => n + r.counts[s], 0), color: severityColors[i] }))}/>}
    </div>
    <p className="muted security-coverage">{mode === 'images' ? 'Images are grouped by image reference; the latest vulnerability report supplies each image summary. Select an image to inspect its individual reports. Exposed secret matches are hidden.' : mode === 'roles' ? 'Role reports follow the namespace filter. ClusterRole reports remain cluster-wide.' : mode === 'resources' ? 'Configuration reports cover resources scanned by the operator; resources without reports are not included.' : 'Image summaries use the latest report per image; resource and role assessments use their own reports.'} Missing or old scans do not establish security.{data && ` Fetched ${new Date(data.fetchedAt).toLocaleTimeString()}.`}</p>
    {mode === 'overview' && <h3 className="security-table-heading">Latest critical vulnerabilities</h3>}
    <div className="security-table"><table><thead><tr><th>{mode === 'images' ? 'Image' : mode === 'roles' ? 'Role name' : 'Name'}</th>{mode !== 'images' && <th>Kind</th>}<th>Namespace</th><th>{mode === 'overview' ? 'Critical' : 'Vulnerabilities'}</th>{mode === 'images' && <th>Exposed secrets</th>}{mode !== 'overview' && <th>Status</th>}<th>Scan date</th></tr></thead><tbody>{tableRows.slice(currentPage * 50, currentPage * 50 + 50).map(r => <tr key={r.id}><td><button disabled={!r.reports.length} onClick={() => open(r)}>{r.name}</button>{mode === 'images' && <small>{r.reports.length} reports</small>}</td>{mode !== 'images' && <td>{r.kind}</td>}<td>{r.namespace || 'Cluster'}</td><td>{mode === 'overview' ? <span className="severity-critical">{r.counts.CRITICAL}</span> : badges(r)}</td>{mode === 'images' && <td>{r.secretCount ?? 'Unknown'}</td>}{mode !== 'overview' && <td>{r.scanned ? 'Scanned' : 'No usable scan'}</td>}<td>{stamp(r.updated)}</td></tr>)}</tbody></table></div>
    {!busy && !tableRows.length && <p className="security-empty">{mode === 'overview' ? 'No critical findings in the available matching reports.' : 'No matching reports or inventory.'} Check scanner installation, permissions and filters; scans may still be pending.</p>}
    <footer><span>{tableRows.length} items</span><button disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Previous</button><span>Page {currentPage + 1} / {Math.max(1, Math.ceil(tableRows.length / 50))}</span><button disabled={(currentPage + 1) * 50 >= tableRows.length} onClick={() => setPage(currentPage + 1)}>Next</button></footer>
    {selected && <SecurityReportDialog key={`${clusterId}:${selected.uid}`} report={selected} related={related} onReport={setSelected} clusterId={clusterId} onClose={() => setSelected(undefined)}/>}
    {install && <InstallInstructions onClose={() => setInstall(false)}/>}
  </section>;
}

function SecurityReportDialog({ report, related, onReport, clusterId, onClose }: { report: SecurityReport; related: SecurityReport[]; onReport: (report: SecurityReport) => void; clusterId: string; onClose: () => void }) {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [detail, setDetail] = useState<SecurityDetail>(), [error, setError] = useState(''), [revision, setRevision] = useState(0), [loading, setLoading] = useState(true);
  const [severity, setSeverity] = useState('all'), [search, setSearch] = useState(''), [fixable, setFixable] = useState(false), [page, setPage] = useState(0), [opening, setOpening] = useState(false);
  useEffect(() => {
    let active = true; setLoading(true); setError(''); setDetail(undefined);
    void request('security:detail', { clusterId, namespace: clusterSecurityType(report.type) ? undefined : report.namespace, type: report.type, name: report.name, uid: report.uid }).then(r => { if (active) setDetail(r); }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
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
      if (!mounted.current || store.clusterId !== clusterId || !['security', 'security-images', 'security-resources', 'security-roles'].includes(store.view)) return;
      store.navigate(kind, clusterId); store.setNamespace(resource.metadata.namespace ?? ''); store.select(resource);
    } catch (e) { setError((e as Error).message); } finally { setOpening(false); }
  };
  const findings = detail?.findings.filter(f => (severity === 'all' || f.severity === severity) && (!fixable || f.fixed.trim()) && `${f.id} ${f.package} ${f.title} ${f.description}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  const currentPage = Math.min(page, Math.max(0, Math.ceil(findings.length / 50) - 1));
  return <div className="modal-backdrop"><section className="security-dialog" role="dialog" aria-modal="true" aria-label="Security report details"><header><h2>{report.name}</h2><button autoFocus aria-label="Close security report" onClick={onClose}><X size={18}/></button></header>
    {related.length > 1 && <label>Scan report<select aria-label="Image scan report" value={report.uid} onChange={e => { const next = related.find(r => r.uid === e.target.value); if (next) onReport(next); }}>{related.map(r => <option key={r.uid} value={r.uid}>{label(r.type)} / {r.namespace || 'Cluster'} / {r.name}</option>)}</select></label>}
    <p>{report.namespace || 'Cluster'} · {label(report.type)} · {stamp(detail?.updated)}</p><p>{detail?.image} {detail?.container && ` · ${detail.container}`}</p><p className="muted">Scanner: {detail?.scanner || 'Unavailable'}</p>
    <div className="security-toolbar"><button disabled={!kind || opening} onClick={() => void openOwner()}>{owner ? `Open ${owner.kind} / ${owner.name}` : 'Owner unavailable'}</button><button disabled={loading} onClick={() => setRevision(v => v + 1)}>Reload report</button></div>
    {error && <p role="alert" className="inline-error">{error}</p>}{loading && <p role="status">Loading findings…</p>}
    {detail?.truncated && <p className="inline-error">Finding details are incomplete (at most 5,000 displayed). Summary counts may exceed the visible findings.</p>}
    {detail && !['vulnerabilityreports', 'exposedsecretreports'].includes(report.type) && <p>{detail.passed} checks passed · {detail.unknown} unknown outcomes. Passed checks are excluded from findings.</p>}
    <div className="security-toolbar"><input aria-label="Search security findings" placeholder="Search CVE, package or check" value={search} onChange={e => { setSearch(e.target.value); setPage(0); }}/><select aria-label="Finding severity" value={severity} onChange={e => { setSeverity(e.target.value); setPage(0); }}><option value="all">All severities</option>{severities.map(s => <option key={s}>{s}</option>)}</select>{report.type === 'vulnerabilityreports' && <label className="check-row"><input type="checkbox" checked={fixable} onChange={e => { setFixable(e.target.checked); setPage(0); }}/>Fix available</label>}</div>
    <div className="security-table"><table><thead><tr><th>Severity</th><th>Vulnerability / check</th><th>Package</th><th>Installed</th><th>Fixed in</th><th>Score / outcome</th></tr></thead><tbody>{findings.slice(currentPage * 50, currentPage * 50 + 50).map((f, index) => <tr key={index}><td><span className={`security-severity severity-${f.severity.toLowerCase()}`}>{f.severity}</span></td><td><strong>{f.id}</strong><div>{f.title}</div>{f.description && <details><summary>Description</summary><p className="security-description">{f.description}</p></details>}</td><td>{f.package || '—'}</td><td>{f.installed || '—'}</td><td>{f.fixed || 'Not reported'}</td><td>{f.status === 'vulnerability' ? f.score ?? '—' : f.status}</td></tr>)}</tbody></table></div>
    {detail && !findings.length && <p>No matching findings in the returned details.</p>}
    <footer><span>{findings.length} findings</span><button disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Previous</button><span>Page {currentPage + 1} / {Math.max(1, Math.ceil(findings.length / 50))}</span><button disabled={(currentPage + 1) * 50 >= findings.length} onClick={() => setPage(currentPage + 1)}>Next</button></footer>
  </section></div>;
}
