import { securityTypes, clusterSecurityType } from '../shared/security';
import { publicUrl } from './helm';
import { validContainerShell } from '../shared/logs';
import { resourceEditSchema } from '../shared/resource-editors';
import { clusterSettingsSchema } from './cluster-settings';
import { z } from 'zod';
import { resourceKinds, type Requests } from '../shared/protocol';
const text = z.string().min(1).max(1024);
const name = z.string().min(1).max(253).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const id = z.string().uuid();
const custom = z.object({ apiVersion: z.string().regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\/v[0-9]+(?:(?:alpha|beta)[0-9]+)?$/), kind: name, plural: name, namespaced: z.boolean() });
const scope = z.object({ clusterId: text, kind: z.enum(resourceKinds), namespace: name.optional(), custom: custom.optional() });
const target = scope.extend({ name });
const actionTarget = target.extend({ uid: text, resourceVersion: text });
const nodeAction = actionTarget.extend({ kind: z.literal('nodes') });
const deploymentAction = actionTarget.extend({ kind: z.literal('deployments'), namespace: name });
const cronjobAction = actionTarget.extend({ kind: z.literal('cronjobs'), namespace: name });
const helmName = z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).max(53);
const namespace = z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).max(63);
const chart = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).max(253);
const version = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.+-]+)?$/).max(128);
const helmTarget = z.object({ clusterId: text, namespace, release: helmName });
const helmPlan = helmTarget.extend({ action: z.enum(['install', 'upgrade']), repository: helmName, chart, version, values: z.string().max(2_000_000) });
export const schemas: Record<keyof Requests, z.ZodType> = {
  'deploy:stop': z.object({ id }),
  'imports:dependencies': z.object({ id }),
  'imports:pick': z.object({ kind: z.enum(['manifests', 'folder', 'kustomize', 'chart', 'archive', 'values', 'certificate']) }),
  'imports:remote': z.object({ reference: z.string().min(1).max(2048).refine(v => /^(https|oci):\/\//.test(v)), version: z.string().max(128), username: z.string().max(256).refine(v => !v.startsWith('-')), password: z.string().max(8192), chart: z.string().max(253).optional(), caId: id.optional() }),
  'imports:dispose': z.object({ id }),
  'deploy:prepare': z.object({ clusterId: text, namespace, sourceId: id.optional(), files: z.array(z.string().max(1024)).max(2000), yaml: z.string().max(20 * 1024 * 1024).optional(), release: z.string().max(53), action: z.enum(['install', 'upgrade']), valuesIds: z.array(id).max(20), values: z.string().max(2 * 1024 * 1024) }),
  'deploy:discard': z.object({ id }),
  'deploy:start': z.object({ id }),
  'deploy:status': z.undefined(),
  'deploy:dismiss': z.object({ id }),
  'security:copy-install': z.undefined(),
  'security:reports': z.object({ clusterId: text, namespace: namespace.optional() }).strict(),
  'security:detail': z.object({ clusterId: text, namespace: namespace.optional(), type: z.enum(securityTypes), name, uid: text }).strict().refine(v => clusterSecurityType(v.type) ? !v.namespace : !!v.namespace, 'Match the report namespace scope.'),
  'nodes:drain-preview': target.extend({ kind: z.literal('nodes') }),
  'nodes:drain': nodeAction.extend({ options: z.object({ ignoreDaemonSets: z.boolean(), deleteEmptyDirData: z.boolean(), force: z.boolean(), timeoutSeconds: z.number().int().min(30).max(1800) }).strict() }),
  'deployments:revisions': target.extend({ kind: z.literal('deployments'), namespace: name }),
  'deployments:rollback': deploymentAction.extend({ revision: z.number().int().positive().max(1000000000), replicaSetUid: text }),
  'cronjobs:trigger': cronjobAction.extend({ jobName: z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).max(63) }),
  'cronjobs:suspend': cronjobAction.extend({ suspend: z.boolean() }),
  'resources:edit': actionTarget.extend({ kind: z.enum(['configmaps', 'deployments', 'statefulsets', 'daemonsets', 'replicasets', 'replicationcontrollers', 'services', 'cronjobs']), namespace: name, changes: resourceEditSchema, dryRun: z.boolean() }),
  'helm:repositories': z.undefined(),
  'helm:repository-save': z.object({ repository: z.object({ name: helmName, url: z.string().max(2048).refine(v => publicUrl(v)) }), remove: z.boolean() }),
  'helm:charts': z.object({ repository: helmName, refresh: z.boolean().optional() }),
  'helm:versions': z.object({ repository: helmName, chart }),
  'helm:chart-info': z.object({ repository: helmName, chart, version }),
  'helm:releases': z.object({ clusterId: text, namespace: namespace.optional() }),
  'helm:details': helmTarget, 'helm:preview': helmPlan,
  'helm:apply': z.object({ plan: helmPlan, token: id }),
  'helm:rollback': helmTarget.extend({ revision: z.number().int().min(1).max(1000000) }),
  'helm:uninstall': helmTarget,
  'settings:get': z.object({ clusterId: text }), 'settings:save': z.object({ clusterId: text, settings: clusterSettingsSchema }),
  'settings:directory': z.undefined(), 'settings:reveal': z.object({ clusterId: text }),
  'clusters:connect': z.object({ clusterId: text }), 'clusters:disconnect': z.object({ clusterId: text }),
  'cost:report': z.object({ clusterId: text, start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), group: z.enum(['namespace', 'node', 'controller']), includeIdle: z.boolean(), forceRefresh: z.boolean().optional() }).refine(v => v.start < v.end && v.end - v.start <= 31 * 86400000 && v.end <= Date.now() + 60000, 'Choose a past range up to 31 days.'),
  'cost:read': z.object({ clusterId: text }), 'monitoring:status': z.object({ clusterId: text }),
  'monitoring:version': z.object({ component: z.enum(['prometheus', 'kube-state-metrics', 'prometheus-node-exporter']) }),
  'monitoring:apply': z.object({ clusterId: text, changes: z.array(z.object({ component: z.enum(['prometheus', 'kube-state-metrics', 'prometheus-node-exporter']), action: z.enum(['install', 'uninstall']), version: z.string().regex(/^(?:[0-9]+\.[0-9]+\.[0-9]+)?$/) }).refine(v => v.action !== 'install' || !!v.version)).min(1).max(3) }),
  'nodeshell:open': z.object({ clusterId: text, node: name, id, cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(200) }),
  'clusters:remove': z.object({ clusterId: text }),
  'forward:start': z.object({ id, clusterId: text, namespace: name, kind: z.enum(['pods', 'services']), name, localPort: z.number().int().min(0).max(65535), remotePort: z.number().int().min(1).max(65535) }),
  'metrics:history': z.object({ clusterId: text, minutes: z.union([z.literal(5), z.literal(15), z.literal(30), z.literal(60), z.literal(360), z.literal(1440)]) }),
  'clusters:import': z.undefined(), 'clusters:import-clipboard': z.object({ yaml: z.string().min(1).max(8_000_000) }), 'metrics:read': z.object({ clusterId: text }),
  'resources:apply': z.object({ clusterId: text, namespace: name.optional(), yaml: z.string().min(1).max(2_000_000), dryRun: z.boolean() }),
  'resources:scale': target.extend({ replicas: z.number().int().min(0).max(10000) }),
  'nodes:cordon': z.object({ clusterId: text, name, unschedulable: z.boolean() }),
  'clusters:list': z.undefined(), 'clusters:health': z.object({ clusterId: text }),
  'metrics:resource': target.extend({ uid: text, container: name.optional(), minutes: z.union([z.literal(5), z.literal(15), z.literal(30), z.literal(60)]) }),
  'resources:get': scope.extend({ name: z.string().min(1).max(253).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/) }), 'resources:list': scope, 'resources:watch': scope.extend({ id }), 'resources:yaml': target,
  'resources:replace': target.extend({ yaml: z.string().min(1).max(2_000_000) }),
  'resources:delete': target, 'resources:restart': target,
  'logs:start': z.object({ id, clusterId: text, namespace: name, pod: name, container: name.optional(), tailLines: z.number().int().min(1).max(10000).optional(), previous: z.boolean().optional(), sinceTime: z.string().max(40).regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/).refine(v => Number.isFinite(Date.parse(v))).optional() }),
  'cost:export': z.object({ text: z.string().max(16_000_000), format: z.enum(['csv', 'json']) }),
  'logs:export': z.object({ text: z.string().max(8_000_000) }),
  'terminal:open': z.object({ id, clusterId: text.optional(), namespace: name.optional(), pod: name.optional(), container: name.optional(), shell: z.string().refine(validContainerShell).optional(), cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(200) }).refine(v => !v.pod || (v.clusterId && v.namespace), 'Pod terminals require cluster and namespace').refine(v => !v.shell || !!v.pod, 'Shell selection applies to pod terminals'),
  'terminal:write': z.object({ id, data: z.string().max(65536) }),
  'terminal:resize': z.object({ id, cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(200) }),
  'stream:ack': z.object({ id, seq: z.number().int().nonnegative() }), 'stream:close': z.object({ id })
};
