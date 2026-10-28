import { useState } from 'react';
import { Package, Upload } from 'lucide-react';
import { openImportDeploy } from './ImportDeployDialog';
import { groupApplications } from '../../shared/applications';
import { resourceKind } from '../../shared/relationships';
import { useResources } from './hooks';
import { useStore } from './store';
import { Status } from './Table';

export function Applications() {
  const store = useStore();
  const [search, setSearch] = useState('');
  const manual = store.clusterSettings[store.clusterId]?.accessibleNamespaces ?? [];
  const namespace = store.namespace || manual[0] || '';
  const namespaces = useResources(manual.length ? '' : store.clusterId, 'namespaces');
  const pods = useResources(store.clusterId, 'pods', namespace);
  const deployments = useResources(store.clusterId, 'deployments', namespace);
  const statefulsets = useResources(store.clusterId, 'statefulsets', namespace);
  const daemonsets = useResources(store.clusterId, 'daemonsets', namespace);
  const jobs = useResources(store.clusterId, 'jobs', namespace);
  const cronjobs = useResources(store.clusterId, 'cronjobs', namespace);
  const services = useResources(store.clusterId, 'services', namespace);
  const sources = { Pods: pods, Deployments: deployments, StatefulSets: statefulsets, DaemonSets: daemonsets, Jobs: jobs, CronJobs: cronjobs, Services: services };
  const groups = groupApplications(Object.values(sources).flatMap(source => source.items)).filter(group => `${group.name} ${group.namespace}`.toLowerCase().includes(search.toLowerCase()));
  const loading = Object.values(sources).some(source => source.loading);
  return <section className="applications-page"><header><h1>Applications</h1><div className="applications-actions"><button className="applications-secondary" onClick={() => store.navigate('helm-releases')}><Package size={16} aria-hidden="true"/>Helm releases</button><button className="primary" onClick={openImportDeploy}><Upload size={16} aria-hidden="true"/>Import and deploy</button></div></header>
    <p className="muted">Live workloads and services grouped by part-of, instance, name, or app labels within each namespace. Unlabelled resources remain available in the resource browser.</p>
    <div className="table-tools"><select aria-label="Application namespace" value={namespace} onChange={event => store.setNamespace(event.target.value)}>{!manual.length && <option value="">All namespaces</option>}{[...new Set([...manual, ...namespaces.items.map(item => item.metadata.name!)])].map(name => <option key={name}>{name}</option>)}</select><input aria-label="Search applications" placeholder="Search applications" value={search} onChange={event => setSearch(event.target.value)}/><button onClick={() => { Object.values(sources).forEach(source => source.refresh()); namespaces.refresh(); }}>Refresh</button><span>{groups.length} applications</span></div>
    {namespaces.error && <p className="inline-error">Namespaces: {namespaces.error}</p>}
    {Object.entries(sources).filter(([, source]) => source.error).map(([name, source]) => <p className="inline-error" key={name}>{name}: {source.error} Results may be incomplete or stale.</p>)}
    {loading && <p role="status">Loading applications…</p>}
    {groups.map(group => <section className="application-card" key={JSON.stringify([group.namespace, group.name])}><h2>{group.name} <small>{group.namespace}</small></h2><table><thead><tr><th>Resource</th><th>Kind</th><th>Status</th></tr></thead><tbody>{group.resources.map(resource => <tr key={`${resource.kind}:${resource.metadata.uid ?? resource.metadata.name}`}><td><button onClick={() => { const kind = resourceKind(resource); if (kind) { store.navigate(kind, store.clusterId); store.setNamespace(group.namespace); store.select(resource); } }}>{resource.metadata.name}</button></td><td>{resource.kind}</td><td><Status resource={resource}/></td></tr>)}</tbody></table></section>)}
    {!loading && !groups.length && <p>No matching labelled applications found.</p>}
  </section>;
}
