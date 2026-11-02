import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, GitBranch } from 'lucide-react';
import { applicationSet, appProject, argoActivity, argoApplication, argoAttention, argoSummary, filterActivity, filterApplications, healthStates, sortApplications, syncStates, type ArgoApplication, type ArgoFilter, type ArgoSortKey } from '../../shared/gitops';
import { request } from './api';
import { useResources } from './hooks';
import { useStore } from './store';
import { Badge, Card, Conditions, ContextMenu, Drawer, ListState, MAX_ROWS, NamespacePicker, Notice, ObjectEvents, ObjectYaml, RefreshButton, SortHeader, Stat, age, short, time, useDetection, useOpenResource, useSort, useTypeWatch } from './gitops-ui';

type Section = 'Dashboard' | 'Applications' | 'Application Sets' | 'Projects';
const ranges = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, All: 0 } as const;

export function ArgoCDPage() {
  const clusterId = useStore(s => s.clusterId), namespace = useStore(s => s.namespace), clusterName = useStore(s => s.clusters.find(c => c.id === s.clusterId)?.name ?? '');
  const [revision, setRevision] = useState(0), detection = useDetection(clusterId, revision), types = detection?.value?.types ?? {};
  const apps = useTypeWatch(clusterId, detection?.value, 'applications', namespace), sets = useTypeWatch(clusterId, detection?.value, 'applicationsets', namespace), projects = useTypeWatch(clusterId, detection?.value, 'appprojects', namespace);
  // Argo CD records Application and ApplicationSet events; one watch narrowed server-side to its API group.
  const events = useResources(types.applications ? clusterId : '', 'events', namespace, undefined, types.applications ? `involvedObject.apiVersion=${types.applications.apiVersion}` : undefined);
  const [section, setSection] = useState<Section>('Dashboard'), [filter, setFilter] = useState<ArgoFilter>({}), [sort, onSort] = useSort<ArgoSortKey>('name');
  const [selected, setSelected] = useState<{ kind: 'app' | 'set' | 'project'; namespace?: string; name: string; tab?: string }>(), [notice, setNotice] = useState(''), [menu, setMenu] = useState<{ x: number; y: number; app: ArgoApplication }>();
  const [activityFilter, setActivityFilter] = useState<{ kind?: string; namespace?: string; application?: string; type?: string; range: keyof typeof ranges }>({ range: '24h' });
  const applications = useMemo(() => apps.items.map(argoApplication), [apps.items]);
  const summary = useMemo(() => argoSummary(applications), [applications]);
  const attention = useMemo(() => argoAttention(applications), [applications]);
  const activity = useMemo(() => argoActivity(events.items, applications), [events.items, applications]);
  const projectRows = useMemo(() => projects.items.map(p => appProject(p, applications)).sort((a, b) => a.name.localeCompare(b.name)), [projects.items, applications]);
  const setRows = useMemo(() => sets.items.map(s => applicationSet(s, applications)).sort((a, b) => a.name.localeCompare(b.name)), [sets.items, applications]);
  const listed = useMemo(() => sortApplications(filterApplications(applications, filter), sort.key, sort.desc), [applications, filter, sort]);
  const controllerNamespace = applications.find(a => a.controllerNamespace)?.controllerNamespace ?? (namespace || 'argocd');
  const [argoUi, setArgoUi] = useState<string>();
  useEffect(() => { let active = true; setArgoUi(undefined); if (types.applications) request('gitops:argo-url', { clusterId, namespace: controllerNamespace }).then(r => { if (active) setArgoUi(r.url); }, () => {}); return () => { active = false; }; }, [clusterId, controllerNamespace, !!types.applications, revision]);
  const openResource = useOpenResource(clusterId, setNotice);
  // An application chosen in the command palette opens in the Applications section.
  const focus = useStore(s => s.gitopsFocus);
  useEffect(() => { if (focus?.type !== 'applications') return; setSection('Applications'); setFilter({}); setSelected({ kind: 'app', name: focus.name, namespace: focus.namespace }); useStore.getState().setGitOpsFocus(undefined); }, [focus]);
  const openArgo = (application?: { namespace: string; name: string }) => { setNotice(''); request('gitops:open-argo', { clusterId, namespace: controllerNamespace, application }).catch(e => setNotice((e as Error).message)); };
  const refresh = () => { setRevision(v => v + 1); for (const w of [apps, sets, projects, events]) w.refresh(); };
  const showApps = (f: ArgoFilter) => { setFilter(f); setSection('Applications'); setSelected(undefined); };
  const openApp = (name: string, ns?: string, tab?: string) => setSelected({ kind: 'app', name, namespace: ns, tab });
  const app = selected?.kind === 'app' ? applications.find(a => a.name === selected.name && (!selected.namespace || a.namespace === selected.namespace)) : undefined;
  const set = selected?.kind === 'set' ? setRows.find(s => s.name === selected.name && s.namespace === selected.namespace) : undefined;
  const project = selected?.kind === 'project' ? projectRows.find(p => p.name === selected.name && p.namespace === selected.namespace) : undefined;
  const activityRows = useMemo(() => filterActivity(activity, { ...activityFilter, sinceMs: ranges[activityFilter.range] }), [activity, activityFilter]);
  const counter = (label: string, value: number, state: string | undefined, f: ArgoFilter) => <Stat label={label} value={value} state={value ? state : undefined} active={section === 'Applications' && JSON.stringify(filter) === JSON.stringify(f)} onClick={() => showApps(f)} title={`Show ${label.toLowerCase()} applications`}/>;

  return <div className="resource-area"><section className="applications-page gitops-page" aria-label="Argo CD">
    <header><div><h1>Argo CD</h1><p className="muted">{clusterName} · read-only view of Application, ApplicationSet and AppProject resources</p></div>
      <div className="gitops-actions"><NamespacePicker clusterId={clusterId} label="Argo CD namespace" onChange={() => setSelected(undefined)}/><RefreshButton onClick={refresh}/>{argoUi && <button className="applications-secondary" title={argoUi} onClick={() => openArgo()}><ExternalLink size={15} aria-hidden="true"/>Open Argo CD UI</button>}</div></header>
    {!detection && <p role="status">Detecting Argo CD…</p>}
    {detection?.error && <div className="inline-error" role="alert">{detection.error}<button onClick={refresh}>Retry</button></div>}
    {detection?.value?.unavailableGroups.includes('argoproj.io') && <p className="inline-error">API discovery failed for argoproj.io; Argo CD data may be missing.</p>}
    {detection?.value && !types.applications && <section className="gitops-empty"><GitBranch size={26} aria-hidden="true"/><h2>Argo CD is not installed</h2><p>This cluster does not serve the <code>argoproj.io</code> Application API. After installing Argo CD, choose <b>Refresh</b>.</p></section>}
    {types.applications && <>
      <div className="gitops-stats" aria-label="Application status counters">
        {counter('Applications', summary.total, undefined, {})}{counter('Synced', summary.synced, 'Synced', { sync: 'Synced' })}{counter('Out of sync', summary.outOfSync, 'OutOfSync', { sync: 'OutOfSync' })}
        {counter('Healthy', summary.healthy, 'Healthy', { health: 'Healthy' })}{counter('Degraded', summary.degraded, 'Degraded', { health: 'Degraded' })}{counter('Missing', summary.missing, 'Missing', { health: 'Missing' })}
        {counter('Progressing', summary.progressing, 'Progressing', { health: 'Progressing' })}{counter('Unknown', summary.healthUnknown + summary.syncUnknown, undefined, { sync: 'Unknown' })}
      </div>
      <div className="detail-tabs gitops-sections" role="tablist" aria-label="Argo CD sections">{(['Dashboard', 'Applications', 'Application Sets', 'Projects'] as Section[]).filter(s => s !== 'Application Sets' || types.applicationsets).filter(s => s !== 'Projects' || types.appprojects).map(s => <button key={s} role="tab" aria-selected={section === s} className={section === s ? 'active' : ''} onClick={() => { setSection(s); setSelected(undefined); }}>{s}</button>)}</div>
      <Notice text={notice}/>
      <ListState source={apps} what="Argo CD Applications" namespace={namespace} empty={false} columns={6}/>
      {!apps.loading && !apps.error && section === 'Dashboard' && <>
        <div className="gitops-cards">
          <Card title="Applications"><p className="gitops-big"><b>{summary.healthy}/{summary.total}</b> healthy</p>
            <p className="gitops-links">{summary.outOfSync > 0 && <button className="gitops-link warn" onClick={() => showApps({ sync: 'OutOfSync' })}>{summary.outOfSync} out of sync</button>}{summary.missing > 0 && <button className="gitops-link bad" onClick={() => showApps({ health: 'Missing' })}>{summary.missing} missing</button>}{summary.degraded > 0 && <button className="gitops-link bad" onClick={() => showApps({ health: 'Degraded' })}>{summary.degraded} degraded</button>}{summary.failedSync > 0 && <span className="bad">{summary.failedSync} failed sync</span>}{!summary.outOfSync && !summary.missing && !summary.degraded && !summary.failedSync && summary.total > 0 && <span className="good">All applications in sync and healthy</span>}</p>
            <p className="muted">{summary.automated} with automated sync · last reconciled {summary.lastReconciled ? `${age(summary.lastReconciled)} ago` : '—'}</p></Card>
          {types.appprojects && <Card title="Projects" actions={<button className="gitops-link" onClick={() => setSection('Projects')}>View all</button>}><p className="gitops-big"><b>{projectRows.length}</b> total</p>
            {projects.error ? <p className="muted">{projects.errorCode === 'FORBIDDEN' ? 'No permission to list projects.' : projects.error}</p> : <ul className="gitops-list">{projectRows.slice(0, 6).map(p => <li key={`${p.namespace}/${p.name}`}><button className="gitops-link" onClick={() => { setSection('Projects'); setSelected({ kind: 'project', name: p.name, namespace: p.namespace }); }}>{p.name}</button> <small className="muted">{p.applications.length} app(s)</small></li>)}</ul>}</Card>}
          {types.applicationsets && <Card title="Application sets" actions={<button className="gitops-link" onClick={() => setSection('Application Sets')}>View all</button>}><p className="gitops-big"><b>{setRows.length}</b> total</p>
            {sets.error ? <p className="muted">{sets.errorCode === 'FORBIDDEN' ? 'No permission to list application sets.' : sets.error}</p> : <p className="muted">{setRows.reduce((n, s) => n + s.generated.length, 0)} generated application(s){setRows.some(s => s.errors.length) && <> · <span className="bad">{setRows.filter(s => s.errors.length).length} with errors</span></>}</p>}</Card>}
        </div>
        <Card title={`Needs attention (${attention.length})`}>{attention.length ? <div className="gitops-scroll"><table className="gitops-table"><thead><tr><th></th><th>Kind</th><th>Name</th><th>Application</th><th>Namespace</th><th>Problem</th><th>Message</th><th>Observed</th></tr></thead><tbody>
          {attention.slice(0, 100).map((r, i) => <tr key={i} className="gitops-clickable" onClick={() => r.application && openApp(r.application, r.kind === 'Application' ? r.namespace : undefined)}><td><Badge value={r.severity} label={r.severity === 'error' ? '!' : '•'}/></td><td>{r.kind}</td><td>{r.name}</td><td>{r.application ? <button className="gitops-link" onClick={e => { e.stopPropagation(); openApp(r.application!, r.kind === 'Application' ? r.namespace : undefined); }}>{r.application}</button> : '—'}</td><td>{r.namespace ?? '—'}</td><td><Badge value={r.severity} label={r.problem}/></td><td className="gitops-wrap">{r.message}</td><td title={time(r.at)}>{age(r.at)}</td></tr>)}</tbody></table></div> : <p className="good">Nothing needs attention: every application is synced and healthy.</p>}</Card>
        <Card title={`Recent activity (${activityRows.length})`} actions={<small className="muted">Kubernetes events (kept about 1 hour) and deployment history</small>}>
          <div className="gitops-filters">
            <select aria-label="Activity kind" value={activityFilter.kind ?? ''} onChange={e => setActivityFilter(f => ({ ...f, kind: e.target.value || undefined }))}><option value="">All kinds</option>{[...new Set(activity.map(a => a.kind))].sort().map(k => <option key={k}>{k}</option>)}</select>
            <select aria-label="Activity namespace" value={activityFilter.namespace ?? ''} onChange={e => setActivityFilter(f => ({ ...f, namespace: e.target.value || undefined }))}><option value="">All namespaces</option>{[...new Set(activity.map(a => a.namespace).filter(Boolean) as string[])].sort().map(n => <option key={n}>{n}</option>)}</select>
            <select aria-label="Activity type" value={activityFilter.type ?? ''} onChange={e => setActivityFilter(f => ({ ...f, type: e.target.value || undefined }))}><option value="">All types</option>{[...new Set(activity.map(a => a.type))].sort().map(t => <option key={t}>{t}</option>)}</select>
            <select aria-label="Activity time range" value={activityFilter.range} onChange={e => setActivityFilter(f => ({ ...f, range: e.target.value as keyof typeof ranges }))}>{Object.keys(ranges).map(r => <option key={r} value={r}>{r === 'All' ? 'Any time' : `Last ${r}`}</option>)}</select>
            <input aria-label="Activity application" placeholder="Filter by application" value={activityFilter.application ?? ''} onChange={e => setActivityFilter(f => ({ ...f, application: e.target.value }))}/>
          </div>
          {events.error && <p className="muted">Events unavailable: {events.error} Deployment history is still shown.</p>}
          {activityRows.length ? <div className="gitops-scroll"><table className="gitops-table"><thead><tr><th>Kind</th><th>Name</th><th>Namespace</th><th>Type</th><th>Message</th><th>Time</th><th>Age</th></tr></thead><tbody>
            {activityRows.slice(0, 200).map((r, i) => <tr key={i} className="gitops-clickable" onClick={() => r.application && openApp(r.application, r.namespace, r.origin === 'history' ? 'History' : 'Events')}><td>{r.kind}</td><td>{r.name}</td><td>{r.namespace ?? '—'}</td><td><Badge value={r.warning ? 'warning' : r.type === 'OperationCompleted' || r.type === 'Deployed' ? 'Succeeded' : undefined} label={r.type}/></td><td className="gitops-wrap">{r.message}</td><td>{time(r.at)}</td><td>{age(r.at)}</td></tr>)}</tbody></table></div>
            : <p className="muted">No activity matches these filters.</p>}
        </Card>
      </>}
      {!apps.loading && !apps.error && section === 'Applications' && <>
        <div className="gitops-filters">
          <input aria-label="Search applications" placeholder="Search name, namespace, project, repository" value={filter.search ?? ''} onChange={e => setFilter(f => ({ ...f, search: e.target.value }))}/>
          <select aria-label="Project filter" value={filter.project ?? ''} onChange={e => setFilter(f => ({ ...f, project: e.target.value || undefined }))}><option value="">All projects</option>{[...new Set(applications.map(a => a.project))].sort().map(p => <option key={p}>{p}</option>)}</select>
          <select aria-label="Health filter" value={filter.health ?? ''} onChange={e => setFilter(f => ({ ...f, health: e.target.value || undefined }))}><option value="">Any health</option>{healthStates.map(h => <option key={h}>{h}</option>)}</select>
          <select aria-label="Sync filter" value={filter.sync ?? ''} onChange={e => setFilter(f => ({ ...f, sync: e.target.value || undefined }))}><option value="">Any sync status</option>{syncStates.map(s => <option key={s}>{s}</option>)}</select>
          {setRows.length > 0 && <select aria-label="Application set filter" value={filter.applicationSet ?? ''} onChange={e => setFilter(f => ({ ...f, applicationSet: e.target.value || undefined }))}><option value="">Any application set</option>{setRows.map(s => <option key={s.name}>{s.name}</option>)}</select>}
          {Object.values(filter).some(Boolean) && <button className="gitops-link" onClick={() => setFilter({})}>Clear filters</button>}
        </div>
        <p className="muted" role="status">{listed.length === applications.length ? `${applications.length} application(s)` : `${listed.length} of ${applications.length} application(s)`}{listed.length > MAX_ROWS ? `; showing the first ${MAX_ROWS}` : ''}. Right-click a row for actions.</p>
        {!applications.length ? <p className="muted">No Argo CD Applications {namespace ? `in ${namespace}` : 'found'}.</p> : <div className="gitops-scroll"><table className="gitops-table"><thead><tr><SortHeader label="Name" column="name" sort={sort} onSort={onSort}/><SortHeader label="Namespace" column="namespace" sort={sort} onSort={onSort}/><SortHeader label="Project" column="project" sort={sort} onSort={onSort}/><SortHeader label="Sync" column="sync" sort={sort} onSort={onSort}/><SortHeader label="Health" column="health" sort={sort} onSort={onSort}/><th>Revision</th><th>Destination</th><SortHeader label="Last deployed" column="deployed" sort={sort} onSort={onSort}/></tr></thead>
          <tbody>{listed.slice(0, MAX_ROWS).map(a => <tr key={a.uid ?? a.name} className={`gitops-clickable ${app?.uid === a.uid ? 'selected' : ''}`} onClick={() => openApp(a.name, a.namespace)} onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, app: a }); }}>
            <td><button className="gitops-link" onClick={e => { e.stopPropagation(); openApp(a.name, a.namespace); }}>{a.name}</button></td><td>{a.namespace}</td><td>{a.project}</td><td><Badge value={a.sync}/>{a.outOfSync.length > 0 && <small> {a.outOfSync.length} out of sync</small>}</td><td><Badge value={a.health}/></td><td className="mono" title={a.revision}>{short(a.revision)}</td><td>{a.destination.name ?? a.destination.server}{a.destination.namespace && ` / ${a.destination.namespace}`}</td><td title={time(a.history[0]?.deployedAt)}>{age(a.history[0]?.deployedAt)}</td></tr>)}</tbody></table></div>}
      </>}
      {section === 'Application Sets' && <><ListState source={sets} what="ApplicationSets" namespace={namespace} empty={!setRows.length} columns={5}/>
        {setRows.length > 0 && <div className="gitops-scroll"><table className="gitops-table"><thead><tr><th>Name</th><th>Namespace</th><th>Generators</th><th>Template</th><th>Applications</th><th>Status</th></tr></thead><tbody>{setRows.map(s => <tr key={s.uid ?? s.name} className={`gitops-clickable ${set?.uid === s.uid ? 'selected' : ''}`} onClick={() => setSelected({ kind: 'set', name: s.name, namespace: s.namespace })}><td><button className="gitops-link">{s.name}</button></td><td>{s.namespace}</td><td>{s.generators.map(g => g.type).join(', ') || '—'}</td><td className="mono">{s.template.name ?? '—'}</td><td>{s.generated.length}</td><td>{s.errors.length ? <Badge value="Failed" label="Error"/> : <Badge value={s.health ?? 'Unknown'}/>}</td></tr>)}</tbody></table></div>}</>}
      {section === 'Projects' && <><ListState source={projects} what="AppProjects" namespace={namespace} empty={!projectRows.length} columns={5}/>
        {projectRows.length > 0 && <div className="gitops-scroll"><table className="gitops-table"><thead><tr><th>Name</th><th>Description</th><th>Applications</th><th>Source repositories</th><th>Destinations</th></tr></thead><tbody>{projectRows.map(p => <tr key={p.uid ?? p.name} className={`gitops-clickable ${project?.uid === p.uid ? 'selected' : ''}`} onClick={() => setSelected({ kind: 'project', name: p.name, namespace: p.namespace })}><td><button className="gitops-link">{p.name}</button></td><td>{p.description ?? '—'}</td><td>{p.applications.length}</td><td className="gitops-wrap">{p.sourceRepos.join(', ') || '—'}</td><td className="gitops-wrap">{p.destinations.map(d => `${d.name ?? d.server ?? '*'}/${d.namespace ?? '*'}`).join(', ') || '—'}</td></tr>)}</tbody></table></div>}</>}
    </>}
  </section>
  {app && types.applications && <ApplicationDetails key={app.uid} app={app} clusterId={clusterId} custom={types.applications} initialTab={selected?.tab} onClose={() => setSelected(undefined)} onOpen={openResource} onArgo={argoUi ? () => openArgo({ namespace: app.namespace!, name: app.name }) : undefined}/>}
  {set && types.applicationsets && <Drawer eyebrow="ARGO CD APPLICATION SET" title={set.name} onClose={() => setSelected(undefined)} tabs={['Overview', 'Applications', 'Conditions', 'Events', 'YAML']} tab={selected?.tab ?? 'Overview'} onTab={tab => setSelected(s => s && { ...s, tab })} badges={set.errors.length ? <Badge value="Failed" label="Error"/> : <Badge value={set.health ?? 'Unknown'}/>}>
    {(selected?.tab ?? 'Overview') === 'Overview' && <>{set.errors.map(e => <p key={e.type} className="inline-error">{e.message}</p>)}
      <h3>Generators</h3><ul className="gitops-list">{set.generators.map((g, i) => <li key={i}><b>{g.type}</b>{g.summary && ` · ${g.summary}`}</li>)}</ul>
      <h3>Template</h3><dl><dt>Name</dt><dd className="mono">{set.template.name ?? '—'}</dd><dt>Project</dt><dd>{set.template.project ?? '—'}</dd><dt>Source</dt><dd>{set.template.source?.repoURL ?? '—'}{set.template.source?.path && ` · ${set.template.source.path}`}</dd><dt>Destination</dt><dd>{set.template.destination?.name ?? set.template.destination?.server ?? '—'}{set.template.destination?.namespace && ` / ${set.template.destination.namespace}`}</dd></dl></>}
    {selected?.tab === 'Applications' && (set.generated.length ? <ul className="gitops-list">{set.generated.map(g => <li key={g.name}><button className="gitops-link" onClick={() => { setSection('Applications'); openApp(g.name, g.namespace); }}>{g.name}</button> <Badge value={g.status}/> <Badge value={g.health}/></li>)}</ul> : <p className="muted">No applications generated.</p>)}
    {selected?.tab === 'Conditions' && <Conditions items={set.conditions}/>}
    {selected?.tab === 'Events' && <ObjectEvents clusterId={clusterId} namespace={set.namespace} kind="ApplicationSet" name={set.name}/>}
    {selected?.tab === 'YAML' && <ObjectYaml clusterId={clusterId} custom={types.applicationsets} namespace={set.namespace} name={set.name}/>}
  </Drawer>}
  {project && types.appprojects && <Drawer eyebrow="ARGO CD PROJECT" title={project.name} onClose={() => setSelected(undefined)} tabs={['Overview', 'Permissions', 'Applications', 'YAML']} tab={selected?.tab ?? 'Overview'} onTab={tab => setSelected(s => s && { ...s, tab })}>
    {(selected?.tab ?? 'Overview') === 'Overview' && <>{project.description && <p>{project.description}</p>}
      <h3>Source repositories</h3>{project.sourceRepos.length ? <ul className="gitops-list">{project.sourceRepos.map(r => <li key={r}>{r}</li>)}</ul> : <p className="muted">None allowed.</p>}
      <h3>Destinations</h3>{project.destinations.length ? <table className="gitops-table"><thead><tr><th>Cluster</th><th>Namespace</th></tr></thead><tbody>{project.destinations.map((d, i) => <tr key={i}><td>{d.name ?? d.server ?? '*'}</td><td>{d.namespace ?? '*'}</td></tr>)}</tbody></table> : <p className="muted">None allowed.</p>}
      <h3>Roles</h3>{project.roles.length ? <ul className="gitops-list">{project.roles.map(r => <li key={r.name}><b>{r.name}</b>{r.description && ` · ${r.description}`}<br/><small className="muted">{r.policies.length} polic{r.policies.length === 1 ? 'y' : 'ies'}{r.groups.length ? ` · groups: ${r.groups.join(', ')}` : ''}</small></li>)}</ul> : <p className="muted">No project roles.</p>}</>}
    {selected?.tab === 'Permissions' && <>{([['Cluster resources allowed', project.clusterAllow, 'none'], ['Cluster resources denied', project.clusterDeny, 'none'], ['Namespaced resources allowed', project.namespaceAllow, 'all'], ['Namespaced resources denied', project.namespaceDeny, 'none']] as const).map(([title, list, fallback]) => <div key={title}><h3>{title}</h3>{list.length ? <ul className="gitops-list">{list.map((r, i) => <li key={i} className="mono">{r.group || 'core'}/{r.kind}</li>)}</ul> : <p className="muted">{fallback === 'all' ? 'Not restricted.' : 'None.'}</p>}</div>)}
      <p className="muted">Argo CD enforces these rules when syncing; Kubernetes RBAC applies separately.</p></>}
    {selected?.tab === 'Applications' && (project.applications.length ? <ul className="gitops-list">{project.applications.map(n => <li key={n}><button className="gitops-link" onClick={() => { setSection('Applications'); openApp(n); }}>{n}</button></li>)}</ul> : <p className="muted">No applications in this project{namespace ? ` in ${namespace}` : ''}.</p>)}
    {selected?.tab === 'YAML' && <ObjectYaml clusterId={clusterId} custom={types.appprojects} namespace={project.namespace} name={project.name}/>}
  </Drawer>}
  {menu && <ContextMenu x={menu.x} y={menu.y} title={menu.app.name} onClose={() => setMenu(undefined)} items={[{ label: 'Open details', run: () => openApp(menu.app.name, menu.app.namespace) }, { label: 'Show events', run: () => openApp(menu.app.name, menu.app.namespace, 'Events') }, { label: 'Show YAML', run: () => openApp(menu.app.name, menu.app.namespace, 'YAML') }, ...(argoUi ? [{ label: 'Open in Argo CD UI', run: () => openArgo({ namespace: menu.app.namespace!, name: menu.app.name }) }] : [])]}/>}
  </div>;
}

function ApplicationDetails({ app, clusterId, custom, initialTab, onClose, onOpen, onArgo }: { app: ArgoApplication; clusterId: string; custom: import('../../shared/catalog').CustomType; initialTab?: string; onClose: () => void; onOpen: (r: { group?: string; kind: string; namespace?: string; name: string }) => void; onArgo?: () => void }) {
  const [tab, setTab] = useState(initialTab ?? 'Overview'), [onlyOutOfSync, setOnlyOutOfSync] = useState(false);
  useEffect(() => { if (initialTab) setTab(initialTab); }, [initialTab]);
  const resources = onlyOutOfSync ? app.outOfSync : app.resources;
  const byKind = Object.entries(resources.reduce<Record<string, typeof app.resources>>((groups, r) => ((groups[r.kind] ??= []).push(r), groups), {})).sort(([a], [b]) => a.localeCompare(b));
  const source = app.sources[0];
  return <Drawer eyebrow="ARGO CD APPLICATION" title={app.name} onClose={onClose} tabs={['Overview', 'Resources', 'Events', 'History', 'YAML', 'Conditions']} tab={tab} onTab={setTab}
    badges={<><Badge value={app.sync}/><Badge value={app.health}/>{app.automated && <Badge label="Auto-sync"/>}{onArgo && <button className="gitops-link" onClick={onArgo}><ExternalLink size={12}/> Argo CD UI</button>}</>}>
    {tab === 'Overview' && <>
      {app.healthMessage && <p className="muted">{app.healthMessage}</p>}
      {app.errors.map((e, i) => <p key={i} className="inline-error"><b>{e.type}</b>: {e.message}</p>)}
      <dl><dt>Project</dt><dd>{app.project}</dd><dt>Namespace</dt><dd>{app.namespace}</dd>{app.applicationSet && <><dt>Application set</dt><dd>{app.applicationSet}</dd></>}
        <dt>Repository</dt><dd>{source?.repoURL ?? '—'}{app.sources.length > 1 && <small className="muted"> (+{app.sources.length - 1} more source{app.sources.length > 2 ? 's' : ''})</small>}</dd>
        <dt>Path / chart</dt><dd>{source?.path ?? source?.chart ?? '—'}</dd><dt>Target revision</dt><dd className="mono">{source?.targetRevision ?? 'HEAD'}</dd><dt>Synced revision</dt><dd className="mono">{app.revision ?? '—'}</dd>
        <dt>Destination</dt><dd>{app.destination.name ?? app.destination.server ?? '—'}{app.destination.namespace && ` / ${app.destination.namespace}`}</dd>
        <dt>Sync policy</dt><dd>{app.automated ? 'Automated' : 'Manual'}</dd><dt>Reconciled</dt><dd>{time(app.reconciledAt)}</dd><dt>Created</dt><dd>{time(app.createdAt)}</dd></dl>
      {app.operation && <><h3>Last operation</h3><p><Badge value={app.operation.phase}/> {app.operation.message} <small className="muted">{time(app.operation.startedAt)} – {time(app.operation.finishedAt)}</small></p></>}
    </>}
    {tab === 'Resources' && <>
      <label className="gitops-check"><input type="checkbox" checked={onlyOutOfSync} onChange={e => setOnlyOutOfSync(e.target.checked)}/> Out of sync only ({app.outOfSync.length})</label>
      <p className="muted">Managed resources with their sync status (live versus Git). Open one to inspect its live state and children under Related. Argo CD 3 keeps per-resource health in its own cache, so health shows here only when the Application reports it; the rendered desired state is only available from the Argo CD server.</p>
      {!byKind.length && <p className="muted">{onlyOutOfSync ? 'All managed resources match Git.' : 'No managed resources reported.'}</p>}
      {byKind.map(([kind, items]) => <details key={kind} open><summary>{kind} ({items.length})</summary><ul className="gitops-list">{items.map(r => <li key={`${r.namespace}/${r.name}`}><span className="mono">{r.kind}</span> {r.namespace ? `${r.namespace}/` : ''}{r.name} <Badge value={r.status}/>{r.health && <Badge value={r.health} title={r.healthMessage}/>}{r.requiresPruning && <Badge value="Missing" label="Requires pruning"/>}{r.hook && <Badge label="Hook"/>}{app.inCluster && <button className="gitops-link" onClick={() => onOpen(r)}>Open</button>}</li>)}</ul></details>)}
      {!app.inCluster && app.resources.length > 0 && <p className="muted">These resources are in another cluster ({app.destination.name ?? app.destination.server}); open that cluster in Optic to inspect them.</p>}
    </>}
    {tab === 'Events' && <ObjectEvents clusterId={clusterId} namespace={app.namespace} kind="Application" name={app.name}/>}
    {tab === 'History' && (app.history.length ? <table className="gitops-table"><thead><tr><th>#</th><th>Deployed</th><th>Revision</th><th>By</th><th>Source</th></tr></thead><tbody>{app.history.map((h, i) => <tr key={h.id ?? i}><td>{h.id ?? '—'}</td><td>{time(h.deployedAt)}</td><td className="mono" title={h.revision}>{short(h.revision)}</td><td>{h.initiatedBy ?? '—'}</td><td>{h.source?.path ?? h.source?.chart ?? '—'}</td></tr>)}</tbody></table> : <p className="muted">No deployments recorded yet.</p>)}
    {tab === 'YAML' && <ObjectYaml clusterId={clusterId} custom={custom} namespace={app.namespace} name={app.name}/>}
    {tab === 'Conditions' && <Conditions items={app.conditions}/>}
  </Drawer>;
}
