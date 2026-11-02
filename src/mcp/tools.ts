import type { KubeConfig } from '@kubernetes/client-node';
import { z } from 'zod';
import type { ClusterManager } from '../main/clusters';
import { AppError, fault } from '../main/errors';
import { kubeJson, kubeText } from '../main/kube-http';
import { resourcePath } from '../main/resources';
import type { BuiltinKind } from '../shared/catalog';
import type { Resource } from '../shared/protocol';
import { redactResource, redactText } from '../shared/redaction';
import { authOf, fingerprint, readAccess } from './access';

export const MAX_OUTPUT_CHARS = 200_000;

// Clusters visible to MCP clients: only kubeconfig contexts the user approved in Optic, and only while the
// context still matches what was approved. Unapproved contexts are never named to the client.
export class ApprovedClusters {
  // Kubeconfig files and approvals are re-read on every call, so edits and revocations apply immediately.
  constructor(private manager: ClusterManager, private accessFile: string) {}
  list() {
    const approvals = readAccess(this.accessFile).clusters, all = this.manager.discover().clusters;
    const approved = all.filter(c => approvals[c.id]).map(c => {
      const { config } = this.manager.get(c.id, true);
      return { id: c.id, context: c.name, defaultNamespace: c.namespace, auth: authOf(config).type, status: approvals[c.id].fingerprint === fingerprint(config) ? 'approved' : 'needs re-approval in Optic (kubeconfig changed)' };
    });
    const missing = Object.entries(approvals).filter(([id]) => !all.some(c => c.id === id)).map(([id, a]) => ({ id, context: a.context, status: 'unavailable (context no longer in kubeconfig)' }));
    return { clusters: [...approved, ...missing], unapprovedContexts: all.length - approved.length };
  }
  // Resolves a cluster by ID or unique context name. Never falls back to another context.
  get(selector: string): { id: string; name: string; namespace: string; config: KubeConfig } {
    const approvals = readAccess(this.accessFile).clusters, all = this.manager.discover().clusters;
    const matches = all.filter(c => approvals[c.id] && (c.id === selector || c.name === selector));
    if (matches.length > 1) throw new AppError('AMBIGUOUS_CLUSTER', `Several approved contexts are named "${selector}". Use the cluster id from list_clusters.`);
    const cluster = matches[0];
    if (!cluster) throw new AppError('NOT_APPROVED', `No approved cluster matches "${selector}". Use list_clusters; contexts must be approved in Optic > Cluster settings > AI access.`);
    const { config } = this.manager.get(cluster.id, true);
    if (approvals[cluster.id].fingerprint !== fingerprint(config)) throw new AppError('APPROVAL_STALE', `The kubeconfig for "${cluster.name}" changed since it was approved (server, CA or credential command). Approve it again in Optic.`);
    return { id: cluster.id, name: cluster.name, namespace: cluster.namespace, config };
  }
}

// Argument rules: Kubernetes object names are single path segments; selectors are plain text.
const segment = z.string().min(1).max(253).refine(v => v !== '.' && v !== '..' && !/[/%\\\x00-\x1f\x7f]/.test(v), 'Invalid name.');
const dns = z.string().min(1).max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'Invalid namespace.');
const selector = z.string().max(1000).refine(v => !/[\x00-\x1f\x7f]/.test(v), 'Invalid selector.');
const cluster = z.string().min(1).max(253).describe('Cluster id or context name from list_clusters.');
const page = { limit: z.number().int().min(1).max(500).default(50).describe('Items per page (max 500).'), continue: z.string().max(4096).optional().describe('Continue token from the previous page.') };
const listScope = { cluster, namespace: dns.optional().describe('Namespace; omit for all namespaces.'), labelSelector: selector.optional(), fieldSelector: selector.optional(), ...page };
const namespacedObject = { cluster, namespace: dns, name: segment }, clusterObject = { cluster, name: segment };

type List = { items: Resource[]; metadata?: { continue?: string; remainingItemCount?: number } };
const query = (values: Record<string, string | number | boolean | undefined>) => { const q = new URLSearchParams(); for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== '') q.set(k, String(v)); const s = q.toString(); return s ? `?${s}` : ''; };
const age = (r: Resource) => r.metadata.creationTimestamp;

async function listKind(config: KubeConfig, kind: BuiltinKind, args: { namespace?: string; labelSelector?: string; fieldSelector?: string; limit: number; continue?: string }) {
  const list = await kubeJson<List>(config, resourcePath({ clusterId: '', kind, namespace: args.namespace }) + query({ limit: args.limit, continue: args.continue, labelSelector: args.labelSelector, fieldSelector: args.fieldSelector }));
  if (!list || !Array.isArray(list.items)) throw new AppError('MALFORMED_RESPONSE', 'The API server returned an unexpected list response.');
  return { items: list.items, continue: list.metadata?.continue || undefined, remainingItemCount: list.metadata?.remainingItemCount };
}
async function getKind(config: KubeConfig, kind: BuiltinKind, name: string, namespace?: string) {
  const object = await kubeJson<Resource>(config, `${resourcePath({ clusterId: '', kind, namespace })}/${encodeURIComponent(name)}`);
  if (!object?.metadata) throw new AppError('MALFORMED_RESPONSE', 'The API server returned an unexpected object.');
  return redactResource(object);
}

const summaries = {
  pod: (p: Resource) => {
    const statuses: any[] = p.status?.containerStatuses ?? [], waiting = statuses.map(s => s.state?.waiting?.reason ?? s.state?.terminated?.reason).find(Boolean);
    return { name: p.metadata.name, namespace: p.metadata.namespace, phase: p.status?.phase, ready: `${statuses.filter(s => s.ready).length}/${p.spec?.containers?.length ?? statuses.length}`, restarts: statuses.reduce((n, s) => n + (s.restartCount ?? 0), 0), reason: waiting ?? p.status?.reason, node: p.spec?.nodeName, createdAt: age(p) };
  },
  deployment: (d: Resource) => ({ name: d.metadata.name, namespace: d.metadata.namespace, replicas: d.spec?.replicas, ready: d.status?.readyReplicas ?? 0, updated: d.status?.updatedReplicas ?? 0, available: d.status?.availableReplicas ?? 0, images: (d.spec?.template?.spec?.containers ?? []).map((c: any) => c.image), conditions: (d.status?.conditions ?? []).map((c: any) => `${c.type}=${c.status}${c.reason ? ` (${c.reason})` : ''}`), createdAt: age(d) }),
  service: (s: Resource) => ({ name: s.metadata.name, namespace: s.metadata.namespace, type: s.spec?.type, clusterIP: s.spec?.clusterIP, ports: (s.spec?.ports ?? []).map((p: any) => `${p.port}/${p.protocol ?? 'TCP'}${p.targetPort !== undefined ? `->${p.targetPort}` : ''}`), selector: s.spec?.selector, createdAt: age(s) }),
  node: (n: Resource) => ({ name: n.metadata.name, ready: n.status?.conditions?.find((c: any) => c.type === 'Ready')?.status ?? 'Unknown', roles: Object.keys(n.metadata.labels ?? {}).filter(l => l.startsWith('node-role.kubernetes.io/')).map(l => l.slice(24)), unschedulable: !!n.spec?.unschedulable, kubelet: n.status?.nodeInfo?.kubeletVersion, capacity: n.status?.capacity && { cpu: n.status.capacity.cpu, memory: n.status.capacity.memory, pods: n.status.capacity.pods }, taints: (n.spec?.taints ?? []).length, createdAt: age(n) }),
  namespace: (n: Resource) => ({ name: n.metadata.name, phase: n.status?.phase, labels: n.metadata.labels, createdAt: age(n) }),
  event: (e: Resource) => ({ type: e.type, reason: e.reason, message: typeof e.message === 'string' ? redactText(e.message) : undefined, object: e.involvedObject && `${e.involvedObject.kind}/${e.involvedObject.namespace ? `${e.involvedObject.namespace}/` : ''}${e.involvedObject.name}`, count: e.count ?? e.series?.count ?? 1, last: e.lastTimestamp ?? e.eventTime ?? e.metadata.creationTimestamp, source: e.source?.component ?? e.reportingComponent })
};

// Serialized tool output, bounded so a single call cannot flood the client's context.
export function output(value: unknown) {
  const text = JSON.stringify(value, null, 1);
  return text.length <= MAX_OUTPUT_CHARS ? text : `${text.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated at ${MAX_OUTPUT_CHARS} characters; narrow the request]`;
}

const readVerbs = new Set(['get', 'list', 'watch']);
async function discover(config: KubeConfig, group?: string) {
  const versions: string[] = [], unavailable: string[] = [];
  if (!group || group === 'core') versions.push('v1');
  if (group !== 'core') {
    const groups = await kubeJson<{ groups?: { name: string; preferredVersion?: { groupVersion: string } }[] }>(config, '/apis');
    for (const g of groups.groups ?? []) if (g.preferredVersion && (!group || g.name === group)) versions.push(g.preferredVersion.groupVersion);
    if (group && !versions.length) throw new AppError('NOT_FOUND', `API group "${group}" is not served by this cluster.`);
  }
  const resources: { apiVersion: string; resource: string; kind: string; namespaced: boolean; verbs: string[] }[] = [];
  // Aggregated APIs (for example metrics) can be down independently; report them instead of failing discovery.
  for (let i = 0; i < versions.length; i += 8) await Promise.all(versions.slice(i, i + 8).map(async gv => {
    try {
      const list = await kubeJson<{ resources?: { name: string; kind: string; namespaced: boolean; verbs?: string[] }[] }>(config, gv === 'v1' ? '/api/v1' : `/apis/${gv}`);
      for (const r of list.resources ?? []) if (!r.name.includes('/')) resources.push({ apiVersion: gv, resource: r.name, kind: r.kind, namespaced: r.namespaced, verbs: (r.verbs ?? []).filter(v => readVerbs.has(v)) });
    } catch { unavailable.push(gv); }
  }));
  return { resources: resources.sort((a, b) => a.apiVersion.localeCompare(b.apiVersion) || a.resource.localeCompare(b.resource)), unavailableGroupVersions: unavailable.sort() };
}

type Tool = { title: string; description: string; input: z.ZodObject<z.ZodRawShape>; run: (args: any) => Promise<unknown> };
export function tools(clusters: ApprovedClusters): Record<string, Tool> {
  const cfg = (selector: string) => clusters.get(selector).config;
  const list = (kind: BuiltinKind, summary: (r: Resource) => unknown) => async (a: any) => { const page = await listKind(cfg(a.cluster), kind, a); return { items: page.items.map(summary), continue: page.continue, remainingItemCount: page.remainingItemCount }; };
  return {
    list_clusters: { title: 'List approved clusters', description: 'List the Kubernetes contexts the user approved for AI access in Optic.', input: z.object({}), run: async () => ({ ...clusters.list(), note: 'Only contexts approved in Optic > Cluster settings > AI access are available.' }) },
    get_cluster_info: { title: 'Get cluster info', description: 'Kubernetes version and default namespace of an approved cluster.', input: z.object({ cluster }), run: async a => {
      const c = clusters.get(a.cluster), version = await kubeJson<{ gitVersion?: string; platform?: string }>(c.config, '/version');
      return { id: c.id, context: c.name, defaultNamespace: c.namespace, kubernetesVersion: version.gitVersion, platform: version.platform, auth: authOf(c.config).type };
    } },
    list_namespaces: { title: 'List namespaces', description: 'List namespaces (paginated).', input: z.object({ cluster, labelSelector: selector.optional(), ...page }), run: list('namespaces', summaries.namespace) },
    get_namespace_details: { title: 'Get namespace details', description: 'Namespace object with its resource quotas and limit ranges.', input: z.object(clusterObject), run: async a => {
      const config = cfg(a.cluster), namespace = await getKind(config, 'namespaces', a.name);
      const optional = async (path: string) => { try { return (await kubeJson<List>(config, path)).items.map(i => redactResource({ name: i.metadata.name, spec: i.spec, status: i.status })); } catch (error) { return { error: fault(error).message }; } };
      return { namespace, resourceQuotas: await optional(`/api/v1/namespaces/${encodeURIComponent(a.name)}/resourcequotas`), limitRanges: await optional(`/api/v1/namespaces/${encodeURIComponent(a.name)}/limitranges`) };
    } },
    list_pods: { title: 'List pods', description: 'List pods with phase, readiness, restarts and waiting reason (paginated).', input: z.object(listScope), run: list('pods', summaries.pod) },
    get_pod_details: { title: 'Get pod details', description: 'Full pod spec and status with sensitive values redacted.', input: z.object(namespacedObject), run: a => getKind(cfg(a.cluster), 'pods', a.name, a.namespace) },
    get_pod_logs: { title: 'Get pod logs', description: 'Recent log lines of a pod container (bounded, credentials redacted).', input: z.object({ ...namespacedObject, container: segment.optional().describe('Required when the pod has several containers.'), tailLines: z.number().int().min(1).max(5000).default(200), sinceSeconds: z.number().int().min(1).max(30 * 86400).optional(), previous: z.boolean().default(false).describe('Logs of the previous, terminated container instance.'), maxBytes: z.number().int().min(1024).max(1_000_000).default(256_000) }), run: async a => {
      const path = `/api/v1/namespaces/${encodeURIComponent(a.namespace)}/pods/${encodeURIComponent(a.name)}/log${query({ container: a.container, tailLines: a.tailLines, sinceSeconds: a.sinceSeconds, previous: a.previous || undefined, timestamps: true, limitBytes: a.maxBytes })}`;
      const { text, truncated } = await kubeText(cfg(a.cluster), path, a.maxBytes);
      return { pod: `${a.namespace}/${a.name}`, container: a.container, truncated, logs: redactText(text) };
    } },
    list_deployments: { title: 'List deployments', description: 'List deployments with replica health and images (paginated).', input: z.object(listScope), run: list('deployments', summaries.deployment) },
    get_deployment_details: { title: 'Get deployment details', description: 'Full deployment spec and status with sensitive values redacted.', input: z.object(namespacedObject), run: a => getKind(cfg(a.cluster), 'deployments', a.name, a.namespace) },
    list_services: { title: 'List services', description: 'List services with type, cluster IP, ports and selector (paginated).', input: z.object(listScope), run: list('services', summaries.service) },
    get_service_details: { title: 'Get service details', description: 'Full service object.', input: z.object(namespacedObject), run: a => getKind(cfg(a.cluster), 'services', a.name, a.namespace) },
    list_events: { title: 'List events', description: 'List events, optionally only warnings (paginated).', input: z.object({ cluster, namespace: dns.optional(), type: z.enum(['Normal', 'Warning']).optional(), ...page }), run: async a => {
      const result = await listKind(cfg(a.cluster), 'events', { ...a, fieldSelector: a.type ? `type=${a.type}` : undefined });
      return { items: result.items.map(summaries.event), continue: result.continue, remainingItemCount: result.remainingItemCount };
    } },
    get_resource_events: { title: 'Get resource events', description: 'Events recorded for one object, newest first.', input: z.object({ cluster, kind: z.string().min(1).max(63).regex(/^[A-Za-z][A-Za-z0-9]*$/), name: segment.refine(v => !/[,=!]/.test(v), 'Invalid name.'), namespace: dns.optional() }), run: async a => {
      const result = await listKind(cfg(a.cluster), 'events', { namespace: a.namespace, limit: 500, fieldSelector: `involvedObject.kind=${a.kind},involvedObject.name=${a.name}` });
      return { items: result.items.map(summaries.event).sort((x, y) => String(y.last ?? '').localeCompare(String(x.last ?? ''))).slice(0, 100) };
    } },
    list_nodes: { title: 'List nodes', description: 'List nodes with readiness, roles, kubelet version and capacity (paginated).', input: z.object({ cluster, labelSelector: selector.optional(), ...page }), run: list('nodes', summaries.node) },
    get_node_details: { title: 'Get node details', description: 'Full node object.', input: z.object(clusterObject), run: a => getKind(cfg(a.cluster), 'nodes', a.name) },
    discover_api_resources: { title: 'Discover API resources', description: 'Resource types served by the cluster (preferred versions) with their read verbs.', input: z.object({ cluster, group: z.string().max(253).regex(/^(core|[a-z0-9]([-a-z0-9.]*[a-z0-9])?)$/).optional().describe('API group, or "core"; omit for all.') }), run: a => discover(cfg(a.cluster), a.group) },
    get_resource_yaml: { title: 'Get resource YAML', description: 'Any readable object as JSON, with Secret data and sensitive values redacted. Use discover_api_resources for apiVersion and resource names.', input: z.object({ cluster, apiVersion: z.string().max(253).regex(/^(?:v1|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\/v[0-9]+(?:(?:alpha|beta)[0-9]+)?)$/), resource: z.string().max(253).regex(/^[a-z0-9][a-z0-9.-]*$/).describe('Plural resource name, e.g. "configmaps".'), namespace: dns.optional(), name: segment }), run: async a => {
      const config = cfg(a.cluster), root = a.apiVersion === 'v1' ? '/api/v1' : `/apis/${a.apiVersion}`;
      // Only resources the API server advertises with the "get" verb; subresources (exec, proxy, ...) are never reachable.
      const descriptor = (await kubeJson<{ resources?: { name: string; namespaced: boolean; verbs?: string[] }[] }>(config, root)).resources?.find(r => r.name === a.resource);
      if (!descriptor || !descriptor.verbs?.includes('get')) throw new AppError('UNSUPPORTED', `${a.apiVersion} does not serve a readable "${a.resource}" resource.`);
      if (descriptor.namespaced && !a.namespace) throw new AppError('NAMESPACE_REQUIRED', `"${a.resource}" is namespaced; provide namespace.`);
      const object = await kubeJson<Resource>(config, `${root}${descriptor.namespaced ? `/namespaces/${encodeURIComponent(a.namespace)}` : ''}/${a.resource}/${encodeURIComponent(a.name)}`);
      return redactResource(object);
    } }
  };
}

// Runs one tool and turns failures into MCP tool errors carrying the sanitized fault message only.
export async function call(tool: Tool, raw: unknown) {
  const parsed = tool.input.safeParse(raw ?? {});
  if (!parsed.success) return { isError: true, content: [{ type: 'text' as const, text: `INVALID_INPUT: ${parsed.error.issues.map(i => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ')}` }] };
  try { return { content: [{ type: 'text' as const, text: output(await tool.run(parsed.data)) }] }; }
  catch (error) { const f = fault(error); return { isError: true, content: [{ type: 'text' as const, text: `${f.code}: ${f.message}` }] }; }
}
