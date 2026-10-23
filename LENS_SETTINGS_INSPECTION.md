# Lens cluster settings: runtime observations and Optic gaps

Inspected October 23, 2026 using the installed Lens desktop UI and the user's connected Kubernetes context. Read-only navigation only: no settings saved, components installed, credentials opened, or cluster resources changed. Context names, API endpoints and kubeconfig contents are intentionally omitted.

## Structure

Show Cluster Settings opens a closable workspace tab scoped to the cluster. A secondary navigation column contains General, Proxy, Terminal, Namespaces, Metrics, Lens Metrics, Cost and Node Shell. This differs materially from Optic's current informational modal.

| Section | Directly observed controls | Current Optic gap |
| --- | --- | --- |
| General | Editable cluster name; cluster icon with overflow menu; link to kubeconfig source file | Local display-name/color preferences exist separately. Settings are a modal, and source path is plain text. Icon-menu contents were not inspected. |
| Proxy | HTTP proxy address for Kubernetes API communications | No per-cluster proxy setting or explicit proxy application across transports. |
| Terminal | Starting working directory with folder picker; default namespace for kubectl | Local shell starts in the user home directory. No per-cluster working directory or configurable terminal namespace. |
| Namespaces | Manually supplied accessible namespaces; useful when namespace-list permission is absent | Namespace picker depends on listing namespaces; no manual namespace fallback. |
| Metrics | Source choices: Automatic, Prometheus, Kubernetes Metrics Server, No metrics; currently selected backend shown; category visibility controls; hide-all and reset actions | Only metrics-server polling is implemented. No selectable backend, Prometheus configuration, disabled mode or category visibility preferences. |
| Lens Metrics | Toggles for bundled Prometheus, kube-state-metrics and node-exporter, with Apply action | No component installer or lifecycle management. Toggles were not changed; installation behavior was not tested. |
| Cost | Automatic, Kubecost, OpenCost, Estimate, Off; provider detection/status | No cost source discovery, settings or cost views. Selection was not changed. |
| Node Shell | Node-shell image; optional existing image-pull secret in kube-system | Pod exec exists, but no node-shell pod lifecycle or image/pull-secret settings. No shell was launched. |

Observed metric-visibility categories: Cluster, Node, Pod, Deployment, StatefulSet, Container, Ingress, PersistentVolumeClaim, ReplicaSet, DaemonSet and Job. These were read from the dropdown without selecting anything.

## Connection and metrics observations

- A connected cluster's context menu says Disconnect, rather than Connect. Optic currently always offers Connect; it needs an explicit connection lifecycle and scoped subscription/session disposal to implement Disconnect properly.
- The source selector reported Kubernetes Metrics Server while the overview displayed a metrics configuration/unavailability message. A successful API connection alone does not establish that metrics are available; provider health needs its own status.
- Cost source detection reported no installed provider in this inspection. This is a point-in-time observation, not an enduring statement about the cluster.

## Other visible navigation gaps

The connected Lens navigator exposes Applications, Device Resources, Helm, Security Center and Cost Monitoring, in addition to the resource categories Optic already has. The home navigator also exposes AKS, EKS and GKE discovery groups. These entries were visible; their internal workflows were not inspected in this pass and must not be described as fully reverse-engineered.

## Independent implementation priorities

1. Replace the settings modal with a cluster-scoped workspace tab and persist validated per-context settings through typed IPC. Retain the existing name/color/hotbar preferences.
2. Implement terminal directory/default namespace and a manual accessible-namespace list. Explicitly distinguish namespace-list denial from resource-access denial.
3. Add metrics source and visibility settings, provider health, disabled mode, and authenticated Prometheus querying. Do not install monitoring components implicitly when a source is selected.
4. Add connection state and Disconnect with cleanup only for the selected cluster. Reconnect must refresh credentials and watches.
5. Implement proxy handling consistently for REST, watches, log streams and subprocess-backed sessions; document unsupported proxy/auth combinations instead of presenting an inert control.
6. Treat node-shell creation, monitoring-stack installation and cost integrations as separate operational features, with RBAC checks, explicit mutation previews, lifecycle cleanup and integration tests.

## Evidence limits

This pass observes UI controls and displayed states, not internal persistence formats, exact API requests, or hidden conditional fields. Prometheus-specific fields requiring changing the selected source were not inspected. Save semantics and backend effects were not tested. The report is a clean-room behavior inventory; no target implementation code, credentials or branding assets are included.


## Implementation follow-up (2026-10-23)

Optic now implements the eight-section settings workspace tab, persisted context settings, connection lifecycle, proxy configuration, terminal defaults, manual namespaces, current metrics provider selection, monitored Helm component operations, cost API/estimates and confirmed node-shell sessions. This is an independent implementation of observed workflows. Historical metrics, per-workload metric views, cloud-price estimates and full Lens feature parity are not claimed. See ARCH_SPEC.md and README.md for contracts, verification and live-cluster limitations.
