# Import and Deploy implementation plan

Status: initial implementation on `feat/import-deploy`; fixture validation completed, live cluster/registry acceptance outstanding.
Baseline: `31e6743` on `feat/security-scanning`.
Suggested implementation branch: `feat/import-deploy`.

## Implementation status (2026-10-28)

Implemented: multi-file and pasted YAML/JSON batches, Kubernetes Lists, explicit folder file selection, duplicate detection, discovery-based namespace scope, server dry-run, Namespace/CRD prerequisite sequencing, immutable expiring reviews, per-resource outcomes, stop between manifest resources, background notifications and restart reconciliation notices.

Local chart directories and `.tgz` archives support install/upgrade, ordered values-file imports, final editor overrides and isolated dependency builds for public HTTPS dependencies. Chart rendering is labeled separately from server validation. Chart bytes and values are frozen for apply. Archive links, traversal, duplicate paths and excessive expansion are rejected.

Kustomize supports local trees with in-tree bases and installed `kubectl`; remote bases, executable plugins, external generators/transformers and Helm inflation are blocked. HTTPS archives, explicit HTTPS repository chart/version downloads and OCI references support session-only credentials and custom CA certificates. Credentials are discarded after downloads; no plaintext credential persistence is added.

Entry points: Applications, resource-create dialog, command search and Helm Charts. Operations continue when the dialog closes; Optic itself must remain open.

Remaining enhancements: drag/drop, saved source identity for one-click local-chart upgrades, encrypted persistent credential profiles, richer live-resource diffs, and registry catalog browsing. Private/local dependency builds require vendoring before import. No automatic rollback or crash-safe resumption is claimed. Live disposable-cluster checks (new CRD + instance, Helm hooks, authenticated registries and custom CA servers) remain necessary before declaring production acceptance.

## Objective

Let engineers deploy their own Kubernetes YAML/JSON, Kustomize overlays, local Helm chart directories or archives, and private/OCI charts through a consistent source → target → review → apply → results workflow.

## Existing foundations

- `ManifestDialog.tsx` edits and validates one resource. `ResourceManager.apply` discovers the API and uses server-side apply with server dry-run; batches are not supported.
- `HelmPage.tsx` and `main/helm.ts` support repository charts, values editing, preview tokens, install/upgrade and background notifications.
- Main-process IPC validation, isolated CLI kubeconfigs, resource discovery, Secret redaction and operation notifications can be reused.
- Rendering a Helm chart is not the same as server validation. The UI must distinguish these outcomes.

## User experience

- Add **Import and deploy** to Applications, the resource-create menu and command search. Add **Install local chart** in Helm Charts.
- Source choices: manifest files, manifest folder, Kustomize directory/overlay, chart directory, `.tgz` chart, configured repository or OCI reference. Keep paste-YAML available.
- File selectors support multiple manifests. Drag/drop is a convenience for the same import path, not a separate deployment implementation.
- Show selected files, source errors and resource counts. Folder imports show candidates and require explicit selection; never apply every YAML file blindly.
- Capture the target cluster when the workflow opens. Show context and namespace throughout; never switch the target silently when another tab becomes active.
- Default missing resource namespaces to the selected namespace. Preserve explicit namespaces, display mixed-namespace deployments, and exclude namespace fields from cluster-scoped resources. Any override must be explicit.
- Review table: source/document, kind, name, namespace, create/update intent, validation state and redacted changes. Show unknown/unreadable live state honestly.
- For Helm: release name, install/upgrade, chart identity/version, ordered values files, final editor overrides, namespace and hook/CRD information.
- After Apply, close the editor and show a persistent operation notification with resource-level progress, errors and a results link. Closing a workspace tab does not cancel the operation.

## Architecture

- Introduce typed source, prepared-plan, validation and operation-result contracts in `src/shared/deploy.ts`.
- `src/main/imports.ts` owns native file dialogs, bounded reads, source inspection and private staging directories. Return opaque source IDs to the renderer; do not add an unrestricted filesystem IPC endpoint.
- `src/main/deploy.ts` parses batches, resolves API scope, prepares the review, validates plans and applies resources with per-resource outcomes.
- Extend Helm sources as a discriminated union: repository, local directory, local archive and OCI reference. Local sources derive version from `Chart.yaml`; do not require a repository lookup.
- Add `ImportDeployDialog.tsx`, reusable source/target/review panels and an operation-results view. Reuse existing notification infrastructure.
- Proposed IPC: `imports:pick`, `imports:inspect`, `imports:dispose`, `deploy:prepare`, `deploy:validate`, `deploy:start`, `deploy:status`; exact contracts finalized with implementation.
- Snapshot source bytes and merged configuration before review. Bind short-lived plan IDs to source digest, cluster, namespaces, options and validation outcome. Edits or changed sources invalidate approval.

## Delivery stages

### 1. Local manifest files and batch apply

- Import `.yaml`, `.yml` and `.json`; parse multi-document YAML and Kubernetes List objects. Ignore empty documents; identify malformed documents precisely.
- Detect duplicate resource identities and ambiguous namespace handling before validation. Reject unnamed/generateName-only objects in the initial server-side-apply workflow.
- Validate documents against the selected cluster. Do not force ownership conflicts by default.
- Apply sequentially in dependency stages: Namespaces, CRDs, then remaining resources. Arbitrary application readiness dependencies are not inferred.
- Namespace creation and CRD creation prevent complete preflight validation of dependants on some clusters. Mark dependants as awaiting prerequisite validation, explain this before apply, then wait for Namespace activation/CRD establishment, refresh discovery and validate each dependent stage before applying it.
- Stop on the first apply failure; show succeeded, failed and skipped resources. Kubernetes batches are not transactional. Never delete successful resources as an automatic rollback.
- Retry prepares a new plan against current state; it must not blindly replay an old operation.

### 2. Local Helm charts and values files

- Import a directory containing `Chart.yaml` or a packaged `.tgz` chart.
- Validate archive structure and reject path traversal, escaping links, excessive expansion and invalid chart metadata. Never execute import-time scripts or Helm plugins.
- Inspect vendored dependencies and `Chart.lock`. Offer an explicit dependency-build step when required; show network sources and stage changes outside the user's chart directory.
- Load multiple values files in the visible order, with later files overriding earlier files; editor overrides apply last. Use Helm's merge semantics rather than approximating them in the renderer.
- Review/render and install exactly the staged chart and values. Reuse Helm locking, preview expiry, isolated kubeconfigs and notifications.
- Preserve the source identity for subsequent upgrades. Do not infer a repository from a local release name.

### 3. Manifest folders and Kustomize

- Manifest folders provide an explicit file list, optional recursion and deterministic ordering; ignore VCS directories and do not follow paths outside the selection.
- Detect `kustomization.yaml`, `kustomization.yml` or `Kustomization`; choose an overlay and render through the installed supported tool.
- Keep plugins, executable generators and Helm inflation disabled initially. Start with local bases; remote bases require a later explicit fetch/review flow.
- Snapshot the selected tree, bound output/runtime and feed rendered documents into the same batch review pipeline.

### 4. Private repositories and OCI

- Add HTTPS repository authentication and OCI registry login, with clear repository/registry identity and an explicit sign-out action.
- Keep credentials in main, protected by OS-backed secure storage where available; refuse silent plaintext persistence and offer session-only credentials otherwise.
- Use an isolated Helm registry configuration and stdin where supported. Never expose credentials in process arguments, URLs, logs, previews or exported operation records.
- Resolve and pin the downloaded artifact for review/apply. Initial OCI support accepts explicit references; it does not promise universal registry catalog browsing.
- Add certificate/CA configuration without introducing a silent TLS-verification bypass.

## Cross-cutting requirements

- Apply bounded file counts, input size, YAML alias expansion, archive expansion, CLI output and timeouts. Initial budgets: 200 files, 500 resources and 20 MiB combined manifest input; chart/archive budgets are separate and validated before extraction.
- Preserve contextIsolation/nodeIntegration defaults; validate every new IPC payload and enforce existing trusted-window checks.
- Redact Secret data from previews and operation summaries. Values editors may intentionally contain credentials; exclude their contents from logs, telemetry, source history and error messages.
- Cancel before apply discards staged files. During apply, stop only between manifest resources and show completed changes. Helm process interruption can leave a pending release and must be reported accurately.
- Do not claim crash-safe continuation. Record minimal non-secret operation metadata and mark interrupted operations as requiring reconciliation after restart; durable Helm recovery remains a separate project.

## Acceptance and validation

- Unit tests: multi-document parsing, List expansion, duplicates, namespace scope, prerequisite stages, redaction, plan invalidation, values precedence, source limits and malicious archive paths.
- Electron tests: file import, malformed input, review edits, namespace selection, navigation while applying, progress notifications, partial failure/retry and scrolling at smaller window sizes.
- Helm subprocess tests: local folder/archive argument handling, ordered values files, dependency failures, authentication isolation and unchanged staged artifacts between review/apply.
- Integration tests on a disposable cluster: multi-resource app, new namespace, CRD plus instance, denied permissions, apply conflict, local-chart install/upgrade and Kustomize overlay. Use a test registry for authenticated repository/OCI cases.
- Keep live acceptance scoped to a dedicated test namespace and explicit test resources. Build/typecheck, unit tests and affected Electron suites must pass at each stage.

## Recommended first release

Ship stages 1 and 2 first: manifest files/batches, local chart folders/archives and values-file imports. Follow with Kustomize/folders, then private repositories/OCI. Do not bundle unrelated application or infrastructure changes into these commits.
