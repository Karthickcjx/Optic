# Optic vs. Lens premium: gap analysis and roadmap

Date: 2026-11-02. Branch: `fix/p0-audit` (P0 audit items 1–7 done and pushed).

**Baseline:**
- Current: `tsc` passes, 225 unit tests in 45 files, and all 15 Electron smoke suites pass.
- The prompt's 188/39 baseline is out of date; the count has only grown since.

**Lens sources.** Lens documentation pages, read 2026-11-02:
- premium-features, pricing, lens-studio, extensions, ask-ai, mcp-server, security-center, lens-teamwork, cost-monitoring.
- The Flux, Argo CD, AKS/GKE connector, SSO/SCIM and air-gapped sub-pages were not read. Rows that depend on them say so.

**What was inspected in Optic.** Each status below comes from the implementation, not the UI:
- main: `src/main/*`, `ipc/index.ts`
- renderer: `src/renderer/src/*`
- shared: `src/shared/*`
- the earlier audit report

## 1. Comparison matrix

Legend: **Done** = already implemented · **Partial** = partially implemented · **Missing** · **Improve** = implemented but needs improvement · **N/A-infra** = needs external infrastructure.

| Feature | Lens capability (per docs) | Optic status (verified in code) | Required work | Priority |
|---|---|---|---|---|
| A. Ask AI | Launches your AI CLI in a terminal "with your cluster context attached"; summarizes logs, metrics, events and related resources | **Partial.** External Tools page detects and launches Claude Code, Codex, Copilot, OpenCode or a custom CLI in a PTY (`external-tools.ts`), but with **no cluster context**: the launch passes no `clusterId` | Launch from a cluster or resource with an isolated kubeconfig lease and a context brief (selected object, recent events, log tail), behind an explicit consent notice | P1 |
| A. Built-in LLM analysis (explain CrashLoopBackOff, generate YAML) | Done by delegating to the user's AI tool, not by a built-in model | **Missing** | Do not embed an LLM or API keys. Feed the user's own tool through MCP (next row) and the context hand-off | P1 (via MCP) |
| B. MCP server | Read-only; kubectl get/describe/logs/top plus PromQL; needs the app running | **Missing.** Nothing references MCP | Read-only stdio MCP server reusing `ResourceService` and `SessionService`, with Secret redaction, a per-cluster opt-in and an audit log | P1 |
| C. GitOps: Argo CD | Track sync and health across Applications, sync/refresh, open the Argo UI | **Missing.** Only a Helm chart warning mentions Argo | Watch `applications.argoproj.io`: sync, health, out-of-sync resources, history. Refresh/sync as confirmed annotation or operation patches, later | P1 (read) / P2 (sync) |
| C. GitOps: Flux | Reconciliation health, drift, failures, recent activity | **Missing** | Watch Kustomization, HelmRelease and the Source kinds (`Ready` conditions, `lastAppliedRevision`, suspend). Reconcile via the `reconcile.fluxcd.io/requestedAt` annotation, confirmed | P1 (read) / P2 (reconcile) |
| D. Security Center | Trivy Operator; Images / Resources / Roles; CSV export; air-gapped DB import | **Done** (Images, Resources and Roles views, severities, secret redaction, install instructions). **Improve:** no CSV export, no remediation guidance beyond the reports, and no Helm one-click install from the Security view | CSV export; link remediation fields already present in reports; optional guided install through the existing Helm flow | P2 |
| E. AWS EKS | Discover and connect across accounts | **Done** (`eks.ts`, `EksDialog.tsx`: profiles, regions, pagination, kubeconfig generation) | — | — |
| E. Azure AKS | Discover across subscriptions | **Missing** | `az aks list` / `az account list` through the existing CLI-runner pattern; `kubelogin` exec credentials; no stored secrets | P2 |
| E. Google GKE | Discover across projects | **Missing** | `gcloud container clusters list`; `gke-gcloud-auth-plugin` exec credentials | P2 |
| F. Cost | 24h/7d/30d by namespace; OpenCost/Kubecost or metric estimate; idle; "Optimize with AI" | **Done** for overview, namespace/node/workload breakdown, idle cost, efficiency, ranges, export, Prometheus estimates. **Missing:** request-vs-usage right-sizing recommendations | Recommendations from existing request and usage data (rule-based and explainable, no AI); optional hand-off to the AI tool | P2 |
| G. Advanced resource editor | Compare unsaved edits with the loaded version; one-click revert | **Improve.** The YAML tab is a textarea with an unsaved-changes guard (P0 #5). Form editors already dry-run. The YAML tab has **no diff, no revert and no dry-run**; save errors already show Kubernetes `Status` messages (P0 #3) | Line diff of loaded vs. edited YAML, Revert, server dry-run validation before Save | **P1, first** |
| G. Syntax highlighting / schema awareness | Not stated in the Lens docs | **Missing** | Needs an editor component (CodeMirror 6 or Monaco, a new dependency) plus the OpenAPI v3 schema from `/openapi/v3`. Evaluate separately | P2 |
| G. Multi-document apply | — | **Done** in Import and Deploy. Create resource rejects multi-doc YAML with guidance (P0 #4) | — | — |
| H. Studio: split view / tab groups | Split main view, drag dock tabs beside lists, separate windows | **Partial.** Workspace tabs, a dock with multiple terminal/log/forward tabs, a resizable navigator, persistent sessions across view changes. **No split, no groups, no pop-out windows; layout not persisted** | Two-pane split of workspace tabs, persisted layout, then "open in window" via a second `BrowserWindow` sharing main-process sessions | P2 |
| I. Hotbar | Quick-access bar for clusters | **Partial.** Pin clusters to the activity rail (`ClusterMenu` "Add to Hotbar") with a label and color | Favorite namespaces/workloads, Ctrl+1..9, palette integration (the palette also needs real resource search, audit FE-6) | P2 |
| J. Extensions | npm packages, sandbox, marketplace, enterprise governance | **Done** with a stricter model: an isolated session partition, a permission list (`context.read`), deadlines, Safe Mode, folder/bundle install (`extensions.ts`, `EXTENSIONS.md`) | More capabilities (panels, settings) are added only with explicit permissions. No marketplace without a signing story | P3 |
| K. Teamwork | Team spaces, invitations, roles, remote access via Lens Cloud | **Missing** | Requires a backend (identity, catalog storage, relay). The locally viable part is shareable cluster catalogs as signed files without credentials | P3 / N/A-infra |
| L. SSO / SAML / OIDC / SCIM | Enterprise account features | **N/A-infra.** Optic has no accounts | Do not fake it. Cluster-level OIDC already works through kubeconfig exec plugins | N/A |
| L. Offline / air-gapped | Offline activation, air-gapped mode | **Mostly Done** by design: no license server or telemetry; works offline except Helm/remote fetches | Document an air-gapped operation checklist; Trivy offline DB is an operator concern | P3 (docs) |
| L. Audit logs | Enterprise audit logs | **Partial.** The deploy journal records Import and Deploy operations only | Local, append-only, credential-free audit log of mutations made from Optic (and MCP calls later) | P2 |

### Notes on the missing capabilities

**MCP server (B)**
- **What it adds:** a programmatic, read-only way for the user's AI client to see the same clusters Optic sees.
- **Approach:**
  - `optic --mcp` starts a stdio MCP server in a utility process. It authenticates to the running app over a per-user named pipe or Unix socket protected by a random token stored with 0600 permissions.
  - Alternatively, it loads kubeconfigs directly in read-only mode.
  - Tools: `list_clusters`, `list_namespaces`, `list_resources`, `get_resource` (Secrets redacted), `get_events`, `get_logs` (bounded), `top`.
- **Dependencies:** `@modelcontextprotocol/sdk`, a new dependency that needs a dependency audit.
- **Security:**
  - Read-only by construction: no write tools are registered at all.
  - Per-cluster opt-in.
  - Secret `data`/`stringData` stripped.
  - Log size caps.
  - An audit entry per call.
  - The app's RBAC identity is never widened.
- **Tests:** an MCP client round-trip in vitest; a check that Secrets never appear; a check that a disabled cluster is invisible.
- **Complexity:** M–L.

**GitOps (C)**
- **What it adds:** most clusters with Argo or Flux are managed through them, and their health is otherwise invisible in Optic.
- **Approach:** a new navigator group, visible only when the CRDs are discovered.
  - **List views** reuse the existing watch and cache.
  - **Detail drawers** show conditions, out-of-sync resources (`status.resources`) and history (`status.history`).
  - **Actions (P2)** are confirmed patches only.
- **Dependencies:** none.
- **Security:** reads follow cluster RBAC. Sync, refresh and reconcile mutate the cluster and must be confirmed.
- **Tests:** fixture CRDs in unit tests, plus a smoke test with a fake API server. Live testing needs Argo or Flux installed.
- **Complexity:** M.

**AKS/GKE (E)**
- **Approach:** mirror the EKS pattern (CLI discovery, then generated kubeconfig using exec credential plugins).
- **Dependencies:** the user's `az`/`gcloud` and auth plugins.
- **Security:** Optic never stores cloud credentials.
- **Tests:** CLI fixtures, the same as `eks.test.ts`.
- **Complexity:** M each.

**Editor diff/revert/validate (G)**
- **Approach:** a pure line-diff module in `src/shared` with no new dependency; a "Changes" view and a Revert action in the Details YAML tab; Validate = PUT with `dryRun=All` through a new IPC flag on `resources:replace`.
- **Security:** dry-run is non-mutating. Save stays confirmed and keeps its UID/resourceVersion preconditions.
- **Complexity:** S–M.

**Not recommended**
- **A built-in LLM with API keys stored in Optic.** It duplicates the user's AI tool, adds key storage and data egress, and Lens does not do it either.
- **Fake SSO, SCIM or licensing.**

## 2. Architecture for new features (summary)

```
renderer (React, zustand)            preload (contextBridge: request/subscribe only)       main (Node)
 ├─ Details YAML tab ──request──────► resources:replace {dryRun?} ─────────────────────► ResourceService.replace → kubeJson PUT ?dryRun=All
 │    └─ shared/yaml-diff (pure)                                                          errors → fault() (Kubernetes Status message)
 ├─ GitOps views ── useResources (watch) ──────────────────────────────────────────────► existing watch/cache (custom catalog entries)
 └─ AI hand-off ── terminal:open {externalTool, clusterId} ────────────────────────────► SessionService.terminal (kubeconfig lease)
MCP client (Claude Code) ⇄ stdio ⇄ optic --mcp (utility process) ⇄ token-authenticated local pipe ⇄ main read-only facade
```

**Rules for every feature:**
- Zod validation at the IPC boundary.
- No credentials in the renderer.
- Mutations confirmed.
- Watches cleaned up on unmount.
- No new dependency without justification.

## 3. Roadmap

**P0 – reliability (remaining audit items).** Audit IDs are from the previous audit report.
- **K8S-6:** merge `KUBECONFIG` files.
- **SEC-3/SEC-4:** remove leftover temporary kubeconfigs and `.bak` files that contain credentials (startup sweep).
- **PERF-3:** store selectors.
- **FE-6:** palette resource search.

**P1 – high-value capabilities, in order:**

1. **Resource editor: diff, revert and server-side validation.**
   - Files: `src/shared/yaml-diff.ts` (new), `Details.tsx`, `resources.ts` (`replace` with `dryRun`), `validation.ts`, `protocol.ts`, `ipc/index.ts`, `styles.css`.
   - Tests: diff unit tests, replace dry-run unit tests, smoke steps.
   - Done when: changes are visible, revert restores the loaded version, Validate reports server errors without mutating, and all suites pass.
2. **Read-only MCP server.** Design decision needed first: standalone (reads kubeconfigs itself) or attached to the running app.
3. **GitOps status views for Argo CD and Flux, read-only.**
4. **AI tool hand-off with cluster and resource context**, after consent.

**P2 – productivity:**
- AKS and GKE discovery.
- Split workspace and persisted layout.
- Hotbar favorites and shortcuts.
- Cost right-sizing recommendations.
- Security CSV export.
- Local audit log.
- GitOps sync and reconcile (confirmed).
- Syntax highlighting and schema awareness, after evaluating editor dependencies.

**P3 – enterprise and collaboration:**
- Shareable credential-free cluster catalogs.
- Air-gapped documentation.
- An extension capabilities expansion.
- Teamwork, SSO and SCIM only with a real backend, which is out of scope for a local app.
