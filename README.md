# Optic

An independent Kubernetes desktop workspace built with Electron, TypeScript, React, Zustand and Tailwind. Includes live resource tables, YAML details/editing, pod events, log streams and tabbed native terminals.

## Run

Requires Node.js 24+, npm, and a local kubeconfig. Pod terminals also require `kubectl` on PATH. On supported Windows/macOS architectures node-pty includes native prebuilds; other platforms need a compiler toolchain for its installation.

```sh
npm ci
npm run dev
```

For a production build:

```sh
npm run build
npm start
```

The app reads `~/.kube/config` and `KUBECONFIG`. Use the reload button after changing these files. Selecting a context does not change the original kubeconfig. For an isolated profile, set `WORKBENCH_KUBECONFIG` to an exclusive path list before launching.

Select a resource to open its details. Pod container cards open logs or a shell. Workload details offer rollout restart and scaling where supported; Node details offer cordon/uncordon. Delete, YAML save and restart show confirmation before changing the cluster. Local terminals are available even without a kubeconfig. Pod shell currently requires `/bin/sh` in the container.

## Applications and configuration navigation

Applications groups live Pods, Deployments, StatefulSets, DaemonSets, Jobs, CronJobs and Services by application labels within each namespace. Search and namespace filters narrow the results; resource links open the existing detail drawer. Resources without application labels stay in their normal resource lists. Permission failures are displayed per resource type, so partial results are explicit.

Config includes Priority Classes, Runtime Classes, Leases, Mutating/Validating Webhook Configurations, and a nested Admission Policies section with validating/mutating policies and bindings. These use the existing Kubernetes list/watch, details, YAML editing and confirmed deletion flows. Admission-policy starter manifests use `admissionregistration.k8s.io/v1`. Mutating-policy views discover the served API, preferring `v1` and falling back to `v1beta1` for older clusters; existing YAML retains that served version. For new policies on older clusters, set the manifest API version to the version they serve. The selected cluster must serve these APIs and permit access; Optic does not enable cluster feature gates automatically.

## Validate and package

```sh
npm test
npm run test:smoke
npm run package
```

The smoke test uses a local fake Kubernetes API and an isolated temporary kubeconfig; it never needs or mutates a real cluster. It launches the actual Electron build and native PTY. Screenshot output is written to `artifacts/dashboard.png` and `artifacts/overview.png` (ignored by Git).

Verified on Windows x64: TypeScript/production build, all 39 unit tests, Electron smoke test and unpacked application build. The October 23 rebuilt executable was blocked at launch by this machine's organizational Device Guard policy, so its packaged runtime test could not complete. The source build passes through the development Electron runtime; use `npm run dev` for that workflow. The smoke test includes metrics, tabs, search, scaling, restart, cordon, manifest dry-run/apply and expired-watch recovery and verifies that delete is not sent before confirmation. Live-cluster interoperability and macOS/Linux packages have not been verified.

To test an unpacked Windows build in PowerShell:

```powershell
$env:WORKBENCH_TEST_EXECUTABLE = "$PWD/release/win-unpacked/Optic.exe"
node tests/smoke.mjs
Remove-Item Env:WORKBENCH_TEST_EXECUTABLE
```

At initial validation, `npm audit --omit=dev` reported zero vulnerabilities. The full audit reported 8 moderate advisories in the electron-builder development dependency chain; no forced downgrade was applied.

`npm run package` produces an unpacked application in `release/`. `npm run dist` builds a platform installer. Signing and notarization credentials are not configured. Native rebuilding is disabled in electron-builder because node-pty ships N-API prebuilds; verify each target OS/architecture before distributing.

## Layout

- `src/main`: cluster access, resource synchronization, validated IPC, logs and terminal helpers.
- `src/preload`: narrow typed context bridge.
- `src/renderer`: dashboard, tables, details, logs and terminals.
- `src/shared`: contracts and pure presentation helpers.
- `tests`: boundary tests and Electron integration smoke test.
- [ARCH_SPEC.md](ARCH_SPEC.md): evidence boundary, architecture, complete application IPC matrix and limitations.

The workspace includes grouped resource navigation, closable tabs, searchable/sortable tables, dynamic custom-resource instances, metrics-server overview, kubeconfig import, validated manifest apply, scaling, rollout restart and node scheduling controls. Terminal/log sessions survive view changes and dock collapse. Prometheus historical dashboards and extension hosting are not implemented. Helm Charts and Releases provide general chart/release management; cluster settings also include a separate monitoring-stack workflow. Cluster credentials remain in main; Kubernetes Secret payloads are hidden in resource and Helm manifest views. Helm values and notes can contain sensitive configuration and remain visible for editing. A trusted kubeconfig may execute its configured authentication plugin, as with kubectl.

MIT licensed. This project contains no proprietary application source or branding.

## Cluster menu and operational controls

Right-click a cluster in the Navigator, or use its three-dot button:

- **Connect / Disconnect** checks API reachability or closes the selected cluster's watches, logs, terminals and forwards.
- **Show Cluster Settings** opens a cluster-scoped workspace tab with General, Proxy, Terminal, Namespaces, Metrics, monitoring components, Cost and Node Shell sections.
- **Add to Hotbar** pins the cluster to the activity rail; use Remove from Hotbar to unpin.
- **Appearance** saves a local display name and icon color.
- **Remove from Kubeconfig** requires confirmation, creates a credential-bearing backup alongside the original, removes only the chosen context, clears current-context if needed, and closes sessions belonging to that context. Shared users and cluster records are preserved.

Pod and Service details expose **Port forward**. The managed kubectl process listens only on 127.0.0.1; use 0 for an automatic local port. Its dock tab shows the assigned address and offers Stop/Restart. Port forwards stop when their tab or application closes. Requires kubectl on PATH; TCP only. Process readiness, missing-command failures, ownership and cleanup are unit-tested with a subprocess double; live-cluster forwarding still requires acceptance testing.

Log tabs expose **Reconnect logs** and **Previous container**. Init and ephemeral containers appear in pod details. Resource groups collapse to keep lower navigation options reachable.

The renderer includes a recovery boundary; manifest inputs are locked during validation/apply to prevent validation races. CI configuration runs Windows unit tests, the isolated Electron smoke suite, and packaging. CI itself must run in the repository host before being treated as verified.

Production rollout still requires live-cluster/RBAC/auth-provider testing, load and long-running recovery testing, and an organization-approved signed build. No real kubeconfig or cluster was modified by automated verification.

## Cluster settings

Settings persist per kubeconfig/context in the application profile. Saving settings closes that cluster's active sessions so new connections use the saved configuration; the original kubeconfig is unchanged. General includes display name/color, connection testing and revealing the kubeconfig file. Proxy accepts an HTTP(S) endpoint without embedded credentials and applies to SDK requests and generated CLI configurations. Cluster terminals use the saved working directory and default namespace. Manual namespace entries avoid requiring namespace-list RBAC.

Metrics supports automatic selection (metrics-server first), explicit metrics-server, Prometheus via the authenticated Kubernetes Service proxy, or disabled. Prometheus supplies current aggregate/node CPU and memory samples, not historical queries or per-workload dashboards. Visibility preferences apply where a corresponding metrics view exists; additional category toggles persist for future views.

Monitoring management requires Helm on PATH. It manages only Optic-owned Prometheus, kube-state-metrics and node-exporter releases in `optic-monitoring`. Selecting Install/upgrade automatically fills the latest stable chart version directly from the public chart repository (no Helm needed for lookup). The version remains editable and is pinned at review/confirmation; lookup failures allow retry or manual entry. Uninstall is also confirmed. It does not adopt existing releases. Sources: [Prometheus community charts](https://github.com/prometheus-community/helm-charts/tree/main/charts).

Cost supports an existing OpenCost/Kubecost Service allocation API, a uniform user-entered USD/node-hour estimate, or disabled. Estimates use the current node count over 24 hours and are not billing data. Provider discovery can be replaced with an explicit Service endpoint. API reference: [OpenCost allocation examples](https://opencost.io/docs/integrations/api-examples/).

Node details offer a confirmed privileged node shell using the saved image and optional pull secret. It creates a temporary pod in `kube-system`, enters the host namespaces with `nsenter`, and deletes the helper with a UID precondition on terminal closure. The image must provide `sleep` and `nsenter`; admission policy and RBAC must permit this operation. A one-hour active deadline bounds helper execution after a crash, but a stopped helper pod may still require removal.

Settings validation/persistence, isolated CLI configuration, provider responses, node-shell lifecycle and Helm argument construction are tested. The Electron smoke test exercises settings navigation/saving, namespace restrictions, disabled metrics, cost estimates and disconnect/reconnect cleanup. Live proxy traversal, Helm reconciliation and privileged node-shell acceptance have not been run against a real cluster. Settings UI screenshot: `artifacts/cluster-settings.png`.

Overview graphs include timestamp and value axes, absolute or percentage units, and 5/15/30/60-minute windows of locally observed samples. Select all nodes, control-plane/master nodes, workers, or a specific node; gauges and resource requests/limits follow the selection. Prometheus node names or instance addresses must match Kubernetes node identities for scoped metrics. Unmatched aggregates are not attributed to individual nodes. These windows do not query historical Prometheus data.

Resource drawers now include conditions, owners, annotations, detailed pod/container health and scheduling, probes, mounts and resource budgets; workload rollout/templates; and node, networking, storage and access-rule properties. Expand sections to inspect structured fields.

Add kubeconfig offers filesystem and clipboard imports from the Navigator + menu, Welcome and Preferences. The clipboard option opens an editor for pasting and reviewing YAML before Add Clusters. Submitted text is validated in main and saved in the application profile kubeconfigs directory. Exact repeat imports reuse the saved file. Use embedded credentials or absolute certificate/key paths; relative paths require filesystem import. Only import trusted kubeconfigs because authentication plugins can execute locally.

## Helm Charts and Releases

Open **Helm > Charts** or **Helm > Releases** under a cluster. Chart catalogs are fetched from public HTTPS indexes without launching Helm. Argo, Bitnami and Prometheus Community are default sources; Manage repositories adds, replaces or removes Optic-local sources. Search, sort, paginate and export the filtered chart catalog as CSV. The supplied Lens CSV was a reference snapshot of 143 Bitnami charts, not a fixed catalog or proof of current package availability.

Select a chart, pin a version, choose release name/namespace and edit YAML values. Load chart defaults and README when needed. **Preview changes** renders the chart with Helm; **Review and apply** shows the selected context and exact operation. Changes to any input invalidate the preview, which also expires after ten minutes. Preview is template rendering, not API-server validation or a guaranteed prediction of hooks/admission behavior. Kubernetes Secret data is hidden in the preview.

Releases lists all namespaces or a specified namespace and includes status, chart/app version, revision and update time. Open a release for user-supplied values, manifests, notes and up to 256 history entries. Upgrade starts with current user overrides; choose the correct repository/chart/version because release metadata does not reliably identify its original source. Rollback targets an explicit revision. Uninstall requires confirmation; retained volumes, CRDs and hooks can remain.

Use an approved Helm 3.14+ or Helm 4 executable on PATH. Public OCI packages referenced by repository indexes are supported through Helm; standalone OCI browsing and private repository login are not implemented. Chart defaults, preview and all release operations require Helm. Windows Application Control can prevent Helm from starting; Optic reports the block and does not bypass it. No live-cluster release was installed, upgraded, rolled back or removed during development verification.

Commands use isolated context-specific kubeconfigs, shell-free arguments, bounded output/timeouts and private temporary values files. Mutations serialize per context, including monitoring-stack operations. Leave Optic open during an operation; closing it terminates child processes and may leave a pending release requiring inspection. Confirmed Helm operations close the dialog and show application-wide running/success/failure notifications. Switching or closing workspace tabs does not cancel the operation; notifications remain until completion and can then be dismissed. Closing or reloading the application is not supported during an operation. Automatic rollback, chart provenance verification, cross-process operation locking and durable operation recovery are not implemented.

Chart commands targeting the same package run sequentially within Optic to prevent concurrent Helm content-cache rename failures on Windows. The October 25 live audit verified chart defaults/README downloads, Argo CD template rendering, deployed-release reads, logs, pod shell execution, port forwarding and all 39 built-in resource lists. Installation, rollback and deletion were exercised with controlled fixtures, not against existing live workloads.

Verified with live public catalog reads, subprocess unit tests and Electron UI tests with mocked Helm IPC. The current test suite includes install/upgrade preview invalidation, explicit confirmations, rollback/uninstall, secret redaction, namespace scoping and private-file cleanup. Official command references: [Helm upgrade](https://helm.sh/docs/helm/helm_upgrade/), [Helm list](https://helm.sh/docs/helm/helm_list/), [Helm rollback](https://helm.sh/docs/helm/helm_rollback/).

Helm 3/4 release discovery uses explicit status filters (Helm 4 removed --all), including failed and pending releases. Errors distinguish timeouts, duplicate release names, access failures and chart rendering failures without exposing raw stderr. A live read-only check confirmed the user's failed Bitnami Argo CD 11.0.0 release: its Redis 8.2.1-debian-12-r0 image returned not found, causing ImagePullBackOff and a Helm wait timeout. A renderable chart does not guarantee available container images. The upstream Argo source is https://argoproj.github.io/argo-helm; it is a different chart and must not be treated as a drop-in upgrade for Bitnami releases. Existing saved repository lists are preserved; add the Argo URL in Manage repositories if absent.

## Related resources
Open a resource's **Related** tab to follow its owner chain, browse live related Pods, or inspect a Deployment's retained ReplicaSet revisions. Links open the target in its own resource tab and namespace. Ownership uses UIDs, not name similarity; deleted/recreated owners and access errors are displayed. Supported owner APIs are the built-in resource catalog; unsupported custom owner APIs are shown without a link. Related Pods cover workloads (including Deployment/ReplicaSet and CronJob/Job chains), Services with selectors, Nodes, and PVC consumers. Revision history includes only ReplicaSets still retained by Kubernetes; selecting one opens its properties and YAML, without performing a rollback.

## Pod, container and workload metrics
Open **Metrics** in a Pod, Deployment, ReplicaSet, StatefulSet, DaemonSet, ReplicationController, Job or CronJob drawer. Select all containers or a named container and a 5/15/30/60-minute window. Charts refresh every 15 seconds and include timestamp/value axes and sample tooltips.

Prometheus uses bounded range queries through the selected cluster's service proxy for CPU cores, memory working set, network receive/transmit bytes per second, and container filesystem bytes used. Workload membership follows current owner UIDs, including Deployment/ReplicaSet and CronJob/Job chains. History is limited to currently owned Pod names, not deleted Pods. Duplicate scrape targets are deduplicated by metric identity.

Automatic source selection tries Prometheus then Metrics Server. Metrics Server provides CPU/memory snapshots, accumulated only while the drawer remains open; network and filesystem explicitly show unavailable. Named-container views omit shared Pod network traffic. Container filesystem usage is not PVC capacity. Missing series are not displayed as zero. Resource metrics honor disabled/hidden metric categories, bound workloads to 200 Pods, and stop refreshing when the tab closes. Upstream permission failures surface in the drawer; stale samples remain labelled after request failures.

References: [Kubernetes resource metrics pipeline](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/) and [Prometheus range-query API](https://prometheus.io/docs/prometheus/latest/querying/api/).

## Application assets
The user-provided transparent logo is in resources/logo.png. resources/icon.ico and resources/icon.icns are its Windows and macOS packaging conversions. All three assets are used by the app or packaging configuration.
