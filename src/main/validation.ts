import { clusterSettingsSchema } from './cluster-settings';
import { z } from 'zod';
import { resourceKinds, type Requests } from '../shared/protocol';
const text = z.string().min(1).max(1024);
const name = z.string().min(1).max(253).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const id = z.string().uuid();
const custom = z.object({ apiVersion: z.string().regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\/v[0-9]+(?:(?:alpha|beta)[0-9]+)?$/), kind: name, plural: name, namespaced: z.boolean() });
const scope = z.object({ clusterId: text, kind: z.enum(resourceKinds), namespace: name.optional(), custom: custom.optional() });
const target = scope.extend({ name });
export const schemas: Record<keyof Requests, z.ZodType> = {
  'settings:get': z.object({ clusterId: text }), 'settings:save': z.object({ clusterId: text, settings: clusterSettingsSchema }),
  'settings:directory': z.undefined(), 'settings:reveal': z.object({ clusterId: text }),
  'clusters:connect': z.object({ clusterId: text }), 'clusters:disconnect': z.object({ clusterId: text }),
  'cost:read': z.object({ clusterId: text }), 'monitoring:status': z.object({ clusterId: text }),
  'monitoring:version': z.object({ component: z.enum(['prometheus', 'kube-state-metrics', 'prometheus-node-exporter']) }),
  'monitoring:apply': z.object({ clusterId: text, changes: z.array(z.object({ component: z.enum(['prometheus', 'kube-state-metrics', 'prometheus-node-exporter']), action: z.enum(['install', 'uninstall']), version: z.string().regex(/^(?:[0-9]+\.[0-9]+\.[0-9]+)?$/) }).refine(v => v.action !== 'install' || !!v.version)).min(1).max(3) }),
  'nodeshell:open': z.object({ clusterId: text, node: name, id, cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(200) }),
  'clusters:remove': z.object({ clusterId: text }),
  'forward:start': z.object({ id, clusterId: text, namespace: name, kind: z.enum(['pods', 'services']), name, localPort: z.number().int().min(0).max(65535), remotePort: z.number().int().min(1).max(65535) }),
  'clusters:import': z.undefined(), 'clusters:import-clipboard': z.object({ yaml: z.string().min(1).max(8_000_000) }), 'metrics:read': z.object({ clusterId: text }),
  'resources:apply': z.object({ clusterId: text, namespace: name.optional(), yaml: z.string().min(1).max(2_000_000), dryRun: z.boolean() }),
  'resources:scale': target.extend({ replicas: z.number().int().min(0).max(10000) }),
  'nodes:cordon': z.object({ clusterId: text, name, unschedulable: z.boolean() }),
  'clusters:list': z.undefined(), 'clusters:health': z.object({ clusterId: text }),
  'resources:list': scope, 'resources:watch': scope.extend({ id }), 'resources:yaml': target,
  'resources:replace': target.extend({ yaml: z.string().min(1).max(2_000_000) }),
  'resources:delete': target, 'resources:restart': target,
  'logs:start': z.object({ id, clusterId: text, namespace: name, pod: name, container: name.optional(), tailLines: z.number().int().min(1).max(10000).optional(), previous: z.boolean().optional() }),
  'terminal:open': z.object({ id, clusterId: text.optional(), namespace: name.optional(), pod: name.optional(), container: name.optional(), cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(200) }).refine(v => !v.pod || (v.clusterId && v.namespace), 'Pod terminals require cluster and namespace'),
  'terminal:write': z.object({ id, data: z.string().max(65536) }),
  'terminal:resize': z.object({ id, cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(200) }),
  'stream:ack': z.object({ id, seq: z.number().int().nonnegative() }), 'stream:close': z.object({ id })
};
