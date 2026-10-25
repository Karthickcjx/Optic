import { resourceSeverity } from '../../shared/severity';
import { useMemo, useState, type ReactNode } from 'react';
import { flexRender, getCoreRowModel, getFilteredRowModel, getPaginationRowModel, getSortedRowModel, useReactTable, type ColumnDef, type SortingState, type RowSelectionState } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, Search, Trash2 } from 'lucide-react';
import type { Resource, ResourceKind } from '../../shared/protocol';
import { resourceStatus } from '../../shared/status';
import { request } from './api';
import { useStore } from './store';
export function Status({ resource }: { resource: Resource }) {
  const status = resourceStatus(resource);
  const tone = resourceSeverity(resource) === 'error' || /Crash|Error|Failed|NotReady|BackOff/.test(status) ? 'bad' : resourceSeverity(resource) === 'warning' || /Pending|ContainerCreating|Terminating|Suspended/.test(status) ? 'pending' : 'good';
  return <span className={`status ${tone}`}><i/>{status}</span>;
}
export function age(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  return minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}
export function ResourceTable({ items, loading, onSelect, selectedId, kind, label, controls, actions }: { items: Resource[]; loading: boolean; onSelect: (resource: Resource) => void; selectedId?: string; kind: ResourceKind; label: string; controls?: ReactNode; actions?: ReactNode }) {
  const [search, setSearch] = useState(''), [sorting, setSorting] = useState<SortingState>([{ id: 'name', desc: false }]), [selection, setSelection] = useState<RowSelectionState>({});
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false); const store = useStore();
  const columns = useMemo<ColumnDef<Resource>[]>(() => {
    const textColumn = (id: string, header: string, accessorFn: (r: Resource) => unknown): ColumnDef<Resource> => ({ id, header, accessorFn, cell: ctx => String(ctx.getValue() ?? '—') });
    const result: ColumnDef<Resource>[] = [
      { id: 'select', enableSorting: false, header: ({ table }) => <input type="checkbox" aria-label="Select all rows on this page" checked={table.getIsAllPageRowsSelected()} onChange={table.getToggleAllPageRowsSelectedHandler()}/>, cell: ({ row }) => <input type="checkbox" aria-label={`Select ${row.original.metadata.name}`} checked={row.getIsSelected()} onClick={e => e.stopPropagation()} onChange={row.getToggleSelectedHandler()}/> },
      { id: 'name', header: 'Name', accessorFn: r => r.metadata.name, cell: ctx => <span className="resource-name">{String(ctx.getValue())}</span> },
      textColumn('namespace', 'Namespace', r => r.metadata.namespace ?? '—')
    ];
    const ageColumn = (id: string, header: string, timestamp: (r: Resource) => string | undefined): ColumnDef<Resource> => ({ id, header, accessorFn: r => { const value = Date.parse(timestamp(r) ?? ''); return Number.isFinite(value) ? -value : undefined; }, sortingFn: 'basic', sortDescFirst: false, sortUndefined: 'last', cell: ctx => age(timestamp(ctx.row.original)) });
    if (kind === 'pods') result.push(
      textColumn('containers', 'Containers', r => `${r.status?.containerStatuses?.filter((c: any) => c.ready).length ?? 0}/${r.spec?.containers?.length ?? 0}`),
      textColumn('restarts', 'Restarts', r => r.status?.containerStatuses?.reduce((sum: number, c: any) => sum + (c.restartCount ?? 0), 0) ?? 0),
      textColumn('node', 'Node', r => r.spec?.nodeName), textColumn('qos', 'QoS', r => r.status?.qosClass)
    );
    if (['deployments','statefulsets','replicasets','replicationcontrollers'].includes(kind)) result.push(textColumn('replicas', 'Replicas', r => `${r.status?.readyReplicas ?? 0}/${r.spec?.replicas ?? 1}`));
    if (kind === 'daemonsets') result.push(textColumn('scheduled', 'Desired', r => r.status?.desiredNumberScheduled), textColumn('ready', 'Ready', r => r.status?.numberReady));
    if (kind === 'jobs') result.push(textColumn('completions', 'Completions', r => `${r.status?.succeeded ?? 0}/${r.spec?.completions ?? 1}`));
    if (kind === 'cronjobs') result.push(textColumn('schedule', 'Schedule', r => r.spec?.schedule), ageColumn('last', 'Last schedule', r => r.status?.lastScheduleTime));
    if (kind === 'nodes') result.push(textColumn('roles', 'Roles', r => Object.keys(r.metadata.labels ?? {}).filter(k => k.startsWith('node-role.kubernetes.io/')).map(k => k.split('/')[1]).join(', ') || 'worker'), textColumn('version', 'Version', r => r.status?.nodeInfo?.kubeletVersion), textColumn('os', 'OS', r => r.status?.nodeInfo?.osImage));
    if (kind === 'services') result.push(textColumn('type', 'Type', r => r.spec?.type), textColumn('ip', 'Cluster IP', r => r.spec?.clusterIP), textColumn('ports', 'Ports', r => r.spec?.ports?.map((p: any) => `${p.port}/${p.protocol}`).join(', ')));
    if (kind === 'ingresses') result.push(textColumn('hosts', 'Hosts', r => r.spec?.rules?.map((rule: any) => rule.host).join(', ')), textColumn('class', 'Class', r => r.spec?.ingressClassName));
    if (kind === 'persistentvolumeclaims') result.push(textColumn('capacity', 'Capacity', r => r.status?.capacity?.storage), textColumn('storage', 'Storage class', r => r.spec?.storageClassName));
    if (kind === 'priorityclasses') result.push(textColumn('value', 'Priority', r => r.value), textColumn('default', 'Global default', r => r.globalDefault ?? false), textColumn('preemption', 'Preemption policy', r => r.preemptionPolicy ?? 'PreemptLowerPriority'));
    if (kind === 'runtimeclasses') result.push(textColumn('handler', 'Handler', r => r.handler));
    if (kind === 'leases') result.push(textColumn('holder', 'Holder', r => r.spec?.holderIdentity), textColumn('duration', 'Duration (s)', r => r.spec?.leaseDurationSeconds), textColumn('renew', 'Renew time', r => r.spec?.renewTime));
    if (kind.endsWith('webhookconfigurations')) result.push(textColumn('webhooks', 'Webhooks', r => r.webhooks?.length ?? 0));
    if (kind.endsWith('admissionpolicies')) result.push(textColumn('failure', 'Failure policy', r => r.spec?.failurePolicy ?? 'Fail'), textColumn('checks', 'Expressions', r => (r.spec?.validations ?? r.spec?.mutations)?.length ?? 0));
    if (kind.endsWith('admissionpolicybindings')) result.push(textColumn('policy', 'Policy', r => r.spec?.policyName), textColumn('actions', 'Validation actions', r => r.spec?.validationActions?.join(', ')));
    if (kind === 'events') result.push(textColumn('reason', 'Reason', r => r.reason), textColumn('message', 'Message', r => r.message), textColumn('count', 'Count', r => r.count));
    if (kind === 'customresourcedefinitions') result.push(textColumn('group', 'Group', r => r.spec?.group), textColumn('scope', 'Scope', r => r.spec?.scope));
    result.push(ageColumn('age', 'Age', r => r.metadata.creationTimestamp), { id: 'status', header: 'Status', accessorFn: resourceStatus, cell: ctx => <Status resource={ctx.row.original}/> });
    return result;
  }, [kind]);
  const table = useReactTable({ data: items, columns, getRowId: r => r.metadata.uid ?? `${r.metadata.namespace}/${r.metadata.name}`, state: { globalFilter: search, sorting, rowSelection: selection }, onGlobalFilterChange: setSearch, onSortingChange: setSorting, onRowSelectionChange: setSelection, getCoreRowModel: getCoreRowModel(), getFilteredRowModel: getFilteredRowModel(), getSortedRowModel: getSortedRowModel(), getPaginationRowModel: getPaginationRowModel(), initialState: { pagination: { pageSize: 50 } } });
  const selected = table.getSelectedRowModel().rows;
  const removeSelected = async () => {
    setBusy(true); let failures = 0;
    for (const row of selected) { try { await request('resources:delete', { clusterId: store.clusterId, kind, custom: store.custom, name: row.original.metadata.name!, namespace: row.original.metadata.namespace }); } catch { failures++; } }
    if (failures) store.notify(`${failures} resource deletion(s) failed. Check permissions and refresh the list.`);
    setBusy(false); setConfirm(false); setSelection({});
  };
  const exportRows = () => { const blob = new Blob([JSON.stringify(table.getFilteredRowModel().rows.map(r => r.original), null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${kind}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
  return <><div className="table-tools">{controls}<label className="search"><Search size={13}/><input aria-label={`Search ${label}`} placeholder={`Search ${label}…`} value={search} onChange={e => setSearch(e.target.value)}/></label><button title="Export visible resources" onClick={exportRows}><Download size={15}/></button><span>{table.getFilteredRowModel().rows.length} items</span><div className="toolbar-spacer"/>{!!selected.length && <button className="danger" onClick={() => setConfirm(true)}><Trash2 size={13}/>{selected.length} selected</button>}{actions}</div>
    <div className="table-scroll"><table><thead>{table.getHeaderGroups().map(group => <tr key={group.id}>{group.headers.map(header => <th key={header.id}>{header.id === 'select' ? flexRender(header.column.columnDef.header, header.getContext()) : <button onClick={header.column.getToggleSortingHandler()}>{flexRender(header.column.columnDef.header, header.getContext())}{header.column.getIsSorted() === 'asc' ? <ArrowUp size={11}/> : header.column.getIsSorted() === 'desc' ? <ArrowDown size={11}/> : null}</button>}</th>)}</tr>)}</thead><tbody>{table.getRowModel().rows.map(row => <tr key={row.id} tabIndex={0} className={`resource-row severity-${resourceSeverity(row.original)} ${row.original.metadata.uid === selectedId ? 'selected' : ''}`} onClick={() => onSelect(row.original)} onKeyDown={e => { if (e.target === e.currentTarget && e.key === 'Enter') onSelect(row.original); }}>{row.getVisibleCells().map(cell => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr>)}</tbody></table>{!table.getRowModel().rows.length && <div className="empty compact"><h3>{loading ? `Loading ${label.toLowerCase()}…` : search ? 'No matching resources' : 'No resources found'}</h3><p>{loading ? 'Waiting for the Kubernetes API' : 'Choose another namespace or adjust your filters.'}</p></div>}</div>
    {table.getPageCount() > 1 && <div className="pagination"><span>Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}</span><button disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}><ChevronLeft size={14}/></button><button disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}><ChevronRight size={14}/></button></div>}
    {confirm && <div className="modal-backdrop"><section className="confirm-modal"><h2>Delete {selected.length} resources?</h2><p>This deletes the selected resources from {store.clusters.find(c => c.id === store.clusterId)?.name}. Dependent resources may also be deleted by Kubernetes.</p><footer><button disabled={busy} onClick={() => setConfirm(false)}>Cancel</button><button className="danger" disabled={busy} onClick={() => void removeSelected()}>{busy ? 'Deleting…' : 'Confirm deletion'}</button></footer></section></div>}
  </>;
}
