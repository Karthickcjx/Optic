import { stringify } from 'yaml';
import { catalog, type BuiltinKind, type CustomType } from './catalog';

// Starter manifests are editable examples; server-side dry-run remains mandatory.
export function manifestTemplate(kind: BuiltinKind | 'custom', namespace = 'default', custom?: CustomType): string {
  const descriptor = kind === 'custom' ? custom : catalog[kind];
  if (!descriptor) return '# Select a custom resource type or paste a manifest with apiVersion, kind and metadata.\n';
  const labels = { app: 'example' };
  const container = { name: 'app', image: 'nginx:stable', ports: [{ containerPort: 80 }] };
  const pod = { containers: [container] };
  const template = { metadata: { labels }, spec: pod };
  const selector = { matchLabels: labels };
  const rules = [{ apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'watch'] }];
  const matchConstraints = { resourceRules: [{ apiGroups: [''], apiVersions: ['v1'], operations: ['CREATE', 'UPDATE'], resources: ['pods'] }] };
  const webhook = { name: 'example.example.com', admissionReviewVersions: ['v1'], sideEffects: 'None', failurePolicy: 'Ignore', clientConfig: { service: { namespace: namespace || 'default', name: 'example-webhook', path: '/validate', port: 443 } }, rules: matchConstraints.resourceRules };
  const bodies: Record<BuiltinKind, object> = {
    pods: { metadata: { labels }, spec: pod },
    deployments: { spec: { replicas: 1, selector, template } },
    daemonsets: { spec: { selector, template } },
    statefulsets: { spec: { serviceName: 'example-headless', replicas: 1, selector, template } },
    replicasets: { spec: { replicas: 1, selector, template } },
    replicationcontrollers: { spec: { replicas: 1, selector: labels, template } },
    jobs: { spec: { template: { spec: { restartPolicy: 'Never', containers: [{ name: 'job', image: 'busybox:stable', command: ['sh', '-c', 'echo Hello'] }] } }, backoffLimit: 2 } },
    cronjobs: { spec: { schedule: '0 * * * *', jobTemplate: { spec: { template: { spec: { restartPolicy: 'Never', containers: [{ name: 'job', image: 'busybox:stable', command: ['sh', '-c', 'echo Hello'] }] } } } } } },
    configmaps: { data: { example: 'value' } },
    secrets: { type: 'Opaque', stringData: { example: 'replace-me' } },
    horizontalpodautoscalers: { spec: { scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'example-deployment' }, minReplicas: 1, maxReplicas: 3, metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } } }] } },
    poddisruptionbudgets: { spec: { maxUnavailable: 1, selector } },
    resourcequotas: { spec: { hard: { pods: '10', 'requests.cpu': '2', 'requests.memory': '4Gi' } } },
    limitranges: { spec: { limits: [{ type: 'Container', default: { cpu: '500m', memory: '256Mi' }, defaultRequest: { cpu: '100m', memory: '128Mi' } }] } },
    priorityclasses: { value: 1000, globalDefault: false, description: 'Example workload priority' },
    runtimeclasses: { handler: 'replace-with-installed-runtime-handler' },
    leases: { spec: { holderIdentity: 'example-holder', leaseDurationSeconds: 30 } },
    mutatingwebhookconfigurations: { webhooks: [{ ...webhook, clientConfig: { service: { ...webhook.clientConfig.service, path: '/mutate' } } }] },
    validatingwebhookconfigurations: { webhooks: [webhook] },
    validatingadmissionpolicies: { spec: { failurePolicy: 'Fail', matchConstraints, validations: [{ expression: 'true', message: 'Replace this expression with your validation rule' }] } },
    validatingadmissionpolicybindings: { spec: { policyName: 'example-validatingadmissionpolicy', validationActions: ['Warn'], matchResources: { namespaceSelector: { matchLabels: { 'policy.example.com/enabled': 'true' } } } } },
    mutatingadmissionpolicies: { spec: { failurePolicy: 'Ignore', reinvocationPolicy: 'IfNeeded', matchConstraints, mutations: [{ patchType: 'ApplyConfiguration', applyConfiguration: { expression: 'Object{metadata: Object.metadata{labels: {"example.com/managed": "true"}}}' } }] } },
    mutatingadmissionpolicybindings: { spec: { policyName: 'example-mutatingadmissionpolicy', matchResources: { namespaceSelector: { matchLabels: { 'policy.example.com/enabled': 'true' } } } } },
    services: { spec: { selector: labels, ports: [{ port: 80, targetPort: 80 }], type: 'ClusterIP' } },
    endpoints: { subsets: [{ addresses: [{ ip: '192.0.2.1' }], ports: [{ port: 80 }] }] },
    ingresses: { spec: { rules: [{ host: 'example.test', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'example-service', port: { number: 80 } } } }] } }] } },
    networkpolicies: { spec: { podSelector: selector, policyTypes: ['Ingress'], ingress: [{ from: [{ podSelector: selector }] }] } },
    persistentvolumeclaims: { spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } } },
    persistentvolumes: { spec: { capacity: { storage: '1Gi' }, accessModes: ['ReadWriteOnce'], persistentVolumeReclaimPolicy: 'Retain', csi: { driver: 'replace-with-csi-driver', volumeHandle: 'replace-with-volume-id' } } },
    storageclasses: { provisioner: 'replace-with-csi-driver', reclaimPolicy: 'Retain', volumeBindingMode: 'WaitForFirstConsumer' },
    serviceaccounts: { automountServiceAccountToken: false },
    roles: { rules },
    clusterroles: { rules },
    rolebindings: { subjects: [{ kind: 'ServiceAccount', name: 'example-serviceaccount', namespace: namespace || 'default' }], roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'example-role' } },
    clusterrolebindings: { subjects: [{ kind: 'ServiceAccount', name: 'example-serviceaccount', namespace: namespace || 'default' }], roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'example-clusterrole' } },
    nodes: { spec: { unschedulable: true } },
    namespaces: {},
    events: { involvedObject: { apiVersion: 'v1', kind: 'Pod', name: 'example-pod', namespace: namespace || 'default' }, reason: 'Example', message: 'Example event', type: 'Normal' },
    customresourcedefinitions: { spec: { group: 'example.com', names: { plural: 'widgets', singular: 'widget', kind: 'Widget' }, scope: 'Namespaced', versions: [{ name: 'v1', served: true, storage: true, schema: { openAPIV3Schema: { type: 'object', properties: { spec: { type: 'object', properties: { message: { type: 'string' } } } } } } }] } }
  };
  const body = kind === 'custom' ? { spec: {} } : bodies[kind];
  const name = kind === 'configmaps' ? 'example-config' : kind === 'customresourcedefinitions' ? 'widgets.example.com' : `example-${descriptor.kind.toLowerCase()}`;
  const { metadata = {}, ...fields } = body as { metadata?: object; [key: string]: unknown };
  const note = kind === 'custom' ? '# Fill in fields required by this custom resource schema.\n' : '# Starter example: review images, selectors and referenced resources before applying.\n';
  return note + stringify({ apiVersion: descriptor.apiVersion, kind: descriptor.kind, metadata: { name, ...(descriptor.namespaced ? { namespace: namespace || 'default' } : {}), ...metadata }, ...fields });
}
