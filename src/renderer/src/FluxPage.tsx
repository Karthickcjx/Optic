import { useMemo, useState } from 'react';
import { GitBranch } from 'lucide-react';
import { consumersOf, fluxAttention, fluxKindOf, fluxObject, fluxSourceTypes, fluxSummary, gitopsTypes, type FluxObject, type FluxType } from '../../shared/gitops';
import { useStore } from './store';
import { Badge, Card, Conditions, Drawer, ListState, MAX_ROWS, NamespacePicker, Notice, ObjectEvents, ObjectYaml, RefreshButton, SortHeader, Stat, age, short, time, useDetection, useOpenResource, useSort, useTypeWatch } from './gitops-ui';

type Section = 'Overview' | 'Kustomizations' | 'Helm releases' | 'Sources';
type Status = '' | 'ready' | 'failing' | 'suspended' | 'reconciling' | 'unknown';
const statusOf = (o: FluxObject): Status[] => [o.ready === 'True' && !o.suspended ? 'ready' : o.ready === 'False' ? 'failing' : 'unknown', ...(o.suspended ? ['suspended' as const] : []), ...(o.reconciling ? ['reconciling' as const] : [])];
type SortKey = 'name' | 'namespace' | 'ready' | 'reconciled';

export function FluxPage() {
  const clusterId = useStore(s => s.clusterId), namespace = useStore(s => s.namespace), clusterName = useStore(s => s.clusters.find(c => c.id === s.clusterId)?.name ?? '');
  const [revision, setRevision] = useState(0), detection = useDetection(clusterId, revision), types = detection?.value?.types ?? {};
  const watches: Record<FluxType, ReturnType<typeof useTypeWatch>> = {
    kustomizations: useTypeWatch(clusterId, detection?.value, 'kustomizations', namespace), helmreleases: useTypeWatch(clusterId, detection?.value, 'helmreleases', namespace),
    gitrepositories: useTypeWatch(clusterId, detection?.value, 'gitrepositories', namespace), helmrepositories: useTypeWatch(clusterId, detection?.value, 'helmrepositories', namespace),
    ocirepositories: useTypeWatch(clusterId, detection?.value, 'ocirepositories', namespace), buckets: useTypeWatch(clusterId, detection?.value, 'buckets', namespace)
  };
  const detected = (Object.keys(watches) as FluxType[]).filter(t => types[t]);
  const objects = useMemo(() => detected.flatMap(t => watches[t].items.map(i => fluxObject(t, i))), [detected.join(), ...detected.map(t => watches[t].items)]);
  const summary = useMemo(() => fluxSummary(objects), [objects]), attention = useMemo(() => fluxAttention(objects), [objects]);
  const [section, setSection] = useState<Section>('Overview'), [sourceKind, setSourceKind] = useState<FluxType | ''>(''), [status, setStatus] = useState<Status>(''), [search, setSearch] = useState('');
  const [sort, onSort] = useSort<SortKey>('name'), [selected, setSelected] = useState<{ type: FluxType; namespace?: string; name: string; tab?: string }>(), [notice, setNotice] = useState('');
  const openResource = useOpenResource(clusterId, setNotice);
  const refresh = () => { setRevision(v => v + 1); for (const t of detected) watches[t].refresh(); };
  const sectionTypes: FluxType[] = section === 'Kustomizations' ? ['kustomizations'] : section === 'Helm releases' ? ['helmreleases'] : section === 'Sources' ? (sourceKind ? [sourceKind] : fluxSourceTypes.filter(t => types[t])) : [];
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = objects.filter(o => sectionTypes.includes(o.type) && (!status || statusOf(o).includes(status)) && (!q || `${o.name} ${o.namespace ?? ''} ${o.url ?? ''} ${o.source ?? ''}`.toLowerCase().includes(q)));
    const value = (o: FluxObject) => sort.key === 'ready' ? ({ False: 0, Unknown: 1, True: 2 } as Record<string, number>)[o.ready] ?? 1 : sort.key === 'reconciled' ? o.lastReconcileAt ?? '' : sort.key === 'namespace' ? o.namespace ?? '' : o.name;
    const sorted = matched.sort((x, y) => { const a = value(x), b = value(y); return (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))) || x.name.localeCompare(y.name); });
    return sort.desc ? sorted.reverse() : sorted;
  }, [objects, sectionTypes.join(), status, search, sort]);
  const item = selected && objects.find(o => o.type === selected.type && o.name === selected.name && o.namespace === selected.namespace);
  const open = (o: { type: FluxType; name: string; namespace?: string }, tab?: string) => setSelected({ type: o.type, name: o.name, namespace: o.namespace, tab });
  const openRef = (ref: string) => { const [kind, ns, name] = ref.split('/'); const type = (Object.keys(watches) as FluxType[]).find(t => fluxKindOf(t) === kind); if (type && types[type]) { setSection(type === 'kustomizations' ? 'Kustomizations' : type === 'helmreleases' ? 'Helm releases' : 'Sources'); open({ type, name, namespace: ns }); } else setNotice(`${kind} is not available in this cluster view.`); };
  const sectionWatches = sectionTypes.map(t => watches[t]);
  const failing = sectionWatches.find(w => w.error), loading = sectionWatches.some(w => w.loading);
  const goto = (s: Section, st: Status = '') => { setSection(s); setStatus(st); setSelected(undefined); };

  return <div className="resource-area"><section className="applications-page gitops-page" aria-label="Flux">
    <header><div><h1>Flux</h1><p className="muted">{clusterName} · read-only view of Flux sources, Kustomizations and Helm releases</p></div>
      <div className="gitops-actions"><NamespacePicker clusterId={clusterId} label="Flux namespace" onChange={() => setSelected(undefined)}/><RefreshButton onClick={refresh}/></div></header>
    {!detection && <p role="status">Detecting Flux…</p>}
    {detection?.error && <div className="inline-error" role="alert">{detection.error}<button onClick={refresh}>Retry</button></div>}
    {!!detection?.value?.unavailableGroups.filter(g => g.includes('fluxcd')).length && <p className="inline-error">API discovery failed for {detection.value.unavailableGroups.filter(g => g.includes('fluxcd')).join(', ')}; some Flux data may be missing.</p>}
    {detection?.value && !detected.length && <section className="gitops-empty"><GitBranch size={26} aria-hidden="true"/><h2>Flux is not installed</h2><p>This cluster does not serve the Flux <code>*.toolkit.fluxcd.io</code> APIs. After installing Flux, choose <b>Refresh</b>.</p></section>}
    {detected.length > 0 && <>
      <div className="gitops-stats" aria-label="Flux status counters">
        <Stat label="Resources" value={summary.total}/><Stat label="Ready" value={summary.ready} state={summary.ready ? 'True' : undefined}/><Stat label="Failing" value={summary.failing} state={summary.failing ? 'False' : undefined}/>
        <Stat label="Suspended" value={summary.suspended} state={summary.suspended ? 'Suspended' : undefined}/><Stat label="Reconciling" value={summary.reconciling} state={summary.reconciling ? 'Progressing' : undefined}/><Stat label="Stalled" value={summary.stalled} state={summary.stalled ? 'Stalled' : undefined}/><Stat label="Unknown" value={summary.unknown}/>
      </div>
      <div className="detail-tabs gitops-sections" role="tablist" aria-label="Flux sections">{(['Overview', 'Kustomizations', 'Helm releases', 'Sources'] as Section[]).filter(s => s === 'Overview' || (s === 'Kustomizations' ? types.kustomizations : s === 'Helm releases' ? types.helmreleases : fluxSourceTypes.some(t => types[t]))).map(s => <button key={s} role="tab" aria-selected={section === s} className={section === s ? 'active' : ''} onClick={() => goto(s)}>{s}</button>)}</div>
      <Notice text={notice}/>
      {section === 'Overview' && <>
        <div className="gitops-cards">{detected.map(t => { const list = objects.filter(o => o.type === t), s = fluxSummary(list), w = watches[t]; return <Card key={t} title={gitopsTypes[t].label}>
          {w.error ? <p className="muted">{w.errorCode === 'FORBIDDEN' ? 'No permission to list.' : w.error}</p> : w.loading ? <p role="status" className="muted">Loading…</p> : <>
            <p className="gitops-big"><b>{s.ready}/{s.total}</b> ready</p>
            <p className="gitops-links">{s.failing > 0 && <button className="gitops-link bad" onClick={() => { goto(t === 'kustomizations' ? 'Kustomizations' : t === 'helmreleases' ? 'Helm releases' : 'Sources', 'failing'); if ((fluxSourceTypes as readonly string[]).includes(t)) setSourceKind(t); }}>{s.failing} failing</button>}{s.suspended > 0 && <span className="warn">{s.suspended} suspended</span>}{!s.failing && !s.suspended && s.total > 0 && <span className="good">All ready</span>}</p></>}
        </Card>; })}</div>
        <Card title={`Needs attention (${attention.length})`}>{attention.length ? <div className="gitops-scroll"><table className="gitops-table"><thead><tr><th></th><th>Kind</th><th>Name</th><th>Namespace</th><th>Problem</th><th>Message</th><th>Observed</th></tr></thead><tbody>
          {attention.slice(0, 100).map((r, i) => { const type = (Object.keys(watches) as FluxType[]).find(t => fluxKindOf(t) === r.kind)!; return <tr key={i} className="gitops-clickable" onClick={() => { setSection(type === 'kustomizations' ? 'Kustomizations' : type === 'helmreleases' ? 'Helm releases' : 'Sources'); open({ type, name: r.name, namespace: r.namespace }); }}>
            <td><Badge value={r.severity} label={r.severity === 'error' ? '!' : '•'}/></td><td>{r.kind}</td><td><button className="gitops-link">{r.name}</button></td><td>{r.namespace}</td><td><Badge value={r.severity} label={r.problem}/></td><td className="gitops-wrap">{r.message}</td><td title={time(r.at)}>{age(r.at)}</td></tr>; })}</tbody></table></div>
          : <p className="good">Nothing needs attention: every Flux resource is ready.</p>}</Card>
      </>}
      {section !== 'Overview' && <>
        <div className="gitops-filters">
          {section === 'Sources' && <div className="gitops-kinds" role="tablist" aria-label="Source kinds"><button role="tab" aria-selected={!sourceKind} className={!sourceKind ? 'active' : ''} onClick={() => setSourceKind('')}>All sources</button>{fluxSourceTypes.filter(t => types[t]).map(t => <button key={t} role="tab" aria-selected={sourceKind === t} className={sourceKind === t ? 'active' : ''} onClick={() => setSourceKind(t)}>{gitopsTypes[t].label} <small>{watches[t].error ? '—' : watches[t].items.length}</small></button>)}</div>}
          <input aria-label="Search Flux resources" placeholder="Filter by name, namespace, URL or source" value={search} onChange={e => setSearch(e.target.value)}/>
          <select aria-label="Status filter" value={status} onChange={e => setStatus(e.target.value as Status)}><option value="">Any status</option><option value="ready">Ready</option><option value="failing">Failing</option><option value="suspended">Suspended</option><option value="reconciling">Reconciling</option><option value="unknown">Unknown</option></select>
        </div>
        {failing ? <ListState source={failing} what={section === 'Sources' ? 'Flux sources' : section === 'Kustomizations' ? 'Kustomizations' : 'Helm releases'} namespace={namespace} empty={false}/>
          : loading && !rows.length ? <ListState source={sectionWatches.find(w => w.loading)!} what="Flux resources" namespace={namespace} empty={false} columns={7}/>
          : !rows.length ? <p className="muted">{search || status ? 'No matching resources.' : `No ${section.toLowerCase()} ${namespace ? `in ${namespace}` : 'found'}.`}</p>
          : <>{rows.length > MAX_ROWS && <p className="muted" role="status">Showing {MAX_ROWS} of {rows.length}. Filter to see the rest.</p>}
            <div className="gitops-scroll"><table className="gitops-table"><thead><tr><SortHeader label="Name" column="name" sort={sort} onSort={onSort}/>{section === 'Sources' && <th>Kind</th>}<SortHeader label="Namespace" column="namespace" sort={sort} onSort={onSort}/><SortHeader label="Ready" column="ready" sort={sort} onSort={onSort}/><th>{section === 'Sources' ? 'URL' : 'Source'}</th><th>Applied revision</th><SortHeader label="Last reconciled" column="reconciled" sort={sort} onSort={onSort}/><th>Interval</th><th>Message</th></tr></thead>
            <tbody>{rows.slice(0, MAX_ROWS).map(o => <tr key={o.uid ?? `${o.type}/${o.name}`} className={`gitops-clickable ${item?.uid === o.uid ? 'selected' : ''}`} onClick={() => open(o)}>
              <td><button className="gitops-link" onClick={e => { e.stopPropagation(); open(o); }}>{o.name}</button></td>{section === 'Sources' && <td>{fluxKindOf(o.type)}</td>}<td>{o.namespace}</td>
              <td><Badge value={o.ready}/>{o.suspended && <Badge value="Suspended"/>}{o.stalled && <Badge value="Stalled"/>}</td><td className="gitops-wrap">{section === 'Sources' ? `${o.url ?? '—'}${o.ref ? ` (${o.ref})` : ''}` : o.source ?? '—'}</td>
              <td className="mono" title={o.revision}>{short(o.revision)}{o.attemptedRevision && o.attemptedRevision !== o.revision && <Badge value="warning" label="newer attempted" title={`Last attempted: ${o.attemptedRevision}`}/>}</td><td title={time(o.lastReconcileAt)}>{age(o.lastReconcileAt)}</td><td>{o.interval ?? '—'}</td><td className="gitops-message" title={o.message}>{o.reason}{o.message && `: ${o.message}`}</td></tr>)}</tbody></table></div></>}
      </>}
    </>}
  </section>
  {item && types[item.type] && <FluxDetails key={`${item.type}/${item.uid}`} item={item} objects={objects} clusterId={clusterId} custom={types[item.type]!} initialTab={selected?.tab} onClose={() => setSelected(undefined)} onOpen={openResource} onRef={openRef} onSelect={o => open(o)}/>}
  </div>;
}

function FluxDetails({ item, objects, clusterId, custom, initialTab, onClose, onOpen, onRef, onSelect }: { item: FluxObject; objects: FluxObject[]; clusterId: string; custom: import('../../shared/catalog').CustomType; initialTab?: string; onClose: () => void; onOpen: (r: { group?: string; kind: string; namespace?: string; name: string }) => void; onRef: (ref: string) => void; onSelect: (o: FluxObject) => void }) {
  const [tab, setTab] = useState(initialTab ?? 'Overview');
  const isSource = (fluxSourceTypes as readonly string[]).includes(item.type), kind = fluxKindOf(item.type), consumers = isSource ? consumersOf(`${kind}/${item.namespace}/${item.name}`, objects) : [];
  const sourceObject = item.source ? objects.find(o => `${fluxKindOf(o.type)}/${o.namespace}/${o.name}` === item.source) : undefined;
  return <Drawer eyebrow={`FLUX ${kind.toUpperCase()}`} title={item.name} onClose={onClose} tabs={['Overview', 'Resources', 'Events', 'History', 'YAML', 'Conditions']} tab={tab} onTab={setTab}
    badges={<><Badge value={item.ready} label={`Ready: ${item.ready}`}/>{item.suspended && <Badge value="Suspended"/>}{item.reconciling && <Badge value="Reconciling"/>}{item.stalled && <Badge value="Stalled"/>}</>}>
    {tab === 'Overview' && <>
      {item.message && <p className={item.ready === 'False' ? 'inline-error' : 'muted'}>{item.reason && <b>{item.reason}: </b>}{item.message}</p>}
      <dl><dt>Namespace</dt><dd>{item.namespace}</dd><dt>Applied revision</dt><dd className="mono">{item.revision ?? '—'}</dd>
        <dt>Attempted revision</dt><dd className="mono">{item.attemptedRevision ?? '—'}{item.attemptedRevision && item.revision && item.attemptedRevision !== item.revision && <Badge value="warning" label="differs from applied"/>}</dd>
        <dt>Last success</dt><dd>{time(item.lastSuccessAt)}</dd><dt>Last reconciled</dt><dd>{time(item.lastReconcileAt)}</dd><dt>Interval</dt><dd>{item.interval ?? '—'}</dd><dt>Suspended</dt><dd>{item.suspended ? 'Yes' : 'No'}</dd>
        {item.source && <><dt>Source</dt><dd><button className="gitops-link" onClick={() => onRef(item.source!)}>{item.source}</button>{sourceObject && <> <Badge value={sourceObject.ready} label={`Ready: ${sourceObject.ready}`}/></>}</dd></>}
        {item.url && <><dt>URL</dt><dd>{item.url}</dd></>}{item.ref && <><dt>Reference</dt><dd>{item.ref}</dd></>}{item.path && <><dt>Path</dt><dd><code>{item.path}</code></dd></>}{item.chart && <><dt>Chart</dt><dd>{item.chart}</dd></>}</dl>
    </>}
    {tab === 'Resources' && (isSource
      ? <><p className="muted">Kustomizations and Helm releases that use this source.</p>{consumers.length ? <ul className="gitops-list">{consumers.map(c => <li key={`${c.type}/${c.namespace}/${c.name}`}><span className="mono">{fluxKindOf(c.type)}</span> <button className="gitops-link" onClick={() => onSelect(c)}>{c.namespace}/{c.name}</button> <Badge value={c.ready} label={`Ready: ${c.ready}`}/></li>)}</ul> : <p className="muted">No Kustomization or Helm release in view uses this source.</p>}</>
      : <><p className="muted">Objects applied by this {kind} (from its inventory).</p>{item.inventory.length ? <ul className="gitops-list">{item.inventory.slice(0, 300).map(r => <li key={`${r.group}/${r.kind}/${r.namespace}/${r.name}`}><span className="mono">{r.kind}</span> {r.namespace ? `${r.namespace}/` : ''}{r.name} <button className="gitops-link" onClick={() => onOpen(r)}>Open</button></li>)}{item.inventory.length > 300 && <li className="muted">and {item.inventory.length - 300} more</li>}</ul> : <p className="muted">No inventory recorded{item.ready !== 'True' ? ' (nothing has been applied successfully yet)' : ''}.</p>}</>)}
    {tab === 'Events' && <ObjectEvents clusterId={clusterId} namespace={item.namespace} kind={kind} name={item.name}/>}
    {tab === 'History' && (item.history.length ? <table className="gitops-table"><thead><tr><th>When</th><th>Result</th><th>Revision</th><th>Detail</th></tr></thead><tbody>{item.history.map((h, i) => <tr key={i}><td>{time(h.at)}</td><td><Badge value={h.status}/></td><td className="mono" title={h.revision}>{short(h.revision)}</td><td>{h.detail ?? '—'}</td></tr>)}</tbody></table> : <p className="muted">{isSource ? 'Sources do not keep a history; see Events and the artifact revision above.' : 'No history recorded yet.'}</p>)}
    {tab === 'YAML' && <ObjectYaml clusterId={clusterId} custom={custom} namespace={item.namespace} name={item.name}/>}
    {tab === 'Conditions' && <Conditions items={item.conditions}/>}
  </Drawer>;
}
