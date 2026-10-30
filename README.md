# Optic

**Public beta: 0.1.0-beta.1.** A Kubernetes desktop workspace.

See [release notes and installation requirements](RELEASE_NOTES.md), [security policy](SECURITY.md), and [downloads](https://github.com/Karthickcjx/Optic/releases). The initial installer targets Windows x64 and is unsigned. macOS/Linux binaries are not yet supported downloads.

## Detailed cost accounting

In **Cluster Settings → Cost**, select **OpenCost** or **Kubecost** and configure its Kubernetes Service endpoint. The cost dashboard shows CPU, memory, GPU, persistent storage and network charges when those fields are returned by the provider. Components include returned cost adjustments; network zone/region/internet amounts are informational subdivisions, never added twice. Allocation details include core-hours, GPU-hours, memory/storage GiB-hours and transferred GiB. CSV and JSON exports retain these quantities.

The component chart and summary identify partial or unavailable fields. Historical effective rates use each interval's cost divided by its own allocation units, excluding idle allocations. These blended rates can change with workload mix or discounts; they are not presented as cloud catalog changes.

Enable **Read retained provider price history from Prometheus** and set an explicit cluster-scoped Prometheus service under Metrics to inspect sampled CPU, memory, GPU and persistent-volume prices. Prometheus must scrape the OpenCost exporter. The price table preserves changes over the requested range, with resource/provider identity and timestamps. It does not overwrite allocation costs, fill missing historical prices, or infer changes between samples. Price metrics follow the exporter's USD convention; configure the exporter accordingly. JSON exports contain the sampled price history.

**GCP:** configure the cost provider's GCP integration and permissions in your cluster, then select its service in Optic. Provider-priced allocations and `gce://` node-price samples are supported. Optic does not collect Google service-account keys or call the Google Cloud Billing catalog directly. GCP custom/fallback rates may still be emitted by the provider; verify its pricing configuration. See the [OpenCost GCP configuration](https://opencost.io/docs/configuration/gcp/) and [exported price metrics](https://opencost.io/docs/integrations/metrics/).

The standalone **Estimate** mode remains a CPU/RAM estimate at current configured/public prices. Rich accounting requires the cost provider: PV pricing for storage, GPU allocation/prices, and classified egress for network. A returned zero is a provider value, not proof that collection is complete. Historical pricing does not recreate data from before retention or reconcile cloud invoices.

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

Select a resource to open its details. Pod container cards open logs or a shell. Workload details offer rollout restart and scaling where supported; Node details offer cordon/uncordon. Delete, YAML save and restart show confirmation before changing the cluster. Local terminals are available even without a kubeconfig. Container shells are configurable; the selected executable must exist in the container.

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

Windows validation covers unit tests, fixture-backed Electron workflows and packaging. Release publication is gated on the packaged runtime smoke test. Tests do not certify every Kubernetes distribution or provider. See GitHub Actions for the exact commit and platform results.

To test an unpacked Windows build in PowerShell:

```powershell
$env:WORKBENCH_TEST_EXECUTABLE = "$PWD/release/win-unpacked/Optic.exe"
node tests/smoke.mjs
Remove-Item Env:WORKBENCH_TEST_EXECUTABLE
```

Dependency versions are pinned in package.json and package-lock.json. Release builds run a production dependency audit; third-party notices are generated from installed production packages and included in the distribution.

`npm run package` produces an unpacked application in `release/`. `npm run dist` builds a platform installer. Signing and notarization credentials are not configured. Native rebuilding is disabled in electron-builder because node-pty ships N-API prebuilds; verify each target OS/architecture before distributing.

## Layout

- `src/main`: cluster access, resource synchronization, validated IPC, logs and terminal helpers.
- `src/preload`: narrow typed context bridge.
- `src/renderer`: dashboard, tables, details, logs and terminals.
- `src/shared`: contracts and pure presentation helpers.
- `tests`: boundary tests and Electron integration smoke test.
- [ARCH_SPEC.md](ARCH_SPEC.md): architecture, application IPC matrix and limitations.

The workspace includes grouped resource navigation, closable tabs, searchable/sortable tables, dynamic custom-resource instances, metrics-server overview, kubeconfig import, validated manifest apply, scaling, rollout restart and node scheduling controls. Terminal/log sessions survive view changes and dock collapse. Prometheus historical dashboards are supported; local extensions support sandboxed hosting, commands, text/table panels, folder installation and Safe Mode. See [Extension API](EXTENSIONS.md). Helm Charts and Releases provide general chart/release management; cluster settings also include a separate monitoring-stack workflow. Cluster credentials remain in main; Kubernetes Secret payloads are hidden in resource and Helm manifest views. Helm values and notes can contain sensitive configuration and remain visible for editing. A trusted kubeconfig may execute its configured authentication plugin, as with kubectl.

MIT licensed.

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

Metrics supports automatic selection (metrics-server first), explicit metrics-server, Prometheus via the authenticated Kubernetes Service proxy, or disabled. Prometheus supplies current aggregate/node CPU and memory samples and historical overview queries. Resource drawers also provide workload metrics. Visibility preferences apply where a corresponding metrics view exists; additional category toggles persist for future views.

Monitoring management requires Helm on PATH. It manages only Optic-owned Prometheus, kube-state-metrics and node-exporter releases in `optic-monitoring`. Selecting Install/upgrade automatically fills the latest stable chart version directly from the public chart repository (no Helm needed for lookup). The version remains editable and is pinned at review/confirmation; lookup failures allow retry or manual entry. Uninstall is also confirmed. It does not adopt existing releases. Sources: [Prometheus community charts](https://github.com/prometheus-community/helm-charts/tree/main/charts).

Cost supports an existing OpenCost/Kubecost Service allocation API, Prometheus-based historical estimates, or disabled. Estimates automatically discover node metadata and combine observed CPU/memory usage, requests and capacity with public prices or configurable rates. Provider discovery can be replaced with an explicit Service endpoint. API reference: [OpenCost allocation examples](https://opencost.io/docs/integrations/api-examples/).

Node details offer a confirmed privileged node shell using the saved image and optional pull secret. It creates a temporary pod in `kube-system`, enters the host namespaces with `nsenter`, and deletes the helper with a UID precondition on terminal closure. The image must provide `sleep` and `nsenter`; admission policy and RBAC must permit this operation. A one-hour active deadline bounds helper execution after a crash, but a stopped helper pod may still require removal.

Settings validation/persistence, isolated CLI configuration, provider responses, node-shell lifecycle and Helm argument construction are tested. The Electron smoke test exercises settings navigation/saving, namespace restrictions, disabled metrics, cost estimates and disconnect/reconnect cleanup. Live proxy traversal, Helm reconciliation and privileged node-shell acceptance have not been run against a real cluster. Settings UI screenshot: `artifacts/cluster-settings.png`.

Overview graphs include timestamp and value axes, absolute or percentage units, and 5/15/30/60-minute, 6-hour and 24-hour windows. Prometheus history loads immediately through authenticated range queries, including samples from before Optic was opened, and refreshes every 30 seconds. Automatic mode looks for Prometheus history even when current gauges use Metrics Server. Select all nodes, control-plane/master nodes, workers, or a specific node; gauges and resource requests/limits follow the selection. Prometheus node names or instance addresses must match Kubernetes node identities for scoped metrics. Unmatched aggregates are not attributed to individual nodes. Queries return at most 241 time points per node/metric with a minimum 15-second step and support up to 500 node series. Empty intervals remain gaps; missing CPU or memory is not plotted as zero. Failed refreshes retain history with a stale label. Node groups use current membership, and percentage charts use current allocatable capacity. History depends on Prometheus retention and cAdvisor scraping. Metrics Server provides only locally collected samples (up to one hour), with no backfill. See the [Prometheus range query API](https://prometheus.io/docs/prometheus/latest/querying/api/#range-queries).

Resource drawers now include conditions, owners, annotations, detailed pod/container health and scheduling, probes, mounts and resource budgets; workload rollout/templates; and node, networking, storage and access-rule properties. Expand sections to inspect structured fields.

Add kubeconfig offers filesystem and clipboard imports from the Navigator + menu, Welcome and Preferences. The clipboard option opens an editor for pasting and reviewing YAML before Add Clusters. Submitted text is validated in main and saved in the application profile kubeconfigs directory. Exact repeat imports reuse the saved file. Use embedded credentials or absolute certificate/key paths; relative paths require filesystem import. Only import trusted kubeconfigs because authentication plugins can execute locally.

## Helm Charts and Releases

Open **Helm > Charts** or **Helm > Releases** under a cluster. Chart catalogs are fetched from public HTTPS indexes without launching Helm. Argo, Bitnami and Prometheus Community are default sources; Manage repositories adds, replaces or removes Optic-local sources. Search, sort, paginate and export the filtered chart catalog as CSV. Chart availability is determined by the configured repositories.

Select a chart, pin a version, choose release name/namespace and edit YAML values. Load chart defaults and README when needed. **Preview changes** renders the chart with Helm; **Review and apply** shows the selected context and exact operation. Changes to any input invalidate the preview, which also expires after ten minutes. Preview is template rendering, not API-server validation or a guaranteed prediction of hooks/admission behavior. Kubernetes Secret data is hidden in the preview.

Releases lists all namespaces or a specified namespace and includes status, chart/app version, revision and update time. Open a release for user-supplied values, manifests, notes and up to 256 history entries. Upgrade starts with current user overrides; choose the correct repository/chart/version because release metadata does not reliably identify its original source. Rollback targets an explicit revision. Uninstall requires confirmation; retained volumes, CRDs and hooks can remain.

Use an approved Helm 3.14+ or Helm 4 executable on PATH. Public OCI packages referenced by repository indexes are supported through Helm; standalone OCI browsing and private repository login are not implemented. Chart defaults, preview and all release operations require Helm. Windows Application Control can prevent Helm from starting; Optic reports the block and does not bypass it. No live-cluster release was installed, upgraded, rolled back or removed during development verification.

Commands use isolated context-specific kubeconfigs, shell-free arguments, bounded output/timeouts and private temporary values files. Mutations serialize per context, including monitoring-stack operations. Leave Optic open during an operation; closing it terminates child processes and may leave a pending release requiring inspection. Confirmed Helm operations close the dialog and show application-wide running/success/failure notifications. Switching or closing workspace tabs does not cancel the operation; notifications remain until completion and can then be dismissed. Closing or reloading the application is not supported during an operation. Automatic rollback, chart provenance verification, cross-process operation locking and durable operation recovery are not implemented.

Chart commands targeting the same package run sequentially within Optic to prevent concurrent Helm content-cache rename failures on Windows. The October 25 live audit verified chart defaults/README downloads, Argo CD template rendering, deployed-release reads, logs, pod shell execution, port forwarding and all 39 built-in resource lists. Installation, rollback and deletion were exercised with controlled fixtures, not against existing live workloads.

Verified with live public catalog reads, subprocess unit tests and Electron UI tests with mocked Helm IPC. The current test suite includes install/upgrade preview invalidation, explicit confirmations, rollback/uninstall, secret redaction, namespace scoping and private-file cleanup. Official command references: [Helm upgrade](https://helm.sh/docs/helm/helm_upgrade/), [Helm list](https://helm.sh/docs/helm/helm_list/), [Helm rollback](https://helm.sh/docs/helm/helm_rollback/).

Helm 3/4 release discovery uses explicit status filters (Helm 4 removed --all), including failed and pending releases. Errors distinguish timeouts, duplicate release names, access failures and chart rendering failures without exposing raw stderr. A live read-only check confirmed the user's failed Bitnami Argo CD 11.0.0 release: its Redis 8.2.1-debian-12-r0 image returned not found, causing ImagePullBackOff and a Helm wait timeout. A renderable chart does not guarantee available container images. The upstream Argo source is https://argoproj.github.io/argo-helm; it is a different chart and must not be treated as a drop-in upgrade for Bitnami releases. Existing saved repository lists are preserved; add the Argo URL in Manage repositories if absent.

## Related resources
Open a resource's **Related** tab to follow its owner chain, browse live related Pods, or inspect a Deployment's retained ReplicaSet revisions. Links open the target in its own resource tab and namespace. Ownership uses UIDs, not name similarity; deleted/recreated owners and access errors are displayed. Supported owner APIs are the built-in resource catalog; unsupported custom owner APIs are shown without a link. Related Pods cover workloads (including Deployment/ReplicaSet and CronJob/Job chains), Services with selectors, Nodes, and PVC consumers. Revision history includes only ReplicaSets still retained by Kubernetes; selecting one opens its properties and YAML, without performing a rollback.

## Resource actions and form editors

Open a resource drawer to use these actions. Each confirmation shows the selected context and resource. Applying closes the dialog and reports running/success/failure through background notifications; switching tabs does not cancel an action. Keep Optic open until completion. Lists refresh after an action finishes.

- **Nodes → Drain:** review scheduled Pods, leave DaemonSet/mirror Pods running, and explicitly opt into deleting emptyDir data or evicting unmanaged Pods. Uses the selected context's kubectl with a bounded timeout and requires the eviction API; it does not disable eviction or bypass PodDisruptionBudgets. A completed or failed drain can leave the node cordoned. Uncordon after maintenance. Closing Optic stops the command and can leave a partial drain.
- **Deployments → Rollback:** choose an earlier retained ReplicaSet revision and review its images. Only the Pod template is restored, without its generated pod-template-hash label; replicas and other Deployment fields are preserved. Ownership and resource-version checks reject replaced or concurrently changed resources. Paused Deployments must be resumed first. Success means the rollback was submitted, not that new Pods are already healthy.
- **Cron Jobs → Run now / Suspend / Resume:** create a named Job from the current Job template, or pause/resume future scheduled runs. Manual execution can overlap existing Jobs and is allowed while scheduling is suspended. Suspension does not stop existing Jobs; resuming may run missed schedules.
- **Edit resource:** ConfigMap text entries; Deployment, StatefulSet, DaemonSet, ReplicaSet and ReplicationController container images/requests/limits and applicable replica counts; Service selectors/type/ports; and CronJob schedule/time zone/concurrency/history limits. Unedited settings and ConfigMap binaryData are preserved. ExternalName Services and Secret values do not have form editors; other resource fields remain in the existing YAML workflow.

Form changes require API-server dry-run validation before confirmation. Editing after validation invalidates the result. Saving uses UID/resourceVersion preconditions and rejects concurrent edits. Kubernetes still enforces field immutability, RBAC and admission policies. Drain/rollback/trigger mutation tests use isolated fixtures, not existing live workloads.

Behavior follows the Kubernetes documentation for [drain](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_drain/), [Deployment rollback](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#rolling-back-a-deployment), and [CronJob scheduling](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/).

Optic's node-exporter monitoring install uses a 5-second readiness initial delay, a 10-second liveness initial delay, and 3-second probe timeouts. These avoid probing immediately before the exporter binds port 9100. Probe checks remain enabled; historical startup-warning Events remain until Kubernetes expires them.

## Pod, container and workload metrics
Open **Metrics** in a Pod, Deployment, ReplicaSet, StatefulSet, DaemonSet, ReplicationController, Job or CronJob drawer. Select all containers or a named container and a 5/15/30/60-minute window. Charts refresh every 15 seconds and include timestamp/value axes and sample tooltips.

Prometheus uses bounded range queries through the selected cluster's service proxy for CPU cores, memory working set, network receive/transmit bytes per second, and container filesystem bytes used. Workload membership follows current owner UIDs, including Deployment/ReplicaSet and CronJob/Job chains. History is limited to currently owned Pod names, not deleted Pods. Duplicate scrape targets are deduplicated by metric identity.

Automatic source selection tries Prometheus then Metrics Server. Metrics Server provides CPU/memory snapshots, accumulated only while the drawer remains open; network and filesystem explicitly show unavailable. Named-container views omit shared Pod network traffic. Container filesystem usage is not PVC capacity. Missing series are not displayed as zero. Resource metrics honor disabled/hidden metric categories, bound workloads to 200 Pods, and stop refreshing when the tab closes. Upstream permission failures surface in the drawer; stale samples remain labelled after request failures.

References: [Kubernetes resource metrics pipeline](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/) and [Prometheus range-query API](https://prometheus.io/docs/prometheus/latest/querying/api/).

## Advanced logs and terminals

Select Pods in a resource table and choose **Logs for selected Pods**, or open a workload's **Related** tab and choose **Logs for related Pods**. Select up to eight Pod/container sources, including init and ephemeral containers. Each source streams independently with namespace/Pod/container labels, status, stop and reconnect controls. Source selection is a snapshot; replacement Pods must be selected again.

Filter by source or text, follow incoming lines, or read previous-container logs. **Export retained** and **Export filtered** open a native Save As dialog and write the currently retained lines with source labels. The viewer retains at most 5,000 lines / one million text characters, truncates individual lines at 16,384 characters, and reports discarded lines. Export is not a complete cluster log archive. Lines appear in arrival order.

Current-container logs automatically retry eligible failures up to five times with exponential delays. Reconnect resumes from the last observed timestamp and suppresses repeated boundary lines when timestamps are available. Log rotation, Pod replacement and unavailable history can leave gaps; delivery is best effort. Permission failures and cluster disconnects stop retries. Previous-container snapshots do not automatically reconnect. Closing the log tab closes its streams and cancels retries.

Set **Cluster settings > Terminal > Default container shell**, or change **Container shell** in an individual Pod terminal before reconnecting. Specify one executable path/name, such as `/bin/sh` or `/bin/bash`; it must exist in that container. Local terminals retain the operating-system shell. **Disconnect terminal** closes the session; **Reconnect terminal** starts a fresh process while retaining displayed terminal history. Commands are never replayed automatically. Reconnecting a node shell requires confirmation for a new privileged helper.

Automated checks cover stream isolation, UTF-8 chunks, timestamp resume/deduplication, retry limits, cleanup races, native export and terminal reconnection. `npm run test:smoke` includes the multi-source Electron UI workflow. Kubernetes log API behavior: [Pod logs reference](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_logs/).

## Application assets
The user-provided transparent logo is in resources/logo.png. resources/icon.ico and resources/icon.icns are its Windows and macOS packaging conversions. All three assets are used by the app or packaging configuration.

## Historical cost dashboard

Open **Cost** under a cluster in the Navigator. Configure the allocation provider under **Cluster Settings > Cost**. The dashboard reads OpenCost or Kubecost allocation history through the authenticated Kubernetes service proxy; it does not install a cost stack.

Choose 24 hours, 7 days, 30 days, or a custom past range up to 31 days, then **Apply range**. Group by namespace, node, or workload (namespace/controller kind/controller), and include or exclude idle costs. Allocation-service timelines use hourly buckets for ranges up to two days and daily buckets for longer ranges. Prometheus estimates use adaptive intervals capped at 288 points. Click an allocation to inspect its interval breakdown. Search, sort, and paginate allocations; CPU, memory, GPU, storage, network, load balancer, shared and external cost columns show provider-reported values.

**Export CSV** and **Export JSON** use a native Save As dialog. Both include source, dates, grouping and warnings. Search filters exported allocations; JSON additionally includes the complete report timeline. Totals may contain provider adjustments that are not represented in the unadjusted component columns. Missing components remain unavailable, missing periods are not zero-filled, and failed refreshes mark the prior report stale and disable export.

History depends on the provider's retained data, pricing and permissions. Currency is shown only if returned by the provider; otherwise the unit is labelled `provider units`. The Estimate source computes approximate historical CPU/memory costs from retained Prometheus telemetry; it does not require OpenCost/Kubecost and is not a verified cloud invoice. Reports are bounded to 744 intervals and 20,000 allocation rows. Reduce the range or use a broader grouping if these limits are exceeded.

API references: [OpenCost allocation API](https://opencost.io/docs/integrations/api/) and [query examples](https://opencost.io/docs/integrations/api-examples/). Unit tests and the Electron cost dashboard smoke test cover aggregation, grouping, dates, missing data, stale reports and native exports.


### Prometheus Estimate mode

Select **Cluster Settings > Cost > Estimate**, leave **Uniform hourly node override** at **0** for automatic pricing, and save. Configure Prometheus under **Metrics** or allow service discovery. Automatic cost-source selection also tries this estimator when no allocation service is detected and no explicit cost endpoint is configured.

The estimator queries cAdvisor CPU/memory usage, kube-state-metrics requests/running-container state, node capacity and Pod-to-node identities. It evaluates up to 288 intervals using minute-resolution observations and up to 1,000 series per query. Short-lived resources are weighted by observed presence. Unset requests are treated as zero only for known containers when the corresponding request metric family exists. Missing telemetry, incomplete edge intervals and nodes without attributable Pod observations are omitted with coverage warnings. This is approximate integration, not a billing meter. It does not backfill costs from today's node count.

Namespace and node grouping, historical workload owners (including ReplicaSet to Deployment), idle CPU/memory cost, usage/request efficiency and per-interval details are available. Unknown owners fall back to Pod names. Node metadata shows cloud, region, instance type, spot status, capacity, hourly rate and price source. Metadata for removed nodes falls back to observed capacity and configurable rates. Current prices and node types are applied to historical usage; historical machine/pricing changes are not reconstructed.

AWS Linux on-demand prices are fetched from AWS's public pricing-site feed using region and instance type. Azure Linux retail prices use the [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices). AWS spot nodes use the on-demand reference, labelled explicitly; Azure spot prices are used when available. GCP, Windows and unavailable or unsupported prices use configurable CPU-core-hour and GiB-hour fallback rates. Optic's default fallback values (USD 0.03/core-hour and 0.004/GiB-hour) are modelling assumptions, not a cloud-price catalogue. A nonzero node override takes precedence. CPU/RAM proportions of whole-VM prices use those resource-rate weights. GPU machine prices may be included in VM rates, but dedicated GPU allocations, storage, network and negotiated discounts are not modelled.

Public-price requests send only the public region/instance type, never kubeconfig credentials or node names. Disable public-price fetching to use local rates only. Requests are bounded and cached for one day in memory; failures fall back visibly. Estimate reports are cached for 30 seconds per cluster/settings/range; explicit Refresh bypasses this cache. Exports include efficiency, coverage, price-source provenance and methodology; JSON additionally includes full node pricing.

References: [Prometheus range queries](https://prometheus.io/docs/prometheus/latest/querying/api/), [AWS EC2 on-demand pricing](https://aws.amazon.com/ec2/pricing/on-demand/), [AWS region metadata](https://b0.p.awsstatic.com/locations/1.0/aws/current/locations.json).


Cost history coverage distinguishes absent observation intervals from small time-range rounding differences. The dashboard shows the first/last available estimate interval and interval counts. **Last 1 hour**, **Last 6 hours** and **Use available history** help focus on recently collected telemetry. The latter narrows to the observed span; it does not fill interior gaps. Rounding-only exclusions appear in methodology notes, while genuinely missing intervals retain a warning and are excluded from totals.


Range queries are anchored to the newest complete minute so 7-day and 30-day views include recent telemetry even when retention is short. Coverage accounts for observed minutes inside partly populated buckets; a 2.5-hour bucket with one hour of telemetry does not claim 2.5 hours of coverage. Totals remain approximate and may differ slightly across resolutions or incomplete Pod telemetry. Empty historical ranges show unavailable data rather than a provider-connection error. Refresh advances a preset's rolling window; custom-date refresh preserves the exact dates. Date validation errors leave the last valid report available, and late responses from earlier ranges cannot replace the current report.

## Security Center

Open **Security Center** in cluster navigation, with separate **Overview**, **Images**, **Resources** and **Roles** tabs.

- **Overview:** scan-status, result and severity charts with hover values, followed by the latest critical findings.
- **Images:** groups reports by image reference and uses the latest vulnerability scan per image for summaries. Includes Pod/init/ephemeral-container images without usable reports. Digest mismatches remain unscanned even when tags match. Open an image and select individual reports to inspect their workload owners, CVEs, package versions, fixes, scores and descriptions. Exposed-secret findings have their own chart and column; secret matches, paths and descriptions are hidden.
- **Resources:** configuration audits with failed checks, passed-check counts, scan dates and owner links.
- **Roles:** combines namespaced Role and cluster-wide ClusterRole assessments. Role inventory without reports remains unknown. Owner navigation verifies UID, including system roles whose names contain colons.

Namespace, severity and search filters apply to the current page. ClusterRole reports remain cluster-wide when a namespace is selected. Resources coverage is limited to operator reports; an absent report is not proof of a clean resource. Image counts are per image reference, not a unique-CVE total. Status charts count the displayed inventory/report objects, not all resources in the cluster.

Reports refresh every minute while the page is visible, with manual refresh. Refresh reads reports; it does not start a scan. Scan times and scanner versions come from the reports. Permission failures, unavailable report types and incomplete results are visible. When all report APIs are missing, an installation banner opens instructions with copy/close actions and access to Helm Charts. The Copy action uses a narrow authenticated IPC handler that writes only the fixed public installation commands.

Install/configure **trivy-operator** through **Helm Charts**, using Aqua's repository `https://aquasecurity.github.io/helm-charts/`. Select a chart version, review values and apply explicitly. Opening Security Center does not install anything. The active kubeconfig needs list/get access to `vulnerabilityreports`, `configauditreports`, `rbacassessmentreports`, `clusterrbacassessmentreports` and `exposedsecretreports` in `aquasecurity.github.io/v1alpha1`. Pod and Role/ClusterRole listing supplies unscanned inventory. If namespace discovery is denied, enter a permitted namespace directly.

Reads are limited to 1,000 reports per type and 5,000 findings per detail view, with incomplete-result notices and paginated tables. Only normalized report fields cross IPC. Optic does not bundle a scanner or registry scanning service, reconstruct scan history, or support SBOM/compliance/node vulnerability report types yet.

References: [Trivy vulnerability reports](https://aquasecurity.github.io/trivy-operator/latest/docs/crds/vulnerability-report/), [configuration audits](https://aquasecurity.github.io/trivy-operator/latest/docs/crds/configaudit-report/), and [RBAC assessments](https://aquasecurity.github.io/trivy-operator/latest/docs/crds/rbacassessment-report/). Unit and Electron smoke tests cover normalization, image grouping, secret redaction, RBAC scopes, navigation, charts, installation instructions, permission failures and missing-operator states using controlled Kubernetes API fixtures.
## Terminal profiles, splits and clipboard

The bottom terminal bar lets you choose Command Prompt, Windows PowerShell, PowerShell 7 or Git Bash when installed. Refresh profiles after installing a shell. The selected profile applies to newly opened local terminals; existing sessions keep their shell. Pod/container shell selection remains separate.

Use the dock's split buttons for side-by-side or stacked sessions. Drag the divider (or focus it and use arrow keys) to resize. **Unsplit** keeps both sessions as tabs; closing a pane ends only that session.

Select terminal output and use **Copy**, **Ctrl+Shift+C**, or **Ctrl+C**. With no selection, Ctrl+C still interrupts the process. Paste with **Paste**, **Ctrl+V**, **Ctrl+Shift+V**, or **Shift+Insert**. Right-click offers Copy, Paste and Select all. macOS Command+C/V is supported. Paste goes through xterm's paste handling and targets only the active session; a reconnect discards an outstanding clipboard read. Text pastes are limited to 60,000 characters.

## Import and deploy your own resources

Open **Applications → Import and deploy**, use **Import files / chart** in the resource-create dialog, or choose **Install local chart** under Helm Charts. Command search also includes **Import and deploy**.

- Import YAML/JSON files, select files from a folder, or paste multi-document manifests and Kubernetes Lists. Review the captured context, namespace, create/update intent and validation results before applying.
- Import a Helm chart directory or `.tgz`; add values files in order and final YAML overrides. Later values win. Public HTTPS dependencies can be built in staging without modifying the original chart.
- Use a local Kustomize directory with all bases inside the selected tree. `kubectl` must be installed. External generators, plugins, Helm inflation and remote bases are disabled.
- Download a chart from an HTTPS archive URL, an HTTPS repository with chart name and pinned version, or an explicit OCI reference. Optional credentials are session-only; custom CA certificates are supported. Downloads do not follow HTTPS redirects or forward credentials to a different origin.

Apply closes the dialog and reports background progress and per-resource results. Manifest batches stop on the first error and retain successful changes. They can also be stopped between resources. Helm waits up to five minutes for readiness; keep Optic open. After an interrupted process, inspect actual cluster/release state before retrying.

Reviews expire after ten minutes. Changes to inputs or kubeconfig require another review. Manifests are limited to 200 input files, 500 resources and 20 MiB total. Charts are limited to 2,000 files / 100 MiB expanded and 20 MiB compressed. Secret payloads are redacted in previews, but arbitrary ConfigMaps and values can still contain sensitive configuration.
