import type { ReactNode } from 'react';
import type { Resource } from '../../shared/protocol';

function display(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'Not reported';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}
function Fields({ rows }: { rows: [string, unknown][] }) {
  return <dl className="property-fields">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{display(value)}</dd></div>)}</dl>;
}
function Section({ title, children }: { title: string; children: ReactNode }) { return <section className="property-section"><h3>{title}</h3>{children}</section>; }
function Structured({ title, value }: { title: string; value: unknown }) {
  if (value === undefined || value === null) return null;
  return <details className="structured-property"><summary>{title}</summary><pre>{display(value)}</pre></details>;
}
function Conditions({ items }: { items: any[] }) {
  return <Section title="Conditions">{items.length ? items.map((c, i) => <div className="condition-card" key={`${c.type}-${i}`}><strong>{c.type}: {c.status}</strong><Fields rows={[["Reason", c.reason], ["Message", c.message], ["Last transition", c.lastTransitionTime], ["Last heartbeat", c.lastHeartbeatTime]]}/></div>) : <p className="muted">No conditions reported.</p>}</Section>;
}
export function ContainerProperties({ container: c, status, category }: { container: any; status?: any; category: string }) {
  const state = status?.state && Object.entries(status.state)[0];
  return <div className="container-properties"><Fields rows={[
    ['Container type', category], ['State', state ? state[0] : undefined], ['Ready', status?.ready], ['Started', status?.started], ['Restarts', status?.restartCount],
    ['Image pull policy', c.imagePullPolicy], ['Image ID', status?.imageID], ['Container ID', status?.containerID],
    ['Ports', c.ports], ['Requests', c.resources?.requests], ['Limits', c.resources?.limits], ['Working directory', c.workingDir]
  ]}/><Structured title="Current state details" value={state?.[1]}/><Structured title="Previous state" value={status?.lastState}/><Structured title="Command and arguments" value={c.command || c.args ? { command: c.command, args: c.args } : undefined}/>
  <Structured title="Environment" value={c.env?.map((e: any) => ({ name: e.name, ...(e.valueFrom ? { source: e.valueFrom } : { value: /password|secret|token|credential|api.?key/i.test(e.name) ? '[redacted]' : e.value }) }))}/><Structured title="Environment sources" value={c.envFrom}/><Structured title="Volume mounts" value={c.volumeMounts}/><Structured title="Volume devices" value={c.volumeDevices}/>
  <Structured title="Readiness probe" value={c.readinessProbe}/><Structured title="Liveness probe" value={c.livenessProbe}/><Structured title="Startup probe" value={c.startupProbe}/><Structured title="Security context" value={c.securityContext}/><Structured title="Lifecycle hooks" value={c.lifecycle}/></div>;
}
export function ResourceProperties({ resource: r }: { resource: Resource }) {
  const s = r.spec ?? {}, status = r.status ?? {}, kind = r.kind;
  const podSpec = kind === 'Pod' ? s : s.template?.spec ?? s.jobTemplate?.spec?.template?.spec;
  const annotations = Object.fromEntries(Object.entries(r.metadata.annotations ?? {}).map(([key, value]) => [key, /last-applied-configuration|password|secret|token|credential/i.test(key) ? '[hidden]' : value]));
  const workload = ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'ReplicationController', 'Job', 'CronJob'].includes(kind ?? '');
  return <>
    <Section title="Properties"><Fields rows={[["API version", r.apiVersion], ["Resource version", r.metadata.resourceVersion], ["Generation", r.metadata.generation], ["Deletion timestamp", r.metadata.deletionTimestamp], ["Finalizers", r.metadata.finalizers]]}/><Structured title="Annotations" value={annotations}/><Structured title="Owners / Controlled by" value={r.metadata.ownerReferences}/></Section>
    {kind === 'Pod' && <Section title="Pod status"><Fields rows={[["Phase", status.phase], ["Reason", status.reason], ["Message", status.message], ["Node", s.nodeName], ["Pod IP", status.podIP], ["Pod IPs", status.podIPs], ["Host IP", status.hostIP], ["QoS class", status.qosClass], ["Start time", status.startTime]]}/></Section>}
    {workload && <Section title="Workload"><Fields rows={[["Desired replicas", s.replicas ?? s.parallelism], ["Total replicas", status.replicas], ["Ready replicas", status.readyReplicas ?? status.numberReady], ["Updated replicas", status.updatedReplicas ?? status.updatedNumberScheduled], ["Available replicas", status.availableReplicas ?? status.numberAvailable], ["Unavailable replicas", status.unavailableReplicas ?? status.numberUnavailable], ["Desired scheduled", status.desiredNumberScheduled], ["Observed generation", status.observedGeneration], ["Service name", s.serviceName]]}/><Structured title="Selector" value={s.selector}/><Structured title="Update strategy" value={s.strategy ?? s.updateStrategy}/><Structured title="Job execution" value={['Job', 'CronJob'].includes(kind ?? '') ? { schedule: s.schedule, timeZone: s.timeZone, suspend: s.suspend, concurrencyPolicy: s.concurrencyPolicy, completions: s.completions, parallelism: s.parallelism, backoffLimit: s.backoffLimit, active: status.active, succeeded: status.succeeded, failed: status.failed, startTime: status.startTime, completionTime: status.completionTime, lastScheduleTime: status.lastScheduleTime } : undefined}/></Section>}
    {podSpec && <Section title="Scheduling and pod configuration"><Fields rows={[["Service account", podSpec.serviceAccountName], ["Priority class", podSpec.priorityClassName], ["Priority", podSpec.priority], ["Scheduler", podSpec.schedulerName], ["Restart policy", podSpec.restartPolicy], ["DNS policy", podSpec.dnsPolicy], ["Host network", podSpec.hostNetwork], ["Termination grace period (seconds)", podSpec.terminationGracePeriodSeconds]]}/><Structured title="Node selector" value={podSpec.nodeSelector}/><Structured title="Tolerations" value={podSpec.tolerations}/><Structured title="Affinity" value={podSpec.affinity}/><Structured title="Topology spread constraints" value={podSpec.topologySpreadConstraints}/><Structured title="Pod security context" value={podSpec.securityContext}/><Structured title="Image pull secrets (references)" value={podSpec.imagePullSecrets}/><Structured title="Volumes" value={podSpec.volumes}/></Section>}
    {kind === 'Node' && <Section title="Node system and capacity"><Fields rows={[["Scheduling", s.unschedulable ? 'Cordoned' : 'Enabled'], ["Provider ID", s.providerID], ["Pod CIDRs", s.podCIDRs ?? s.podCIDR], ["Addresses", status.addresses], ["Capacity", status.capacity], ["Allocatable", status.allocatable], ["System information", status.nodeInfo]]}/><Structured title="Taints" value={s.taints}/><Structured title="Attached volumes" value={status.volumesAttached}/><Structured title="Volumes in use" value={status.volumesInUse}/></Section>}
    {kind === 'Service' && <Section title="Service networking"><Fields rows={[["Type", s.type], ["Cluster IPs", s.clusterIPs ?? s.clusterIP], ["External IPs", s.externalIPs], ["External name", s.externalName], ["IP families", s.ipFamilies], ["IP family policy", s.ipFamilyPolicy], ["Session affinity", s.sessionAffinity], ["External traffic policy", s.externalTrafficPolicy], ["Internal traffic policy", s.internalTrafficPolicy], ["Health check node port", s.healthCheckNodePort]]}/><Structured title="Selector" value={s.selector}/><Structured title="Service ports" value={s.ports}/><Structured title="Load balancer" value={status.loadBalancer}/></Section>}
    {kind === 'Ingress' && <Section title="Ingress routing"><Fields rows={[["Ingress class", s.ingressClassName]]}/><Structured title="Rules and paths" value={s.rules}/><Structured title="Default backend" value={s.defaultBackend}/><Structured title="TLS references" value={s.tls}/><Structured title="Load balancer" value={status.loadBalancer}/></Section>}
    {['PersistentVolume', 'PersistentVolumeClaim', 'StorageClass'].includes(kind ?? '') && <Section title="Storage"><Fields rows={[["Phase", status.phase], ["Storage class", s.storageClassName], ["Volume", s.volumeName], ["Volume mode", s.volumeMode], ["Access modes", s.accessModes], ["Capacity", status.capacity ?? s.capacity], ["Requested resources", s.resources], ["Reclaim policy", s.persistentVolumeReclaimPolicy ?? r.reclaimPolicy], ["Provisioner", r.provisioner], ["Binding mode", r.volumeBindingMode], ["Allow expansion", r.allowVolumeExpansion]]}/><Structured title="Claim reference" value={s.claimRef}/><Structured title="CSI volume" value={s.csi}/><Structured title="Storage parameters" value={r.parameters}/></Section>}
    {kind === 'ConfigMap' && <Section title="ConfigMap data"><Fields rows={[["Immutable", r.immutable], ["Text keys", Object.keys(r.data ?? {})], ["Binary keys", Object.keys(r.binaryData ?? {})]]}/><Structured title="Text data" value={r.data}/></Section>}
    {kind === 'Secret' && <Section title="Secret metadata"><Fields rows={[["Type", r.type], ["Immutable", r.immutable]]}/><p className="muted">Secret values remain redacted.</p></Section>}
    {r.rules && <Section title="Access rules"><Structured title="Rules" value={r.rules}/></Section>}{r.roleRef && <Section title="Role binding"><Structured title="Role reference" value={r.roleRef}/><Structured title="Subjects" value={r.subjects}/></Section>}
    {(status.conditions || kind === 'Pod' || workload || kind === 'Node') && <Conditions items={status.conditions ?? []}/>}
    {podSpec && kind !== 'Pod' && <Section title="Pod template containers">{[...(podSpec.containers ?? []), ...(podSpec.initContainers ?? [])].map((c: any) => <details className="container-card" key={c.name}><summary>{c.name} - {c.image}</summary><ContainerProperties container={c} category="Template"/></details>)}</Section>}
    {!['Pod', 'Secret', 'ConfigMap'].includes(kind ?? '') && <Section title="Additional API details"><Structured title="Specification" value={r.spec}/><Structured title="Status" value={r.status}/></Section>}
  </>;
}
