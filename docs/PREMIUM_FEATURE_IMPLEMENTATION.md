# Premium feature implementation

This file tracks premium-style capabilities that are implemented independently in Optic. The full comparison with Lens and the prioritization are in the gap analysis prepared on 2026-11-02, summarized below. No Lens source code, assets or designs are used.

## Status

| Priority | Feature | Status |
|---|---|---|
| P1 | Resource editor: diff, revert, server-side validation | Done (uncommitted) |
| P1 | Standalone read-only MCP server | Done (uncommitted). See [MCP_SERVER.md](MCP_SERVER.md) |
| P1 | GitOps status: Argo CD and Flux (read-only) | Done (uncommitted) |
| P1 | AI tool hand-off with cluster and resource context | Not started |
| P2 | AKS and GKE discovery, split workspace, hotbar favorites, cost recommendations, Security CSV export, local audit log, GitOps sync, syntax highlighting | Not started |
| P3 | Credential-free cluster catalogs, air-gapped documentation, extension capabilities | Not started |
| N/A | Teamwork, SSO, SCIM | Need a backend service. Not implemented. |

## 1. Resource editor: diff, revert and validation

- **Architecture:**
  - A pure line-diff module (`src/shared/yaml-diff.ts`, Myers algorithm with common prefix and suffix trimmed first, bounded at 1,000 edits).
  - A diff view (`src/renderer/src/YamlDiff.tsx`).
  - A toolbar in the Details YAML tab.
  - `resources:replace` accepts `dryRun` and sends `PUT ?dryRun=All`.
- **Files:** `src/shared/yaml-diff.ts`, `src/renderer/src/YamlDiff.tsx`, `src/renderer/src/Details.tsx`, `src/renderer/src/styles.css`, `src/main/resources.ts`, `src/main/validation.ts`, `src/shared/protocol.ts`, `src/main/ipc/index.ts`, `tests/yaml-diff.test.ts`, `tests/smoke.mjs`.
- **Security:** Validate is a non-mutating dry run. Save still needs confirmation and keeps its UID and resourceVersion preconditions.
- **Tests:**
  - 7 unit tests, including a check over 300 random edits that the diff is minimal.
  - Smoke steps: Show changes → Validate (dry-run requests only) → Revert.
  - Live dry-run checks on Kubernetes v1.36.6: the stored value is unchanged, a stale version returns a conflict, and an invalid key returns the server's message.
- **Limitations:**
  - Unified diff only, because the Details drawer is narrow.
  - No syntax highlighting or schema awareness yet. Both need an editor dependency.

## 2. Standalone read-only MCP server

- **Architecture:**
  - `optic --mcp` serves over stdio. The Electron process re-runs itself in Node mode with the original stdio handles.
  - The server reuses the app's `ClusterManager` discovery, `resourcePath`, `kubeJson` and `fault`. It adds `kubeText` for bounded logs.
  - Approvals live in `mcp-access.json`, bound to a fingerprint of each context.
  - The UI is Cluster settings › AI access.
- **Files:**
  - New: `src/mcp/access.ts`, `src/mcp/tools.ts`, `src/mcp/server.ts`, `src/mcp/node.ts`, `src/shared/redaction.ts`, `src/shared/mcp.ts`, `src/renderer/src/McpAccessSection.tsx`, `docs/MCP_SERVER.md`.
  - Changed: `src/main/index.ts` (the `--mcp` branch), `src/main/kube-http.ts` (`kubeText`), `src/main/ipc/index.ts` and `src/main/validation.ts` (`mcp:access`, `mcp:access-set`), `src/shared/protocol.ts`, `src/renderer/src/ClusterSettingsPage.tsx`, `src/renderer/src/styles.css`, `electron.vite.config.ts` (`mcp` entry), `package.json`.
- **Dependencies:**
  - `@modelcontextprotocol/server` 2.3.1. Its only dependencies are `zod` and `@modelcontextprotocol/core`.
  - `@modelcontextprotocol/client` 2.3.1, for tests only.
  - Both are pinned exactly, and version 2.3.1 was released more than two weeks ago.
- **Tools (17):**
  - `list_clusters`, `get_cluster_info`
  - `list_namespaces`, `get_namespace_details`
  - `list_pods`, `get_pod_details`, `get_pod_logs`
  - `list_deployments`, `get_deployment_details`
  - `list_services`, `get_service_details`
  - `list_events`, `get_resource_events`
  - `list_nodes`, `get_node_details`
  - `discover_api_resources`, `get_resource_yaml`
- **Security:**
  - The server is read-only and sends `GET` requests only.
  - Access requires a per-context opt-in. An approval cannot be granted by an agent's shell, and approvals are bound to the context's server, CA and credential command.
  - Secrets are stripped and credential-looking values redacted.
  - Transport is stdio only.
  - See [MCP_SERVER.md](MCP_SERVER.md#security-decisions).
- **Tests:**
  - Unit tests: 19 tool tests and 9 access and redaction tests.
  - Smoke: real stdio processes (Node and Electron `--mcp`), plus the AI access UI flow.
  - Live run: all 17 tools on Kubernetes v1.36.6 with real RBAC denials.
  - Claude Code: `claude mcp get` reports Connected.
- **Compatibility:** tested with the official SDK client and Claude Code; other clients not yet tested.
- **Limitations and remaining work:** see [MCP_SERVER.md](MCP_SERVER.md#known-limitations).

## 3. GitOps: Argo CD and Flux (read-only)

### Reference study and gap analysis
- **What was studied:**
  - The Lens Argo CD dashboard screenshot. Its layout: a status counter bar, Applications and Projects cards, Needs Attention and Recent Activity tables, Sync and Refresh buttons, "Open Argo UI", and a Navigator tree (Argo CD → Dashboard, Applications, Application Sets, Projects; plus Flux).
  - Optic's first GitOps view: one page with lists and a detail drawer.
  - Real objects and events captured from Argo CD v3.5.6 and Flux v2.10.0.
- **Not used:** the REA reverse-engineering MCP tools were not loaded in this session, and Lens's code was deliberately not inspected. Everything is implemented independently.
- **Gaps closed:**
  - Status counters.
  - Dashboard cards.
  - Needs Attention and Recent Activity.
  - Projects and ApplicationSets.
  - Application filtering, sorting and context menu.
  - A tabbed detail view (Overview, Resources, Events, History, YAML, Conditions).
  - The Flux overview and Needs Attention.
  - OCIRepositories and Buckets.
  - Per-object events.
  - "Open Argo CD UI".
- **Deliberately not copied:** Lens's **Sync** and **Refresh (Argo hard refresh)** buttons trigger Argo CD operations. Optic stays read-only; its Refresh only reloads data.

### Architecture
- **Watches:** every list reuses Optic's shared watch (`ResourceService.watch` and `useResources`), so reconnects, recovery when the watch version expires, and cleanup are shared with the rest of the app. Only detected types open a watch, and only on the page that shows them.
- **Field selectors:** the shared watch gained an optional, validated `fieldSelector` (plain `key=value` terms only), used to narrow event watches server-side:
  - Recent Activity: `involvedObject.apiVersion=argoproj.io/v1alpha1`.
  - Per-object Events tabs: `involvedObject.kind=…,involvedObject.name=…`.
  - This avoids watching every event in the cluster.
- **Detection** uses API discovery (`/apis`) and covers Applications, ApplicationSets, AppProjects, Kustomizations, HelmReleases, GitRepositories, HelmRepositories, OCIRepositories and Buckets. A type appears only if it can be listed and watched.
- **Pure logic** in `src/shared/gitops.ts`:
  - Counters (`argoSummary`, `fluxSummary`).
  - Filtering and sorting (`filterApplications`, `sortApplications`).
  - Needs Attention (`argoAttention`, `fluxAttention`).
  - Projects and ApplicationSets (`appProject`, `applicationSet`).
  - Activity (`argoActivity`, `filterActivity`).
  - Source consumers (`consumersOf`).
- **Argo CD UI link:**
  - The address is read in the main process from `argocd-cm` `data.url` in the controller's namespace. Only `http(s)` URLs without credentials, query or fragment are accepted.
  - The renderer only names the Application to open, and the main process rebuilds the URL. Without a published address, or without permission to read the ConfigMap, there is no button.
- **UI:**
  - The Navigator has a **GitOps** group per cluster, with **Argo CD** and **Flux**.
  - Shared parts (`gitops-ui.tsx`): status badges (green, amber, red, grey), clickable counters, cards, skeleton loading, permission-denied, error and empty states, sortable headers, a tabbed drawer, a context menu, an Events tab, and a redacted read-only YAML tab.

### Argo CD
| Area | Implementation (all from live API data) |
|---|---|
| Summary bar | Applications, Synced, Out of sync, Healthy, Degraded, Missing, Progressing and Unknown, counted from `status.sync`/`status.health`. Clicking a counter filters the Applications list. |
| Overview cards | <ul><li>**Applications:** healthy/total; links for out of sync, missing and degraded; failed syncs; automated-sync count; last reconcile time.</li><li>**Projects:** total, names, app count per project.</li><li>**Application sets:** total, number of generated apps, errors.</li></ul> |
| Needs attention | Out of sync (with the differing resources), Degraded, Missing, failed or errored sync operation, `*Error` conditions, Unknown status, and managed resources reporting unhealthy health. Each row shows kind, name, application, namespace, problem, the controller's message and age; errors first. Clicking a row opens the application. |
| Recent activity | <ul><li>Kubernetes events from Argo CD (`OperationStarted`, `OperationCompleted`, `ResourceUpdated`, ApplicationSet `created`, …) plus deployment history (`Deployed`). Nothing is synthesized.</li><li>Filters: kind, namespace, application, type, and time range (1h, 6h, 24h, 7d, any).</li><li>Kubernetes keeps events for about an hour by default, which the UI says.</li></ul> |
| Applications | Search across name, namespace, project, destination and repository; filters for project, health, sync and ApplicationSet; sortable columns (status sorts put problems first); at most 500 rows rendered; right-click menu (details, events, YAML, Argo CD UI). |
| Application details | <ul><li>**Overview:** project, ApplicationSet, repository, path or chart, target revision, synced revision, destination, sync policy, times, last operation, sync errors.</li><li>**Resources:** grouped by kind with sync and health, an out-of-sync-only filter, and Open in the resource browser.</li><li>**Events, History, YAML** (redacted, read-only) and **Conditions.**</li></ul> |
| Application sets | Generators (type and summary), template (name pattern, project, source, destination), generated applications (live sync and health, linked), conditions, errors, events, YAML. |
| Projects | Description, source repositories, destinations, cluster and namespaced allow/deny rules, roles (policies and groups), associated applications, YAML. |

### Flux
| Area | Implementation |
|---|---|
| Overview | Counters (resources, ready, failing, suspended, reconciling, stalled, unknown); one card per detected kind (ready/total, failing link); Needs Attention covering stalled, not ready (reason and message), unknown, suspended, and source not ready for dependent workloads. |
| Lists | Kustomizations, Helm releases, and Sources (Git, Helm, OCI, Bucket, plus a combined view). Search, status filter, sortable columns. Shows applied revision, a flag when the attempted revision is newer, last reconciled, interval and message. |
| Details | <ul><li>**Overview:** revisions, last success and last reconcile, interval, suspended, source (linked, with its readiness), URL, ref, path, chart.</li><li>**Resources:** inventory with Open; for sources, the Kustomizations and Helm releases that use them.</li><li>**Events, History, YAML, Conditions.**</li></ul> |

### Files
- **New:**
  - `src/renderer/src/ArgoCDPage.tsx`, `src/renderer/src/FluxPage.tsx`, `src/renderer/src/gitops-ui.tsx`.
  - `tests/gitops-dashboard.test.ts`.
  - Fixtures `tests/fixtures/argo-appprojects.json`, `argo-applicationsets.json`, `argo-events.json`, `flux-ocirepositories.json`.
- **Replaced:** `src/renderer/src/GitOpsPage.tsx` (removed).
- **Changed:**
  - `src/shared/gitops.ts`, `src/main/gitops.ts` (Argo CD URL).
  - `src/main/resources.ts` and `src/main/validation.ts` (`fieldSelector`).
  - `src/shared/protocol.ts`, `src/main/ipc/index.ts` (`gitops:argo-url`, `gitops:open-argo`).
  - `src/renderer/src/hooks.ts` (`fieldSelector` parameter).
  - `src/renderer/src/Navigator.tsx`, `App.tsx`, `store.ts`, `src/shared/catalog.ts` (the views `gitops-argo` and `gitops-flux`).
  - `src/renderer/src/styles.css`, `tests/gitops.test.ts`, `tests/gitops-smoke.mjs`, `tests/fixtures/argo-applications.json`.
- **Dependencies:** none added. The renderer now imports `yaml`, an existing dependency, for the YAML tab.

### Security and performance
- **Read-only:** only `GET` and watch requests are sent. The smoke test asserts this. There are no sync, refresh-operation, reconcile or delete actions.
- **RBAC:** each list reports permission denied separately, so a denied kind doesn't hide the others.
- **Untrusted data:** all object data goes through type-checked accessors. YAML is redacted, removing Secret payloads and credential-looking values.
- **Watch scope:** watches are narrowed by namespace and field selector; undetected types are never watched.
- **Rendering:** derived data is memoized per watch update. Pages use store selectors instead of the whole store. At most 500 rows are rendered.
- **Large collections:** 10,000 applications are summarized and filtered in well under 1.5 s (unit test).

### Tests (actual status)
| Test | Type | Result |
|---|---|---|
| `tests/gitops.test.ts`: 17 tests (mappers on captured objects, malformed data, detection including versions, fallbacks, missing CRDs, failed or denied discovery) | Unit | Pass |
| `tests/gitops-dashboard.test.ts`: 17 tests (every status category, the live counters, filters, sorting, every Needs Attention rule, projects, ApplicationSets, activity built from captured events plus filters and time range, Flux counters and attention including stalled, suspended and source-not-ready, OCI mapping, source consumers, URL rules, IPC validation, 10,000 apps) | Unit | Pass |
| `tests/gitops-smoke.mjs`: Electron UI against a fake API server serving the captured objects and events (counters and filtering, cards, Needs Attention, Recent Activity filters, all six application tabs, context menu, Open, Open Argo CD UI with the opener intercepted, projects, ApplicationSets, RBAC denial, 1,200 apps, the Flux overview, kinds, sources and details, empty and unreachable clusters, `GET`-only) | UI integration (fixtures, not live) | Pass |
| Live UI run on Kubernetes v1.36.6 with Argo CD v3.5.6 and Flux v2.10.0 (counters equal to `kubectl` at run time; 41 real activity rows; real per-app events; projects; ApplicationSets; all tabs; Open; OCI source; HelmRelease history) | Live | Pass |
| Live RBAC with a restricted ServiceAccount: Argo CD denied; Kustomizations visible in `flux-system`; Helm releases "No permission to list" | Live | Pass |

### Limitations
- **Desired versus live manifests, the Argo CD child resource tree, and per-resource health on Argo CD 3** live only in the Argo CD API server. They are not available through the Kubernetes API and are not shown. Sync status per resource is shown.
- **"Open Argo CD UI"** appears only when `argocd-cm` publishes `url`. The test cluster doesn't, so the button was verified with fixtures only.
- **Recent Activity** depends on Kubernetes event retention, about 1 hour by default. Deployment history covers longer periods.
- **Not implemented:** resizable dashboard sections, and mutation actions (Sync, Refresh operation, Reconcile, Suspend). Mutations are planned for P2, behind confirmation and permission checks.

## 4. Reliability and security fixes (branch `fix/p0-reliability`)

### 4.1 KUBECONFIG merging (audit K8S-6, PERF-8)
- **New module:** `src/main/kubeconfig-merge.ts`. `ClusterManager.discover()` uses it.
- **Which files are read:**
  - Like kubectl, the `KUBECONFIG` list is read in order, or `~/.kube/config` when it is unset.
  - **Behavior change:** previously Optic loaded both `~/.kube/config` and the `KUBECONFIG` files.
  - Kubeconfigs imported into Optic stay isolated.
- **Merge rules (kubectl's):**
  - The first file to define a cluster, user or context name wins.
  - The first `current-context` wins.
  - Missing files are skipped.
  - A context can reference a cluster or user from another file.
- **Relative paths** resolve against the declaring file, matching client-go:
  - `certificate-authority`, `client-certificate`, `client-key` and `token-file`;
  - an exec `command` written as a path.
  - This also fixes client-node reading `token-file` relative to the process's working directory.
- **Malformed files** are skipped with a warning naming only the path; kubectl would fail the whole command. A context whose user is missing gets a warning.
- **Parsing and IDs:**
  - Each file is parsed once.
  - Each context keeps a config containing only its own cluster, user and context.
  - IDs remain `sha256(defining file, context)`, so settings and MCP approvals carry over.
- **Tests:** `tests/kubeconfig-merge.test.ts` (7). These include a comparison with the installed kubectl:
  - `config view` and `get-contexts` agree on contexts, cluster and user mapping, servers and current-context;
  - `config view --flatten` embeds exactly the files Optic resolved.

### 4.2 Temporary credential cleanup (audit SEC-3, SEC-4)
- **New module:** `src/main/credential-files.ts`.
- **Session kubeconfigs** (terminals, port forwards, drains, Helm, deploy) are created in `<profile>/sessions/session-XXXXXX/`, with an `.owner` file recording the process ID. Without a profile (tests), they use the temp folder as before.
- **Startup sweep** (`ClusterManager.sweepStaleFiles()`, run when the IPC layer starts). It removes only:
  - session folders whose owner process has exited;
  - Optic-named folders (`optic-{session,plan,import,fetch,dependencies,chart-helm,monitoring-helm}-XXXXXX`) in the temp directory that were last modified before the computer booted.

  It never deletes a session of a running process or anything modified since boot. It considers only exact name patterns and direct children of those folders, never follows or removes symbolic links, and never touches user files.
- **Context-removal backups:**
  - New backups are written to `<profile>/kubeconfig-backups/` (mode 0600; Optic's profile is private to the user).
  - The newest 5 per kubeconfig are kept, and only files matching Optic's backup naming are rotated.
  - Existing `<kubeconfig>.workbench-*.bak` files from earlier versions are **not** deleted; remove them manually if no longer needed.
  - The dialog text explains the new location and retention.
- **Tests:** `tests/credential-files.test.ts` (8). They cover:
  - sessions of exited processes removed; live, own and recent sessions kept; pre-boot leftovers removed;
  - look-alike names and user files kept; links not followed;
  - backup retention;
  - a crash-recovery sweep that leaves the original kubeconfig intact;
  - context removal keeping the original credentials in the backup.

  The main smoke test checks the backup's location.

### 4.3 Command palette resource search (audit FE-6)
- **New component:** `src/renderer/src/CommandPalette.tsx`, which also hosts the existing view and command entries.
- **What it searches:**
  - Clusters, by name.
  - In the current namespace: namespaces, pods, deployments, services, ConfigMaps and Secrets. Secrets are matched by name only; payloads never reach the renderer.
  - Cluster-wide: Argo CD Applications and the detected Flux kinds.
- **Requests:**
  - Nothing is fetched until two or more characters are typed.
  - Then one list request per kind is made, with the results cached for 60 seconds per cluster and namespace (names only), so typing filters locally.
  - Kinds that cannot be listed are named in a note.
- **Opening a result:**
  - Kubernetes objects open in the resource browser.
  - GitOps objects open in their Argo CD or Flux page details, through a small `gitopsFocus` store hand-off.
- **Tests:** `tests/command-palette.test.ts` (3), and GitOps smoke steps that search for and open an Argo CD application and a Flux Kustomization.

### 4.4 Rendering performance (audit PERF-3)
Measured with React's developer hook against 500 pods (a scratch harness, not part of the app):

| Scenario | Before | After |
|---|---|---|
| Toggle dock ×4 | 2,049 component renders | 5 |
| 5 pod watch updates | 5,026 | 81 |
| Navigator filter typing ×5 | 13 | 13 (no change needed) |
| Details tab switches ×4 | 84 | 84 (no change needed) |

- **Changes:**
  - `App`, `ResourcePage`, the Welcome page, `Navigator` and `ResourceTable` subscribe through `useShallow` selectors instead of the whole store.
  - Table rows are memoized. A row re-renders when its object's `resourceVersion`, its selection or checkbox, the columns, or the minute (for Age) changes; rows without a `resourceVersion` compare by object identity.
- **Not changed:** other `useStore()` users (ClusterMenu, ManifestDialog, ImportDeployDialog, Applications, SecurityDashboard, ClusterSettingsPage) are dialogs or pages that were not measured as hotspots.

### 4.5 Documentation and Dependabot
- **Docs:** `docs/` is no longer ignored by git. The technical audit (`docs/TECHNICAL_AUDIT.md`, now with a remediation status table) and the gap analysis (`docs/PREMIUM_GAP_ANALYSIS.md`) were recovered from the session record after the scratch copies were lost.
- **Dependabot (moderate):**
  - The alert is minimatch **GHSA-g3hv-75wg-m249**, a denial of service via glob-pattern amplification affecting versions below 11.0.1.
  - It is reached only through `electron-builder`, the build-time packaging toolchain. Four minimatch versions are present (3.1.5, 5.1.9, 9.0.9, 10.2.6). Even the newest `electron-builder` (26.18.0) depends on minimatch 10.x.
  - Forcing minimatch 11 through overrides would break packages written for the 3.x and 5.x APIs. npm's suggested "fix" is a downgrade to `electron-builder` 20.x.
  - **Decision:** no dependency change. The patterns come only from the project's own build configuration, and production dependencies have 0 vulnerabilities.
  - **Recommendation:** dismiss the alert as a build-time tolerable risk and recheck when `electron-builder` updates.

## Verification baseline

The suites below must pass after each feature: `npm run typecheck`, `npm test`, `npm run test:smoke` and `npm audit --omit=dev`.

Run them from `D:\projects\Optic` with an uppercase drive letter. A lowercase `d:` working directory makes vitest load modules twice and every test file fails.
