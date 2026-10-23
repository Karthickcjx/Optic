# Resource detail inspection - 2026-10-23

## Evidence and boundary

Read-only navigation in the installed Lens UI using the computer-use skill: Pods and Deployments were opened and their drawers scrolled. Lens was running without a CDP endpoint, so this inspection used visible UI rather than REA runtime capture. No cluster writes, terminal commands, configuration edits or security actions were performed. No application code or assets were copied. Resource names, endpoints and credential contents are omitted.

Observed Pod sections: metrics with time selector; creation/name/namespace/labels; owner; phase; node and IPs; service account; QoS; conditions; tolerations; affinity; volumes. Container sections showed metrics, status/readiness, image, ports/forwarding, environment, mounts, readiness probe, requests and limits. A vulnerability section required a separate operator.

Observed Deployment sections: metrics; metadata/annotations; desired/updated/total/available/unavailable replicas; selectors; strategy; conditions; tolerations; deployment revisions and related Pods.

## Independent implementation

Optic now presents structured properties, owners, annotations, conditions, pod networking/scheduling/volumes, container state/previous state/restarts/probes/requests/limits/mounts/environment references, and workload rollout/template fields. Node, Service, Ingress, storage, ConfigMap and RBAC sections are additional API-driven designs; their Lens panels were not inspected in this pass. Expandable API specification/status preserves access to other reported fields. Secret payloads remain hidden; common sensitive environment literal names and annotation names are masked. Existing log/shell/forward/edit actions remain available.

Still separate work: historical per-resource/container metrics, vulnerability scanning, owner navigation links, deployment revision browsing and related-Pod tables. This change does not claim complete Lens detail parity.
