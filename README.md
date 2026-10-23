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

## Validate and package

```sh
npm test
npm run test:smoke
npm run package
```

The smoke test uses a local fake Kubernetes API and an isolated temporary kubeconfig; it never needs or mutates a real cluster. It launches the actual Electron build and native PTY. Screenshot output is written to `artifacts/dashboard.png` and `artifacts/overview.png` (ignored by Git).

Verified on Windows x64: TypeScript/production build, all 34 unit tests, Electron smoke test and unpacked application build. The October 23 rebuilt executable was blocked at launch by this machine's organizational Device Guard policy, so its packaged runtime test could not complete. The source build passes through the development Electron runtime; use `npm run dev` for that workflow. The smoke test includes metrics, tabs, search, scaling, restart, cordon, manifest dry-run/apply and expired-watch recovery and verifies that delete is not sent before confirmation. Live-cluster interoperability and macOS/Linux packages have not been verified.

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

The workspace includes grouped resource navigation, closable tabs, searchable/sortable tables, dynamic custom-resource instances, metrics-server overview, kubeconfig import, validated manifest apply, scaling, rollout restart and node scheduling controls. Terminal/log sessions survive view changes and dock collapse. Prometheus historical dashboards, extension hosting and a general-purpose Helm release manager are not implemented. The cluster settings page supports a limited, explicit monitoring-stack Helm workflow. Cluster credentials remain in main; Secret values are not exposed in the UI. A trusted kubeconfig may execute its configured authentication plugin, as with kubectl.

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

Resource drawers now include conditions, owners, annotations, detailed pod/container health and scheduling, probes, mounts and resource budgets; workload rollout/templates; and node, networking, storage and access-rule properties. Expand sections to inspect structured fields. See RESOURCE_DETAILS_INSPECTION.md for the observed Lens comparison and remaining gaps.

Add kubeconfig offers filesystem and clipboard imports from the Navigator + menu, Welcome and Preferences. The clipboard option opens an editor for pasting and reviewing YAML before Add Clusters. Submitted text is validated in main and saved in the application profile kubeconfigs directory. Exact repeat imports reuse the saved file. Use embedded credentials or absolute certificate/key paths; relative paths require filesystem import. Only import trusted kubeconfigs because authentication plugins can execute locally.
