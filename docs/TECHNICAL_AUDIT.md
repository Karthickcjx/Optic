> **Remediation status (updated 2026-11-02).** The findings below are the original audit text.
>
> | Item | Status | Where |
> |---|---|---|
> | P0 1–7: colon names, watch timeouts, Status messages, apply conflicts and field manager, Escape and unsaved-changes guard, mojibake, re-listing after actions | Fixed | `fix/p0-audit` (commits `cbc2933` … `a5e0300`) |
> | K8S-3 (Status messages discarded) | Fixed | P0 3 |
> | K8S-4 / K8S-5 (apply conflicts, two field managers) | Fixed | P0 4 |
> | FE-1 (Escape discards YAML edits) / FE-2 (mojibake) | Fixed | P0 5 / P0 6 |
> | PERF-2 (re-list after every action) | Fixed | P0 7 |
> | K8S-6 (`KUBECONFIG` not merged) | Fixed: kubectl-compatible merge, verified against `kubectl config view` | `fix/p0-reliability` |
> | PERF-8 (kubeconfig parsed once per context) | Fixed: each file parsed once | `fix/p0-reliability` |
> | SEC-3 (temporary credential kubeconfigs left behind) | Fixed: profile-owned session folders with owner PID; startup sweep of stale ones | `fix/p0-reliability` |
> | SEC-4 (backups pile up next to the kubeconfig) | Fixed for new backups: profile folder, newest 5 kept. Existing `.workbench-*.bak` files are not deleted. | `fix/p0-reliability` |
> | FE-6 (palette doesn't search resources) | Fixed: clusters, namespaces, pods, deployments, services, ConfigMaps, Secrets (names), Argo CD and Flux objects | `fix/p0-reliability` |
> | PERF-3 (whole-store subscriptions) | Fixed where measured: App, ResourcePage, Navigator, ResourceTable selectors, plus memoized table rows | `fix/p0-reliability` |
> | Other findings | Open | See below |

# Optic — Technical Inspection Report

- **Project:** Optic, a Kubernetes desktop workspace (Electron + React + TypeScript)
- **Version inspected:** `0.1.0-beta.2`, commit `acf34fe` on `main`, plus an uncommitted change to `package.json` and `package-lock.json` (Electron `45.0.0` → `^45.2.1`)
- **Date:** 2026-11-02
- **Scope:** every tracked file under `src/` (main, preload, renderer, shared), all configuration files, `scripts/`, `.github/`, `tests/`, and the project documents (`README.md`, `ARCH_SPEC.md`, `EXTENSIONS.md`, `SECURITY.md`, `RELEASE_NOTES.md`). Where Optic's behavior depends on a library, the library source in `node_modules/@kubernetes/client-node/dist/watch.js` was also read.

## How this inspection was done

No source files were changed. These commands ran, and none of them modify anything:

| Command | Result |
|---|---|
| `npx tsc --noEmit` | Passed (exit code 0) |
| `npx vitest run` | 39 test files and 188 tests passed in 3.4 seconds |
| `npm audit --omit=dev` | 0 vulnerabilities in production dependencies |

These were **not** run:

- The Electron and Playwright smoke suites (`npm run test:smoke`). They rebuild the app and launch Electron.
- Anything against a live cluster. No real cluster was contacted.

Each finding has a verification level:

- **Confirmed:** the defect follows directly from the source code shown.
- **Confirmed (library):** the defect follows from Optic's code together with library code that was read.
- **Potential:** a risk that needs runtime measurement or a live cluster to prove.

### Inspection checklist

| Area | Status |
|---|---|
| Entry points, lifecycle, IPC protocol, preload | Done |
| Main-process services (25 modules) | Done |
| Shared contracts and logic (23 modules) | Done |
| Renderer (47 files, including `styles.css`, which was scanned only) | Done |
| Build, packaging, CI, scripts | Done |
| Tests (inventory and unit-test run) | Done |
| Documents compared against the code | Done |

---

## 1. Executive summary

Optic is a broad, carefully defended beta. Most of its Electron security baseline is better than typical desktop Kubernetes tools:

- Context isolation is on and the renderer is sandboxed.
- The preload exposes only two functions.
- Every IPC message is validated by Zod and checked for its sender frame.
- The Content Security Policy is strict.
- Navigation, pop-up windows, `<webview>` tags and permission requests are all denied.
- Secrets are redacted.
- Every CLI call gets its own isolated temporary kubeconfig.
- Mutations are confirmed in the UI and guarded by resourceVersion or UID checks.
- Extensions run in separate hidden, sandboxed renderers with network access blocked.

The feature set is large: resources, logs, terminals, port-forward, node shell, Helm, import and deploy, metrics, cost, Trivy security reports, EKS discovery, and extensions.

The main weaknesses are correctness at the edges of the Kubernetes API, efficiency on large clusters, and maintainability:

1. **Two High-severity confirmed bugs in core browsing:**
   - Resource names that contain `:` (all the `system:*` and `eks:*` ClusterRoles and bindings) cannot be viewed as YAML, saved, or deleted. (K8S-1)
   - Watches on quiet resources hit the client library's 30-second inactivity timeout. The user sees a false "API did not respond in time" error, and the whole list is re-fetched every cycle. (K8S-2)
2. **Kubernetes error details are thrown away.** Admission denials, server-side-apply conflicts, and "container is waiting to start" log errors all appear as generic or misleading messages. (K8S-3)
3. **Large clusters will struggle.** The app sends full list snapshots over IPC on every change and has no label or field selectors. Several screens subscribe to the whole store, every resource action tears down all watches, and the log view is not virtualized. (PERF-1 to PERF-7)
4. **Maintainability is the biggest long-term risk.** The code is extremely dense: 158 lines are over 400 characters, and many JSX trees sit on a single line. The `Resource` type is effectively `any`, logic is duplicated, there is no linter, and there is no logging or diagnostics layer.
5. **Release engineering is beta-grade.** Installers are unsigned, there is no auto-update, pull requests are validated on Windows only, and the app still carries the legacy `clusterworkbench` app ID and field-manager names.

**Readiness verdict:** suitable as a public beta for individual users on small and medium clusters. It is **not ready for general availability (GA) or enterprise use** until the P0 and P1 roadmap items in section 17 are done.

---

## 2. Project architecture

### 2.1 Processes and trust boundaries

```
┌──────────────────────────── Renderer (sandboxed, contextIsolation) ───────────────────────────┐
│ React 19 + Zustand stores (store.ts, resource-operations.ts, helm-operations.ts)             │
│ Pages: Welcome, Overview, ResourcePage/Table/Details, Helm, Cost, Security, Applications,    │
│        ClusterSettings, Extensions, Preferences; Dock (Terminal/Logs/Forward panes)          │
│ api.ts request() ──► window.desktop.request(channel,input)  /  window.desktop.subscribe()    │
└───────────────────────────────▲───────────────────────────────────────────────────────────────┘
        preload/index.ts (CJS)  │  contextBridge: {request, subscribe}; channel allow-list
                                │  ipcRenderer.invoke(channel) / 'stream:event' push
┌───────────────────────────────┴──────────────────── Main process ────────────────────────────┐
│ index.ts: single-instance lock, CSP header, permission deny, window guards                   │
│ ipc/index.ts: ipcMain.handle per channel → senderFrame==mainFrame && trusted URL →           │
│               zod schema (validation.ts) → handler(input, owner WebContents) → Result<T>     │
│ Services: ClusterManager, ResourceService (LIST/WATCH), SessionService (logs, PTY),          │
│   ForwardService, NodeShell, ResourceActions, HelmService, Deployments+Imports, Monitoring,  │
│   Providers/OverviewMetrics/ResourceMetrics, CostReports/CostEstimates, SecurityReports,     │
│   EksDiscovery, Extensions, external tools                                                   │
│ Streams registry: id → {owner, clusterId, dispose, write/resize/ack}                         │
└───┬─────────────────┬───────────────────┬──────────────────────┬────────────────────────────┘
    │ undici fetch     │ execFile/spawn     │ utilityProcess        │ hidden BrowserWindows
    ▼ (kubeJson, Watch)▼ kubectl/helm/aws   ▼ pty-worker (node-pty) ▼ extension hosts (data: URL,
 Kubernetes API      temp isolated kubeconfig  local shells, kubectl exec   no network, 5 s deadline)
 + services/proxy    per operation             worker_thread: helm-index-worker (YAML parse)
```

### 2.2 Application lifecycle

1. **Startup.** `src/main/index.ts` calls `registerIpc()` as soon as the module loads, which builds every service and reads persisted JSON from `userData`. Then:
   - `requestSingleInstanceLock` is taken.
   - On `whenReady`: permission requests and checks are denied, a CSP header is injected, and `createWindow()` runs.
   - The window opens hidden and shows on `ready-to-show`.
   - Extension hosts start on `whenReady`.
2. **Renderer boot.** `main.tsx` runs `StrictMode`, then a single `ErrorBoundary`, then `App`. `App` calls `clusters:list`, then `settings:get` for each cluster, then starts a 30-second `/version` health check.
3. **Navigation.** Workspace tabs (`pages`) are keyed by `view:cluster:custom`. Only the active page is mounted. Its key includes `connectionRevision` and the store `revision`, so connecting, disconnecting, or saving settings remounts the page.
4. **Streams.** Watches, logs, terminals, forwards and node shells register a stream ID through `Streams.add`. They are closed on tab close, window navigation, renderer crash, window close, a cluster settings save or disconnect, and `before-quit`.
5. **Shutdown.** On `before-quit`, the app closes all streams, extension hosts, deploy plans and imports, kills monitoring, Helm and action child processes, and cleans temporary directories.

### 2.3 IPC design

- There are 75 request channels, typed in `src/shared/protocol.ts`, validated at runtime in `src/main/validation.ts`, and implemented in `src/main/ipc/index.ts`.
- A single `stream:event` channel pushes `resources`, `data`, `error` and `end` events. Every renderer subscriber filters by stream ID.
- Logs and terminals use ack-based flow control. For logs, one chunk is in flight and the stream is killed with a slow-consumer error after 30 seconds. For terminals, the PTY pauses once more than 256 KB is unacknowledged.
- Errors cross IPC only as `{code, message, retryable}`. Raw messages are dropped on purpose to avoid leaking credentials (`src/main/errors.ts`).

### 2.4 Persisted state

| Location | Contents |
|---|---|
| `userData/kubeconfig-sources.json` | Imported kubeconfig paths |
| `userData/kubeconfigs/clipboard-*.yaml` | Pasted and EKS kubeconfigs, stored **unencrypted** |
| `userData/cluster-settings.json` | Per-context settings: proxy, metrics, cost, node-shell image |
| `userData/helm-repositories.json`, `import-operations.json`, `external-tools.json` | Helm repositories, deploy journal, external tool choice |
| `userData/extensions/*.json`, `safe-mode.json` | Extension bundles (manifest, code, digest) |
| Renderer `localStorage` | Cluster label, color and pin; navigator width; AWS section expanded |
| `<kubeconfig>.workbench-<uuid>.bak` next to the user's file | Backup taken before a context is removed (contains credentials) |
| OS temp `optic-session-*`, `optic-*-helm-*`, `optic-plan-*`, `optic-import-*` | Short-lived isolated kubeconfigs and staging directories |

---

## 3. Technology stack

| Layer | Technology (version) | Notes |
|---|---|---|
| Shell | Electron `^45.2.1` (lockfile 45.2.1), electron-vite 6, electron-builder 26.15.3 | NSIS installer on Windows, DMG on macOS, AppImage on Linux |
| UI | React 19.3, Zustand 5, @tanstack/react-table 8, lucide-react, Tailwind 4 (Vite plugin) with a hand-written `styles.css` (66 KB) | No router: views are driven by the store |
| Terminal | @xterm/xterm 6 + fit addon; node-pty 1.1.0 inside an Electron `utilityProcess` | `npmRebuild: false`, relies on prebuilt binaries |
| Kubernetes | @kubernetes/client-node 2.0.1 (auth, KubeConfig, Watch) plus raw `undici` fetch (`kubeJson`) | REST is mostly hand-written against paths, not the generated clients |
| Validation | Zod 4 | On every IPC channel and in the persisted-settings schemas |
| YAML and archives | `yaml` 2.9, `tar` 7.5 | Alias limits and archive traversal checks are applied |
| External CLIs | `kubectl` (exec, port-forward, drain, kustomize), `helm` 3 or 4, `aws` CLI v2 | Each gets an isolated temporary kubeconfig |
| Tests | Vitest 5 (unit), Playwright `_electron` with a fake HTTP API server (smoke) | 39 unit files and 10 smoke scripts |
| CI | GitHub Actions: `validate.yml` (Windows) and `release.yml` (Windows build plus a Linux and macOS package smoke on tags) | Dependabot weekly |

---

## 4. Module-by-module analysis

### 4.1 Main process (`src/main`)

| Module | Responsibility | Assessment |
|---|---|---|
| `index.ts` | Window creation, CSP, permission deny, navigation guards, lifecycle | Solid. `second-instance` does not restore a minimized window (ELEC-3). No crash or `unhandledRejection` handlers (ELEC-2). |
| `ipc/index.ts` | Handler table, sender and frame checks, schema validation, busy guards across services | Good central choke point. Services are wired by hand with forward references to `deployments`, which works only because of closure timing. |
| `validation.ts` | Zod schemas per channel | Thorough, but the shared `name` regex is too strict (K8S-1). |
| `clusters.ts` | Kubeconfig discovery and import, per-context entries, proxy override, isolated CLI kubeconfigs, context removal | Each file is loaded on its own, so `KUBECONFIG` merge semantics are not honored (K8S-6). The file is parsed once per context (PERF-8). Leftover temporary kubeconfigs and `.bak` files contain credentials (SEC-3, SEC-4). |
| `kube-http.ts` | Minimal authenticated fetch with a 20-second timeout | Throws away the Kubernetes `Status` body (K8S-3). |
| `resources.ts` | Catalog paths, LIST (paginated, capped at 50k), WATCH and cache, YAML get and replace, delete, restart, scale, cordon, server-side apply, metrics-server | The core of the app. Watch issues: K8S-2 and PERF-1. Apply issues: K8S-4 and K8S-5. |
| `sessions.ts`, `pty-worker.ts` | Log streaming over raw HTTP with ack backpressure; PTY sessions for local shells, `kubectl exec`, AWS SSO and external tools | Well bounded. Error mapping is weak (K8S-3). The exit code can be lost (ELEC-4). |
| `forward.ts` | `kubectl port-forward --address=127.0.0.1` with readiness parsing | Correct. No auto-reconnect (MISS-8). |
| `node-shell.ts` | Privileged `nsenter` pod in `kube-system`, cleanup on close, one-hour deadline | Confirmed in the UI. The default image is a mutable tag (SEC-6). |
| `resource-actions.ts` | Drain (through kubectl), rollback, CronJob trigger and suspend, form edits with JSON-patch `test` preconditions | Strong optimistic concurrency. Drain preview lists every pod in the cluster (PERF-9). |
| `helm.ts`, `helm-cli.ts`, `helm-index*.ts` | Repository catalog (index parsed in a worker), preview token bound to a SHA-256 of the plan, install, upgrade, rollback, uninstall, details | Well designed. Duplicates the index fetch logic in `monitoring.ts` and `deploy.ts` (CQ-3). |
| `deploy.ts`, `imports.ts` | Staging imports (files, folder, kustomize, chart, archive, remote), dry-run preview, background apply with journal | Defensive with archives and kustomize. Remote downloads reject redirects (K8S-7). Uses a different field manager (K8S-5). |
| `monitoring.ts` | Installs the Prometheus community charts into `optic-monitoring` | Parses a large Helm index on the main thread (PERF-5). |
| `providers.ts`, `overview-metrics.ts`, `resource-metrics.ts` | Prometheus discovery through the service proxy, history queries, metrics-server fallback | Discovery is uncached on the hot path (PERF-4). The endpoint cache is duplicated three times (CQ-3). |
| `cost-*.ts`, `node-pricing.ts` | OpenCost and Kubecost allocation parsing, Prometheus-based estimate, public AWS and Azure price feeds | Rigorous about data quality. Circular import with `providers.ts` (CQ-5). |
| `security.ts` | Reads Trivy Operator CRDs with an allow-list of fields | Good. Report-to-pod matching is quadratic (PERF-10). |
| `eks.ts`, `external-tools.ts`, `terminal-profiles.ts` | AWS CLI discovery and EKS kubeconfig generation; launching external CLI tools; shell detection | Safe argv handling. Batch-file quoting goes through PowerShell `-EncodedCommand`. |
| `extensions.ts` | Extension install, review and digest; hidden sandboxed host; 5-second deadline | A robust design. The archive install path has no UI (CQ-6). |

### 4.2 Shared (`src/shared`)

- **Contracts:** `protocol.ts`, `catalog.ts`, and the domain types for helm, deploy, cost, security, eks and extensions.
- **Pure logic, mostly unit-tested:** `relationships.ts`, `status.ts`, `severity.ts`, `quantities.ts`, `metrics.ts`, `security-view.ts`, `resource-editors.ts`, `manifest-templates.ts`, `cost.ts`.
- **Notes:**
  - `Resource` is declared with `[key: string]: any` and `spec`/`status: Record<string, any>`, so almost all Kubernetes field access is untyped (CQ-2).
  - `protocol.ts` builds `channels` with several scattered `push` calls (CQ-7).

### 4.3 Renderer (`src/renderer/src`)

| Module | Responsibility | Assessment |
|---|---|---|
| `App.tsx`, `store.ts` | Shell, workspace tabs, command palette, health check, global keyboard handling | Subscribes to the whole store (PERF-3). Escape closes Details and loses YAML edits (FE-1). The palette says "Search resources" but only matches commands and kinds (FE-6). |
| `hooks.ts` (`useResources`) | Watch subscription per component | Re-subscribes on every resource action (PERF-2). Adds one IPC listener per hook (FE-5). |
| `Table.tsx`, `Details.tsx`, `ResourceProperties.tsx`, `RelatedResources.tsx`, `ResourceMetrics.tsx` | Resource browsing and inspection | Rich and accessible: keyboard rows, ARIA, severity tones. Bulk delete fails silently for `:` names (K8S-1). Events tab watches the whole cluster (PERF-6). |
| `ResourceEditor.tsx`, `ResourceActionDialog.tsx`, `ManifestDialog.tsx`, `ImportDeployDialog.tsx` | Mutations with validate, confirm and background-operation flows | Good UX discipline: a dry run is required before apply. |
| `Dock.tsx`, `TerminalPane.tsx`, `LogsPane.tsx`, `log-streams.ts`, `ForwardPane.tsx` | Session panes | The terminal is solid. The logs view is not virtualized (PERF-7). |
| `HelmPage.tsx`, `ClusterSettingsPage.tsx`, `CostDashboard.tsx`, `CostAccounting.tsx`, `SecurityDashboard.tsx`, `Applications.tsx`, `Overview.tsx` | Feature pages | Feature-complete for a beta. Mojibake in labels (FE-2). Helm namespace filter inconsistency (FE-3). Applications opens 8 watches (PERF-11). |
| `ErrorBoundary.tsx` | One top-level boundary | A single failure takes down the whole workspace and its sessions (FE-4). |

---

## 5. Electron architecture findings

**Strengths, confirmed:**

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` and `webSecurity: true` are set (`index.ts:16`).
- `setWindowOpenHandler` denies pop-ups, `will-navigate` is guarded, `will-attach-webview` is blocked, and permission requests and checks are denied.
- The production CSP is `script-src 'self'` with no `unsafe-eval`.
- Every IPC message is checked: `senderFrame === mainFrame` and a trusted URL (`ipc/index.ts:151`).
- Streams are owned per `WebContents` and cleaned up on navigation, crash and close.
- PTYs run out of process in a `utilityProcess`, and YAML parsing of large Helm indexes is off-thread in `helm-index-worker`.

**ELEC-1 — A compromised renderer means local code execution, by design (Medium, Potential).**

- **Files:** `src/main/external-tools.ts` (`externalToolLaunch`); `ipc/index.ts` (`tools:save`, `terminal:open`, `terminal:write`).
- **Evidence:** `tools:save` accepts any `executable`, and `terminal:open {externalTool:true}` launches it. Local shells accept `terminal:write`.
- **Problem:** this is inherent to a terminal app. There is no `dangerouslySetInnerHTML` or `innerHTML` anywhere in `src` (checked), and all content is escaped by React, so cross-site scripting risk is low. But any future script injection would immediately become remote code execution.
- **Recommendation:**
  - Keep the CSP strict.
  - Add a lint rule banning HTML sinks.
  - Consider requiring a native confirmation dialog in main for `tools:save` when `selected === 'custom'` changes, so the renderer alone cannot persist a new executable.

**ELEC-2 — No main-process crash handling or diagnostics (Medium, Confirmed).**

- **Files:** `src/main/*` (absent).
- **Evidence:** a search for `uncaughtException`, `unhandledRejection`, `crashReporter` and logging finds nothing. Failures are visible only as `console.warn`, for example in `clusters.ts:104` and `node-shell.ts:24`.
- **Problem:** many `catch {}` blocks swallow errors silently, for example corrupt settings in `cluster-settings.ts:25` and `helm.ts:50`. Users cannot produce support logs, and a crash in main shows Electron's default dialog.
- **Recommendation:**
  - Add a small structured logger with redaction, writing a rotating file under `userData/logs`.
  - Register `process.on('unhandledRejection'|'uncaughtException')` handlers.
  - Add a "Copy diagnostics" action.

**ELEC-3 — `second-instance` does not restore a minimized window (Low, Confirmed).**

- **File:** `src/main/index.ts:39`.
- **Evidence:** the handler calls `window.show(); window.focus();` but never checks `isMinimized()`.
- **Recommendation:** call `if (window.isMinimized()) window.restore()` first.

**ELEC-4 — A terminal's exit code can be lost (Low, Potential).**

- **File:** `src/main/pty-worker.ts:17`.
- **Evidence:** `terminal.onExit(... parent.postMessage({type:'end',exitCode}); process.exit(0); })`.
- **Problem:** exiting immediately after `postMessage` can drop the message. Main then reports the worker's exit code (`0`) instead of the shell's, through `sessions.ts:107`.
- **Recommendation:** exit with the shell's code (`process.exit(exitCode)`), or wait for the parent to acknowledge or close the port before exiting.

**ELEC-5 — One broadcast channel and one listener per subscriber (Low, Potential).**

- **File:** `src/preload/index.ts:10`.
- **Evidence:** every `subscribe()` adds its own `ipcRenderer.on('stream:event')` listener. The Applications page alone mounts 8 `useResources` hooks, plus the Dock panes.
- **Problem:** every event is delivered to every listener (O(N) per event). Going past 10 listeners will likely produce Node's `MaxListenersExceededWarning`.
- **Recommendation:** register one preload listener and dispatch to a `Map<id, handler>`.

**ELEC-6 — 24 streams per window (Low, Potential).**

- **File:** `src/main/streams.ts:10`.
- **Problem:** hidden Dock tabs keep their streams. For example, two multi-pod log tabs with 8 sources each, plus the Applications page's 8 watches, reach the 24-stream cap. The next open fails with "Close a stream before opening another."
- **Recommendation:** count watches separately from sessions, or raise the cap and show a count in the UI.

---

## 6. Frontend findings

**FE-1 — Pressing Escape anywhere discards unsaved YAML edits (Medium, Confirmed).**

- **Files:** `src/renderer/src/App.tsx:59` (global keydown) and `Details.tsx:51` (YAML textarea).
- **Evidence:** `if (e.key === 'Escape') { setPalette(false); setManifest(false); store.select(undefined); }` runs on the document for every Escape, including while the user is typing in the Details YAML editor or has a confirmation box open.
- **Problem:** `select(undefined)` unmounts `Details`, and the edited YAML is lost with no warning.
- **Recommendation:** skip the handler when `event.target` is an input, textarea or contenteditable element. Track a dirty flag in `Details` and ask for confirmation before closing.

**FE-2 — Mojibake: corrupted separator characters in visible UI strings (Low, Confirmed).**

- **Files:**
  - `HelmPage.tsx:56`: the notification title is `` `${label} ? ${clusterName} / ${namespace}` ``.
  - `CostDashboard.tsx:59`: `'Prometheus ? CPU / RAM estimates'` and `'Allocation provider ? Reported resource costs'`.
  - `CostDashboard.tsx:71`: the chart tooltip is `` `${start} ? ${end}` ``.
- **Problem:** a separator character (probably `·`, `→` or `–`) was replaced by `?` during an encoding conversion.
- **Recommendation:** restore the characters, and add an `.editorconfig` with `charset = utf-8`.

**FE-3 — Helm Releases ignores the namespace filter except on Refresh (Low, Confirmed).**

- **File:** `HelmPage.tsx:28` compared with `:23`.
- **Evidence:** the effect calls `request('helm:releases', { clusterId })` without `namespace`, while `loadReleases()` passes it. After any operation (the `operationRevision` dependency), the list falls back to all namespaces even when a namespace is typed.
- **Recommendation:** pass `namespace` in the effect and debounce it.

**FE-4 — A single top-level error boundary (Medium, Confirmed).**

- **Files:** `main.tsx:6` and `ErrorBoundary.tsx`.
- **Problem:** any render error in any page or pane replaces the whole workspace. The only recovery is a reload, which kills every terminal and port-forward. That is what the fallback text itself says.
- **Recommendation:** add boundaries for each workspace page and each Dock pane, so failures stay local and can be retried.

**FE-5 — Every `useResources` call opens its own watch, with no shared cache (Medium, Confirmed).**

- **File:** `hooks.ts:21-41`.
- **Problem:** the same scope is watched several times at once. For example, Overview watches pods, events and nodes; Details, RelatedResources and Security watch pods again in the same namespace. `ARCH_SPEC.md:59` acknowledges this.
- **Recommendation:** add a reference-counted subscription cache keyed by `cluster/kind/namespace/custom`, in the renderer or in main.

**FE-6 — The command palette promises resource search but only matches commands (Low, Confirmed).**

- **File:** `App.tsx:69,83`.
- **Evidence:** the placeholder reads "Search resources and commands", but the list is built only from fixed views and catalog kinds.
- **Recommendation:** search the cached resource names, or rename the placeholder.

**FE-7 — Redaction is inconsistent across views (Low, Confirmed).**

- **File:** `ResourceProperties.tsx:29` and `:57`.
- **Evidence:** container environment values are redacted by a name heuristic, but the same values are shown raw under "Additional API details › Specification" and in the YAML tab.
- **Recommendation:** treat the heuristic as cosmetic and document it, or apply it consistently. Do not imply protection that the other views do not give.

**Other frontend notes:**

- **Accessibility is above average:** ARIA labels, keyboard navigation for rows and charts, focus traps in some dialogs, and `:focus-visible` styles.
- **Focus trapping is not uniform.** Each dialog re-implements Escape handling and focus logic, roughly ten times over (CQ-3).
- **Routing is store-driven with no URL state.** That is fine for a desktop app, but deep links and restoring tabs on restart are not possible. Pages are not persisted across restarts (MISS-11).

---

## 7. Kubernetes integration findings

### 7.1 What is implemented and how

| Capability | Implementation | Status |
|---|---|---|
| Kubeconfig handling | `~/.kube/config`, the `KUBECONFIG` list, imported files, pasted YAML, and EKS-generated configs. Each context becomes a cluster entry, and the proxy can be overridden per context. | Works, but `KUBECONFIG` files are not merged (K8S-6). |
| Authentication | `@kubernetes/client-node` `applySecurityAuthentication`: certificates, tokens, exec plugins and auth providers. TLS follows the kubeconfig. | Works. Exec plugins run local commands, and the UI warns about this (SEC-5). |
| Cluster switching and multiple clusters | Workspace tabs are per cluster, health is checked per context, and connect and disconnect close streams | Works. Several clusters can be open at once. |
| Namespaces | A watch on `namespaces`, or a manual "accessible namespaces" list for restricted RBAC | Works. Good handling of restricted RBAC. |
| Pods | List, watch, details, containers, logs (native HTTP stream), exec (`kubectl exec`), delete, port-forward (`kubectl`) | Works. Logs show misleading errors (K8S-3). |
| Deployments and other workloads | Scale through the `/scale` subresource, restart through a template annotation, rollback through a JSON patch with a `test` precondition, a form editor, revision history | Works and is well guarded. |
| Services and Ingress | List and details; a Service form editor; Ingress is read-only except through YAML | Partial. |
| ConfigMaps and Secrets | ConfigMap form editor. Secrets are **metadata only**: data is removed in `normalize`, and YAML is blocked. | ConfigMaps work. Secrets cannot be managed (MISS-1). |
| Logs and terminal | Multi-source logs with timestamp resume and de-duplication; local shells, pod shells, node shell, split panes | Works. Rendering cost at scale (PERF-7). |
| Resource monitoring | metrics-server, or Prometheus through `services/proxy`, with history; per-workload Pod series | Works. Discovery cost (PERF-4). |
| Watch API | LIST, then WATCH from the list's resourceVersion, with a UID-keyed cache, 100 ms coalescing, and backoff that re-lists | Defective (K8S-2, PERF-1). |
| API error handling | Mapped to generic codes, and the body is discarded | Weak (K8S-3). |
| RBAC | Errors are shown when a request is rejected. There are no permission checks beforehand. | No permission-aware UI (MISS-2). |
| Custom resources | CRD details open the instance list. Custom resource tables show only generic columns. | Basic (MISS-5). |

### 7.2 Findings

**K8S-1 — Names that contain `:` are rejected for YAML, save, delete, restart and scale (High, Confirmed).**

- **File:** `src/main/validation.ts:13` (`name`) and `:17` (`target = scope.extend({ name })`).
- **Evidence:**
  - `const name = z.string().min(1).max(253).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);`
  - Only `resources:get` was given a looser regex (`:93`, `[a-zA-Z0-9._:-]`), and only that channel is tested (`tests/security.test.ts:85`).
  - `resources:yaml`, `resources:replace`, `resources:delete`, `resources:restart`, `resources:scale`, `metrics:resource` and others still use `target`.
- **Problem:** every cluster has dozens of RBAC objects named `system:*`, and EKS has `eks:*`. For these objects:
  - The Details YAML tab shows "Invalid request payload."
  - YAML save fails.
  - Single and bulk delete fail. Bulk delete reports "Check permissions", which is misleading (`Table.tsx:60-61`).
  - Kubernetes allows `:` in RBAC names (path-segment names).
- **Recommendation:** define one `resourceName` schema. Allow everything except `/` and `%`, reject `.` and `..`, and cap the length at 253. Use it for every target and add tests for each channel. The path is already encoded with `encodeURIComponent` (`resources.ts:25`), so no other change is needed.

**K8S-2 — Quiet watches time out every 30 seconds, show a false error, and re-list (High, Confirmed (library)).**

- **Files:** `src/main/resources.ts:74-104` (`ResourceService.watch`) and `node_modules/@kubernetes/client-node/dist/watch.js:8,38-44,89`.
- **Evidence:**
  - The library's `Watch` has `requestTimeoutMs = 30000`. That timer is an inactivity timeout: it is reset only by body `data`, and when it fires it aborts and calls `done(TimeoutError)`.
  - Optic never overrides it: `new Watch(this.config(...))`.
  - `done → retry(error) → onError(error)` (`:81`, `:98`), and `fault()` maps a `TimeoutError` to "The Kubernetes API did not respond in time. Check your network or VPN…".
  - `backoff` is reset only on ADDED, MODIFIED or DELETED events (`:96`).
- **Problem:** resources that change rarely, such as Namespaces, Nodes, StorageClasses, CRDs, ClusterRoles and quiet namespaces, emit nothing within 30 seconds. API-server bookmarks arrive roughly every minute at best. As a result:
  1. An error banner appears roughly every cycle. It clears after the re-list.
  2. Backoff climbs to 30 seconds, leaving windows of up to 30 seconds with no watch.
  3. Every cycle runs a full paginated LIST.
  4. Server-side `timeoutSeconds: 240` never takes effect.
- **Reproduce:** open Namespaces or Storage Classes on a quiet cluster and wait 30 to 60 seconds.
- **Recommendation:**
  - Set `watch.requestTimeoutMs` above `timeoutSeconds`, for example 300 seconds.
  - Track the last seen `resourceVersion`, including from BOOKMARK events, and re-watch from it after a normal end or timeout.
  - Re-list only on `410 Gone` (an `ERROR` event with `code: 410`).
  - Reset backoff after a successful connection.
  - Surface errors only after N consecutive failures.

**K8S-3 — Kubernetes `Status` messages are discarded, so errors are generic or wrong (Medium, Confirmed).**

- **Files:** `src/main/kube-http.ts:9`, `src/main/sessions.ts:58` and `src/main/errors.ts:14-21`.
- **Evidence:** on a non-OK response, `response.body?.cancel()` runs and only `statusCode` is kept. `fault()` maps 400 and 422 to "Kubernetes rejected the resource. Check its required fields, API version and schema."
- **Problem:**
  - Opening logs for a pod whose container is still starting, or "Previous container" when there is none, returns 400 with a clear reason. Optic shows a schema error, and with `retryable:false` it never retries.
  - Admission-webhook and policy denials lose their explanation.
  - 403 responses lose the RBAC verb and resource.
  - 5xx responses become "Request failed. Check cluster connectivity…".
- **Recommendation:** parse the `application/json` `Status` body (`message`, `reason`, `details.causes`, `code`), truncate it to about 1–2 KB, and forward it. API-server `Status` messages do not contain client credentials. Keep the current generic text only for transport errors.

**K8S-4 — Server-side-apply conflicts and multi-document YAML give misleading errors (Medium, Confirmed).**

- **File:** `src/main/resources.ts:131-145` (`apply`).
- **Evidence:**
  - Apply is sent with `fieldManager=cluster-workbench` and no `force`. A field conflict (409) is reported as "The resource changed. Reload its YAML before saving."
  - `parse(yaml)` throws on multi-document input. The thrown error is not an `AppError`, so it becomes "Request failed. Check cluster connectivity…".
- **Recommendation:**
  - Detect a 409 with `reason: Conflict` on apply and show the conflicting managers.
  - Offer "Apply with force" behind a confirmation.
  - Detect multi-document input and point to Import and Deploy, or support it.

**K8S-5 — Two different field managers apply the same objects (Medium, Confirmed).**

- **Files:** `resources.ts:143` (`'cluster-workbench'`) and `deploy.ts:224` (`'optic-import'`).
- **Problem:** if an object is created through "Create resource" and later through Import and Deploy (or the other way round), it gets two owners. Changing a field one of them owns then fails with a conflict, which K8S-4 reports misleadingly. The legacy `cluster-workbench` name also leaks into `managedFields`.
- **Recommendation:** use one stable manager, for example `optic`, and document it.

**K8S-6 — `KUBECONFIG` files are loaded separately instead of merged (Medium, Confirmed).**

- **File:** `src/main/clusters.ts:57-72` (`discover`).
- **Evidence:** each path goes through `new KubeConfig(); parsed.loadFromString(source)` on its own.
- **Problem:** kubectl merges `KUBECONFIG` files. A context in file A that references a user or cluster defined in file B is common with split configs. Optic reports it as "Invalid cluster in context", or connects without credentials.
- **Recommendation:** for the `KUBECONFIG` list, merge with kubectl's precedence rules using `KubeConfig.loadFromFile` for each file, then `mergeConfig`. Keep explicitly imported files isolated.

**K8S-7 — Remote HTTPS chart import rejects redirects, which breaks common public repositories (Medium, Confirmed).**

- **Files:** `src/main/deploy.ts:87` (`remote → download`) and `ImportDeployDialog.tsx:112`.
- **Evidence:** `secureFetch(target, { redirect: 'error', ... })`.
- **Problem:** many repository indexes, including prometheus-community and argo, point their `urls` at GitHub release assets that redirect to another host. "HTTPS repository / archive" import therefore fails for these repositories, even though the Helm catalog path, which shells out to `helm`, works.
- **Recommendation:** follow up to about 5 redirects by hand. Require `https:` on every hop, and drop the `Authorization` header when the origin changes.

**K8S-8 — Drain preview lists every pod in the cluster (Low, Confirmed).**

- **File:** `resource-actions.ts:57`.
- **Evidence:** `this.resources.list({ clusterId, kind: 'pods' })`, then filtering on the client.
- **Recommendation:** use `fieldSelector=spec.nodeName=<node>`. This requires selector support (MISS-3).

**K8S-9 — The default container is the first container (Low, Confirmed).**

- **File:** `sessions.ts:42-45`.
- **Problem:** the `kubectl.kubernetes.io/default-container` annotation is ignored.
- **Recommendation:** honor the annotation.

---

## 8. Security findings

**Confirmed strengths:**

- A hardened `BrowserWindow`, CSP, navigation and permission denial.
- IPC sender validation and strict Zod schemas on 75 channels.
- No HTML injection sinks.
- Raw errors never cross IPC.
- Secrets are stripped from list and watch payloads, and their YAML is blocked.
- Helm manifests are redacted.
- Every CLI call uses argv only (`shell:false`), never shell strings.
- Temporary kubeconfigs are limited to a single context.
- Proxy URLs with embedded credentials are rejected.
- Archive traversal, link, size and ratio checks.
- Remote Kustomize references and executable generators are blocked.
- Helm apply is bound to a token from the preview.
- Port-forwards bind to 127.0.0.1 only.
- The extension sandbox has no network, no preload and no IPC, plus a 5-second deadline, WebRTC disabled, and a digest check on load.
- `npm audit` on production dependencies reports 0 vulnerabilities.

**SEC-1 — See ELEC-1: a compromised renderer can run local commands (Medium, Potential).**

**SEC-2 — Imported kubeconfigs are stored unencrypted (Medium, Confirmed, documented).**

- **File:** `clusters.ts:39-44`.
- **Evidence:** `writeFileSync(path, source, { mode: 0o600 })`. On Windows the file mode is ignored, and only the user-profile ACL protects the file.
- **Recommendation:** encrypt at rest with Electron `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret on Linux), or store a reference to the original file instead of a copy.

**SEC-3 — Temporary credential-bearing kubeconfigs can be left behind (Medium, Confirmed).**

- **File:** `clusters.ts:98-105` (`cliConfig`).
- **Problem:**
  - Every terminal, port-forward, drain and Helm or deploy call writes `optic-session-*/config` to the OS temp directory. It holds embedded client keys and tokens.
  - Cleanup runs when the session ends, but a crash or forced kill leaves the files.
  - Cleanup failures only produce a console warning.
- **Recommendation:**
  - Create these files under `userData/sessions`, not the shared temp directory.
  - Sweep stale `optic-*` directories at startup.
  - For pod exec, prefer stdin-fed or short-lived files.

**SEC-4 — Kubeconfig backups pile up next to the user's file (Low, Confirmed).**

- **File:** `clusters.ts:116-118` (`removeContext`).
- **Problem:** each removal writes `<file>.workbench-<uuid>.bak` with full credentials and never cleans it up. The UI does warn about this.
- **Recommendation:** store backups in the app profile with a retention limit, or keep only the most recent one.

**SEC-5 — Kubeconfig exec plugins run without review on first use (Medium, Potential).**

- **Files:** `clusters.ts:22-46` (`importClipboard`) and the `KubeconfigImport.tsx` copy.
- **Problem:** a pasted kubeconfig can declare `exec.command`, and that command runs on the first connection or health check. The UI shows a generic warning, but the command is never displayed. Health checks start automatically when a cluster is selected.
- **Recommendation:** at import time, list each exec command and its arguments, and require explicit approval for each new command.

**SEC-6 — The node-shell image is a mutable tag (Low, Confirmed).**

- **File:** `shared/cluster-settings.ts:13` (`nodeShellImage: 'alpine:3.21'`).
- **Problem:** the image runs privileged with host PID and host network.
- **Recommendation:** pin it by digest, and document how to mirror it.

**SEC-7 — CI actions are pinned by major tag (Low, Confirmed).**

- **Files:** `.github/workflows/*.yml` (`actions/checkout@v4` and others).
- **Recommendation:** pin to commit SHAs. Dependabot can update them.

**SEC-8 — Installers are unsigned and there is no update channel (Medium, Confirmed, documented).**

- **Problem:** without signing, the installer has no verifiable publisher and triggers SmartScreen warnings. Without updates, security fixes depend on users downloading new versions by hand.
- **Recommendation:** add Authenticode signing (Azure Trusted Signing or an EV certificate), Apple notarization, and `electron-updater` with signed metadata.

---

## 9. Performance findings

**PERF-1 — Every watch change sends the full list across IPC (High on large clusters, Confirmed).**

- **File:** `resources.ts:78` (`publish`).
- **Evidence:** `onItems([...cache.values()])` runs at most every 100 ms, sending the **whole** collection.
- **Problem:** with all namespaces selected, a busy pod list of 5k to 50k objects (full pod specs) is structured-cloned to the renderer up to 10 times a second. The renderer then rebuilds the table models. The Overview page does this for all pods and all events by default.
- **Recommendation:**
  - Send deltas (`added`, `modified`, `deleted`) with occasional full snapshots.
  - Strip heavy fields such as `managedFields` and long annotations on the server side for list views.
  - Default large clusters to a namespace selection.

**PERF-2 — Every resource action tears down and re-lists all watches (Medium, Confirmed).**

- **Files:** `hooks.ts:22,28,39` and `App.tsx:74`.
- **Evidence:** `useResourceOperations(s => s.revision)` is a dependency of every `useResources` effect, and the effect starts with `setItems([])`. The page-body key also includes `store.revision`.
- **Problem:** finishing any edit, rollback or drain empties every mounted table, closes its watch, and re-lists it. The watch would already have delivered the change.
- **Recommendation:** remove `actionRevision` from the dependencies, and keep the previous items while re-subscribing.

**PERF-3 — Components subscribe to the whole store (Medium, Confirmed).**

- **Files:** `App.tsx:40,50`, `Table.tsx:23`, `Navigator.tsx:11`, `ClusterMenu.tsx:8`, `ManifestDialog.tsx:9`, `ImportDeployDialog.tsx:15`, `Applications.tsx:11`, `SecurityDashboard.tsx:33` and `ClusterSettingsPage.tsx:16`.
- **Evidence:** each calls `useStore()` with no selector.
- **Problem:** any store change re-renders the whole shell and the active table. That includes opening a Dock tab, notifications, preference changes and namespace changes. `resourceSeverity` is then recomputed twice per row in `Table.tsx:12,66`.
- **Recommendation:** use selectors with `useShallow`, and memoize row-level derived values.

**PERF-4 — Prometheus discovery lists every Service in the cluster on each metrics poll (Medium, Confirmed).**

- **Files:** `providers.ts:13-19` (`discover`, `prometheus`) and `resources.ts:150-153` (`metrics`). Polled every 15 seconds by `Overview.tsx:145`.
- **Problem:** in `prometheus` mode without a configured service, or in `automatic` mode when metrics-server is missing, every poll does `GET /api/v1/services` across all namespaces and then tries up to 8 endpoints with 2 queries each. `overview-metrics.ts` and `resource-metrics.ts` cache the discovered endpoint for 5 minutes; this path does not.
- **Recommendation:** share one endpoint-discovery cache with a negative-result TTL.

**PERF-5 — The monitoring chart catalog is parsed on the Electron main thread (Medium, Confirmed).**

- **File:** `monitoring.ts:44` (`chartCatalog`).
- **Evidence:** `parse(Buffer.concat(chunks).toString('utf8'))` on up to 32 MB of the prometheus-community `index.yaml`. `HelmService` sends the same work to `helm-index-worker`.
- **Problem:** parsing a multi-megabyte YAML file blocks the main process. All IPC, terminals and log streams stall while it runs.
- **Recommendation:** reuse `parseHelmIndex` or the cached `HelmService` index.

**PERF-6 — The Events tab watches all cluster events for cluster-scoped objects (Medium, Confirmed).**

- **File:** `Details.tsx:27`.
- **Evidence:** `useResources(..., 'events', resource.metadata.namespace)` is called with `namespace === undefined` for Nodes, PVs and ClusterRoles, so it watches every namespace and filters by `involvedObject.uid` on the client.
- **Recommendation:** use `fieldSelector=involvedObject.uid=<uid>` (MISS-3).

**PERF-7 — The logs view re-renders and copies up to 5,000 lines every 40 ms (Medium, Confirmed).**

- **Files:** `LogsPane.tsx:26,46` and `log-streams.ts:33,70`.
- **Evidence:**
  - `snapshot()` copies the whole array on every publish.
  - `filtered` and `logSeverity()` regexes run for every line on every render.
  - Every line is a DOM `<span>`.
  - `this.lines.shift()` is O(n) once the cap is reached.
- **Problem:** high CPU use and dropped frames with chatty pods. Hidden panes keep processing.
- **Recommendation:** use a ring buffer, compute severity once on append, virtualize the list (or render through xterm), and pause rendering while the pane is hidden.

**PERF-8 — Each kubeconfig is parsed once per context (Low, Confirmed).**

- **File:** `clusters.ts:63-68`.
- **Evidence:** `config.loadFromFile(path)` runs inside the per-context loop. A file with 100 contexts is read and parsed 101 times, synchronously, on the main thread, on every `clusters:list`.
- **Recommendation:** parse once, then clone or `loadFromOptions` for each context. To resolve relative paths, call `makePathsAbsolute` once.

**PERF-9 — See K8S-8: drain preview lists every pod (Low).**

**PERF-10 — Matching security reports to pods is quadratic (Low, Potential).**

- **File:** `shared/security-view.ts:33-47` (`securityRows`).
- **Evidence:** for each pod container, `imageRows.find(...)` runs, so the cost is O(pods × containers × images). Large namespaces on "All namespaces" will be slow when the result is recomputed on each render.
- **Recommendation:** index rows by digest and by image key with `Map`s.

**PERF-11 — The Applications page opens 8 cluster-wide watches (Medium, Confirmed).**

- **File:** `Applications.tsx:11-23`.
- **Problem:** pods, deployments, statefulsets, daemonsets, jobs, cronjobs, services and namespaces are all watched with the default "All namespaces". Combined with PERF-1, this is the heaviest view.
- **Recommendation:** default to the first namespace on large clusters, or use label-selected lists.

**Background activity, for reference:**

| What | Interval |
|---|---|
| Health check (`/version`) | 30 s |
| Overview metrics | 15 s |
| Overview history | 30 s |
| Resource metrics | 15 s |
| Security reports | 60 s |
| Cost report (relative ranges) | 60 s |
| `deploy:status` polling | 2 s |
| `extensions:list` polling | 2 s |

The two 2-second polls are cheap but unnecessary. Push events would replace them.

---

## 10. Code quality findings

**CQ-1 — The code is extremely dense, which makes it hard to maintain (High for maintainability, Confirmed).**

- **Evidence:** 158 source lines are over 400 characters. `App.tsx:74` is a single JSX expression of more than 2,000 characters that routes every view. `Details.tsx:46-58`, `ClusterSettingsPage.tsx:170-179` and `HelmPage.tsx:73-82` pack whole UIs into a few lines.
- **Problem:** code review, diffs, merge conflicts and onboarding are significantly harder, and bugs like K8S-1 hide easily.
- **Recommendation:**
  - Adopt Prettier with a print width of 100–120 and ESLint (`typescript-eslint`, `react-hooks`). Do it in one mechanical commit.
  - Extract a view router component and sub-components for the Details footer and tabs.

**CQ-2 — The Kubernetes object model is effectively untyped (Medium, Confirmed).**

- **Evidence:** `Resource` has `[key: string]: any` and `spec`/`status: Record<string, any>` (`shared/protocol.ts:11-15`). There are about 122 explicit `any` uses, concentrated in `deploy.ts` (15), `node-pricing.ts` (11) and `Details.tsx` (8).
- **Recommendation:** use the generated model types from `@kubernetes/client-node` (`V1Pod`, `V1Deployment` and so on) in pure logic. Narrow with type guards.

**CQ-3 — Logic is duplicated across modules (Medium, Confirmed).**

| Duplicated logic | Where |
|---|---|
| Fetching a Helm `index.yaml` with a size cap | `helm.ts:69-83`, `monitoring.ts:26-53`, `deploy.ts:85-99` |
| Prometheus endpoint discovery and caching | `providers.ts`, `overview-metrics.ts:49-53`, `resource-metrics.ts:58-61`, `cost-report.ts:96`, `cost-estimate.ts:191` |
| Isolating Helm configuration | Temporary `repositories.yaml` in `helm.ts:115-117` and `monitoring.ts:71-73`, versus `HELM_*` environment variables in `deploy.ts:63-66` |
| Exporting files | Blob download in the renderer (`Table.tsx:64`, `HelmPage.tsx:67-72`) versus the main-process save dialog (`cost-export.ts`, `log-export.ts`) |
| Escape and focus-trap handlers | About 10 dialogs |

**Recommendation:** extract shared helpers such as `fetchBounded`, `PrometheusLocator`, `HelmRunner`, `saveFile` and `<Modal>`.

**CQ-4 — Legacy naming is left over from the "cluster workbench" product (Low, Confirmed).**

- **Evidence:**
  - `appId: org.clusterworkbench.desktop` (`package.json:57`)
  - `fieldManager: 'cluster-workbench'` (`resources.ts:143`)
  - `WORKBENCH_KUBECONFIG` (`clusters.ts:57`)
  - `.workbench-<uuid>.bak` (`clusters.ts:116`)
  - `workbench-smoke-` in the tests
- **Recommendation:** decide on the final IDs **before GA**. Changing `appId` after release breaks Windows upgrades and uninstall entries.

**CQ-5 — Circular module dependency (Low, Confirmed).**

- **Evidence:** `providers.ts:1` imports `CostReports` from `cost-report.ts`, and `cost-report.ts:4` imports `Providers` from `providers.ts`. `cost-estimate.ts` also imports `providers`.
- **Problem:** it works only because the classes are used lazily.
- **Recommendation:** move `Providers.cost()` into `cost-report.ts`, or into the IPC layer.

**CQ-6 — Unreachable code (Low, Confirmed).**

- **Evidence:**
  - Extension archive install exists in `extensions.ts:19-39` (`readExtensionArchive`) and the `extensions:pick {kind:'archive'}` branch, but the UI only ever sends `kind: 'folder'` (`ExtensionsPage.tsx:19,24`).
  - `deploy.ts:135,164` re-import `dirname` dynamically inside loops even though it is already imported at the top of the file.
- **Recommendation:** expose the archive install in the UI or remove it, and remove the redundant dynamic imports.

**CQ-7 — The IPC channel list is built with scattered `push` calls (Low, Confirmed).**

- **File:** `shared/protocol.ts:118-132`.
- **Problem:** a channel added to `Requests` but missing from `channels` would have a schema and a handler but never be registered. The compiler cannot catch this.
- **Recommendation:** derive the list with `Object.keys(schemas)` in main, or use one `as const satisfies` tuple.

**CQ-8 — Errors are swallowed silently (Low, Confirmed).**

- **Evidence:** `catch {}` in `clusters.ts:20`, `cluster-settings.ts:25`, `helm.ts:50`, `extensions.ts:49` and `deploy.ts:52`, along with best-effort deletes.
- **Problem:** combined with ELEC-2, corrupt settings silently reset to defaults.
- **Recommendation:** log a redacted warning and show a one-time notice.

**CQ-9 — No unused dependencies were found.** Every production dependency is imported.

---

## 11. Build and deployment findings

**BLD-1 — The uncommitted Electron version range breaks the exact-pin policy (Low, Confirmed).**

- **Evidence:** in the working tree `"electron": "^45.2.1"`, while every other dependency is pinned exactly.
- **Recommendation:** pin `45.2.1` exactly, or adopt ranges deliberately everywhere. Commit the change or revert it.

**BLD-2 — Pull requests are validated on Windows only (Medium, Confirmed).**

- **File:** `.github/workflows/validate.yml`.
- **Problem:** Linux and macOS packaging and smoke tests run only on release tags or branches (`release.yml:59-86`). `npm audit` also runs only on release.
- **Recommendation:** add Linux to the pull-request workflow (cheap with `xvfb`), and run the audit on every pull request.

**BLD-3 — Native module packaging relies on prebuilt binaries (Low, Potential).**

- **Evidence:** `npmRebuild: false` with `node-pty` (`package.json:59-63`).
- **Problem:** it works while the prebuilt binaries match Electron and the target architecture. Only `mac-arm64` is smoke-tested on macOS, and there is no Windows ARM64 or Linux ARM64 coverage.
- **Recommendation:** add architecture coverage, or rebuild with `@electron/rebuild` on CI.

**BLD-4 — One `tsconfig` covers main, preload and renderer (Low, Confirmed).**

- **Evidence:** the single config includes `lib: [DOM]` and `types: [node]` for every target.
- **Problem:** renderer code type-checks against Node APIs, and main type-checks against the DOM.
- **Recommendation:** use project references (`tsconfig.node.json` and `tsconfig.web.json`), as electron-vite templates do.

**BLD-5 — There is no lint or format gate (Medium, Confirmed).** See CQ-1.

**BLD-6 — The release pipeline builds twice (Low, Confirmed).**

- **Problem:** `test:smoke` runs `npm run build`, and then `package` or `electron-builder` builds again.
- **Recommendation:** build once and reuse `out/`.

**BLD-7 — No signing, notarization or auto-update (Medium, Confirmed, documented).** See SEC-8.

**Good practices worth keeping:**

- A third-party license notice generator that fails the build when a license is missing (`scripts/licenses.mjs`).
- The tag must match `package.json`.
- SHA256SUMS are published.
- The packaged executable is smoke-tested.
- The `node-pty` spawn-helper permissions are fixed on macOS.

---

## 12. Testing findings

**Coverage today:**

- **Unit tests:** 39 files and 188 tests, all passing. They cover validation schemas, error mapping, the cost math, security parsing, the Helm and deploy helpers, log-stream de-duplication, relationships, editors and the terminal profiles.
- **End-to-end:** 10 Playwright `_electron` smoke suites against a fake Kubernetes HTTP server. They cover navigation, actions, streams, the Overview history, cost, security, import and deploy, extensions, external tools and EKS. CI also runs the smoke test against the packaged app.

**Gaps:**

| ID | Missing scenario | Why it matters |
|---|---|---|
| TEST-1 | Every `target` channel with names containing `:` and other legal characters | Would have caught K8S-1 |
| TEST-2 | Watch lifecycle: inactivity, server timeout, `410 Gone`, bookmarks, backoff reset | K8S-2 is invisible because the fake server keeps watches open silently and the tests are short |
| TEST-3 | Error-body propagation (400, 403 and 409 `Status`), including log-start failures | K8S-3, K8S-4 |
| TEST-4 | Real-cluster integration in CI (kind or k3d): auth, exec, port-forward, drain, Helm install and rollback, server-side-apply conflicts | Today every Kubernetes interaction is fixture-based |
| TEST-5 | Large-scale fixtures (10k or more pods, chatty logs) with timing budgets | PERF-1, PERF-7 |
| TEST-6 | Renderer component tests: only 2 `.tsx` tests. Missing: dirty-state, Escape, focus trap, dialogs | FE-1, FE-4 |
| TEST-7 | `KUBECONFIG` merge, split user and cluster files, exec plugins, proxy override | K8S-6, SEC-5 |
| TEST-8 | Crash and kill recovery: temporary kubeconfig cleanup, deploy journal "interrupted" state, node-shell pod cleanup | SEC-3 |
| TEST-9 | No coverage reporting is configured. `coverage/` is in `.gitignore`, but there is no coverage script. | Gaps cannot be measured |

---

## 13. Confirmed bugs (index)

| ID | Severity | Summary | Location |
|---|---|---|---|
| K8S-1 | High | RBAC and other names containing `:` fail on YAML, save, delete, restart and scale | `src/main/validation.ts:13,17` |
| K8S-2 | High | Quiet watches time out after 30 s: false error, re-list loop, up to 30 s without a watch | `src/main/resources.ts:74-104` |
| K8S-3 | Medium | Kubernetes `Status` bodies discarded; log, admission and RBAC errors are misleading | `src/main/kube-http.ts:9`, `sessions.ts:58`, `errors.ts:14-21` |
| K8S-4 | Medium | Server-side-apply conflicts reported as "resource changed"; multi-document YAML reported as a connectivity failure | `src/main/resources.ts:131-145` |
| K8S-5 | Medium | Two field managers own the same objects and conflict | `resources.ts:143`, `deploy.ts:224` |
| K8S-6 | Medium | Split `KUBECONFIG` files are not merged | `src/main/clusters.ts:57-72` |
| K8S-7 | Medium | Remote chart import fails on redirected artifacts (GitHub-hosted repositories) | `src/main/deploy.ts:87` |
| FE-1 | Medium | Escape discards unsaved YAML edits | `App.tsx:59`, `Details.tsx:51` |
| PERF-2 | Medium | Every resource action clears and re-lists all watches | `hooks.ts:39` |
| PERF-4 | Medium | Cluster-wide Service list on every metrics poll | `providers.ts:13-19`, `resources.ts:150` |
| PERF-5 | Medium | Monitoring catalog YAML parsed on the main thread | `monitoring.ts:44` |
| FE-2 | Low | `?` mojibake in Helm and Cost UI strings | `HelmPage.tsx:56`, `CostDashboard.tsx:59,71` |
| FE-3 | Low | Helm releases namespace filter dropped on reload | `HelmPage.tsx:28` |
| FE-6 | Low | Palette advertises resource search that does not exist | `App.tsx:69,83` |
| ELEC-3 | Low | Second instance does not restore a minimized window | `index.ts:39` |
| CQ-5 | Low | Circular import between `providers` and `cost-report` | `providers.ts:1`, `cost-report.ts:4` |
| CQ-6 | Low | Extension archive install unreachable; redundant dynamic imports | `extensions.ts:19`, `deploy.ts:135,164` |
| BLD-1 | Low | Uncommitted Electron `^` range | `package.json:48` |

## 14. Potential risks (need runtime validation)

| ID | Severity | Risk |
|---|---|---|
| PERF-1 | High (large clusters) | Full-snapshot IPC per watch change |
| ELEC-1 / SEC-1 | Medium | A renderer compromise becomes local command execution through external tools or terminals |
| SEC-3 | Medium | Leftover temporary kubeconfigs with credentials after a crash |
| SEC-5 | Medium | Pasted kubeconfig exec plugins run without showing the command |
| PERF-7 | Medium | Logs rendering cost with chatty pods |
| PERF-11 | Medium | The Applications page's 8 cluster-wide watches |
| ELEC-4 | Low | Terminal exit code lost when the worker exits |
| ELEC-5 | Low | IPC listener fan-out and `MaxListenersExceededWarning` |
| ELEC-6 | Low | 24-stream cap reachable with multi-pod logs |
| PERF-10 | Low | Quadratic security report to pod matching |
| BLD-3 | Low | Native prebuilt-binary coverage across architectures |
| — | Low | The default Bitnami repository may serve charts whose images are no longer published. The UI already warns about one such chart (`HelmPage.tsx:81`). |

## 15. Missing features

| ID | Feature |
|---|---|
| MISS-1 | Secret management: view, reveal on demand, and edit values with an explicit opt-in. Secrets are metadata-only today. |
| MISS-2 | Permission-aware UI using `SelfSubjectAccessReview` and `SelfSubjectRulesReview`, so actions the user cannot perform are hidden or disabled |
| MISS-3 | Label and field selectors in `Scope` (server-side filtering), plus table label filters |
| MISS-4 | A shared, reference-counted watch cache; delta updates over IPC |
| MISS-5 | CRD `additionalPrinterColumns` in custom resource tables; a CRD resource tree in the Navigator |
| MISS-6 | Form editors for Ingress, HPA, NetworkPolicy and PVC resize |
| MISS-7 | Native exec and port-forward over WebSocket or SPDY through client-node, removing the `kubectl` dependency for core features |
| MISS-8 | Port-forward auto-reconnect and pod re-selection for Services |
| MISS-9 | A "describe"-style aggregated view (events with conditions), and `--all-containers` or `since`-duration log options |
| MISS-10 | Auto-update, code signing, crash reporting and a diagnostics bundle |
| MISS-11 | Restore workspace tabs and Dock sessions on restart |
| MISS-12 | Kubeconfig credentials encrypted at rest (`safeStorage`) |
| MISS-13 | Multi-document apply in "Create resource" |

## 16. Production readiness assessment

| Dimension | Rating | Notes |
|---|---|---|
| Electron security posture | **Strong** | Best-practice configuration and IPC validation |
| Functional breadth | **Strong** | Broader than most open-source alternatives |
| Kubernetes correctness | **Fair** | K8S-1 and K8S-2 hit everyday use; errors are opaque |
| Performance and scalability | **Fair to weak** | Acceptable for small and medium clusters; not validated for large ones |
| Reliability and diagnostics | **Weak** | No logs, crash handling or per-view isolation |
| Maintainability | **Weak** | Density, untyped model, duplication, no lint |
| Testing | **Fair** | Good fixture-based end-to-end tests and unit math; no live-cluster or scale tests |
| Release engineering | **Fair** | Reproducible and checksummed, but unsigned with no updater |

**Verdict:** it is fit for its stated purpose as a **public beta**. Before a GA release, it needs:

1. All P0 items below fixed.
2. Code signing and auto-update.
3. A logging and diagnostics layer.
4. A live-cluster CI job.
5. A scale pass on a 5k or more pod cluster.

## 17. Prioritized improvement roadmap

**P0: correctness fixes, small and high-value. Proposed first.**

1. Use one permissive `resourceName` schema for every target, with tests (K8S-1, TEST-1).
2. Rework watch resilience (K8S-2, TEST-2):
   - Raise `requestTimeoutMs` above the server timeout.
   - Resume from the last seen or bookmark `resourceVersion`.
   - Re-list only on 410.
   - Reset backoff on connect.
   - Debounce error display.
3. Forward truncated Kubernetes `Status` messages through `fault()`, for both `kubeJson` and log start (K8S-3, TEST-3).
4. Use one SSA field manager. Report apply conflicts properly with a "force" option. Detect multi-document YAML (K8S-4, K8S-5).
5. Make Escape aware of focus and add a dirty guard to the Details YAML editor (FE-1).
6. Fix the mojibake strings and add an `.editorconfig` (FE-2).
7. Remove `actionRevision` from the `useResources` dependencies (PERF-2).

**P1: scale, safety and reliability.**

1. Add label and field selectors (MISS-3), then use them for Details events, drain preview and Applications (PERF-6, K8S-8, PERF-11).
2. Use delta IPC for watches and a shared subscription cache (PERF-1, FE-5, MISS-4).
3. Use selector-based store subscriptions and memoized table rows (PERF-3).
4. Virtualize the logs view with a ring buffer (PERF-7).
5. Share a Prometheus discovery cache. Move the monitoring catalog parse to the worker (PERF-4, PERF-5).
6. Store temporary kubeconfigs under `userData`, sweep them at startup, and keep `.bak` files under retention (SEC-3, SEC-4). Optionally encrypt kubeconfigs with `safeStorage` (SEC-2).
7. Review exec plugins when importing a kubeconfig (SEC-5).
8. Merge `KUBECONFIG` files with kubectl semantics (K8S-6).
9. Follow redirects safely for remote chart downloads (K8S-7).
10. Add per-page and per-pane error boundaries, a structured redacted logger, crash handlers and "Copy diagnostics" (FE-4, ELEC-2).

**P2: maintainability and release.**

1. Add Prettier and ESLint in one mechanical commit, then split the large JSX lines into components (CQ-1).
2. Introduce Kubernetes model types. Extract `fetchBounded`, `PrometheusLocator`, `HelmRunner`, `<Modal>` and `saveFile` (CQ-2, CQ-3).
3. Break the circular import. Derive `channels` from the schemas. Remove dead paths (CQ-5, CQ-6, CQ-7).
4. Split the `tsconfig` files. Pin the Electron version exactly. Pin CI actions to SHAs. Run Linux in pull-request CI. Build once per pipeline (BLD-1 to BLD-6, SEC-7).
5. Add a kind or k3d integration job, scale fixtures and coverage reporting (TEST-4, TEST-5, TEST-9).
6. Decide the final `appId` and naming before GA. Add Authenticode signing, notarization and `electron-updater` (CQ-4, SEC-8).
7. Add features in this order: permission-aware UI (MISS-2), Secret management (MISS-1), CRD printer columns (MISS-5), native exec and port-forward (MISS-7), session restore (MISS-11).

*Nothing has been changed in the repository. Each P0 item is self-contained and can be implemented and reviewed on its own once approved.*
