# Optic 0.9.0-beta.1

Public beta of Optic, a desktop workspace for Kubernetes. This release is for **Windows x64**.

> **Beta software.** Use Optic with clusters and credentials you are comfortable testing with. The installer is not code-signed yet, so Windows SmartScreen will show an "unknown publisher" warning. Verify the SHA-256 checksum before you install (see the [installation guide](https://github.com/Karthickcjx/Optic/blob/main/docs/INSTALLATION.md)).

## Highlights

**GitOps dashboards (read-only)**
- **Argo CD:**
  - Status counters for sync and health.
  - Needs Attention: what is out of sync, degraded, missing or failing, and why.
  - Recent Activity, built from Argo CD events and deployment history.
  - Applications with filters and six detail tabs; Application Sets; Projects with their permissions.
- **Flux:**
  - An overview with Needs Attention.
  - Kustomizations, Helm releases, and Git, Helm, OCI and Bucket sources, with their revisions, reconciliation times, conditions, applied resources and history.
- **Read-only:** Optic never syncs or reconciles. **Open Argo CD UI** appears when your cluster publishes Argo CD's address.

**AI clients (MCP server)**
- `Optic.exe --mcp` is a read-only Model Context Protocol server, so AI assistants such as Claude Code can inspect the clusters you approve.
- **Approval:** approve a cluster in **Cluster settings → AI Access**. The setting shows any credential command the server will run.
- **Data protection:** Secret values are never returned, and other values that look like credentials are masked.

**Editing and applying**
- **The YAML editor** shows a diff of your unsaved changes, can revert them, and validates them with the API server (a dry run) before you save.
- **Create resource** reports server-side apply conflicts clearly, and you can explicitly override them after confirming.
- **Multi-document and invalid YAML** get specific error messages.
- **Unsaved changes are protected.** Escape and closing no longer discard them.

**Kubernetes behavior**
- **Kubeconfig loading follows kubectl's rules.** `KUBECONFIG` files are merged in order, and relative certificate, key and token paths resolve against the file that declares them.
- **Clearer errors:** the explanation from the Kubernetes API server (RBAC, admission webhooks, waiting containers) is shown instead of a generic message.
- **Watches** stay connected on quiet clusters and resume without re-listing.
- **RBAC role names with colons** (`system:*`, `eks:*`) work.

**Usability and performance**
- **The command palette (Ctrl+K)** searches clusters, namespaces, pods, deployments, services, ConfigMaps, Secrets (by name), and Argo CD and Flux objects.
- **Fewer re-renders.** Toggling the dock no longer re-renders resource tables, and a single resource update re-renders one row instead of the whole table.
- **Navigator:** consistent text sizes, and collapsible section headings.

**Security hardening**
- **Temporary session kubeconfigs** are created in Optic's private profile folder, and leftovers from crashes are cleaned up safely at startup.
- **Context-removal backups** are stored in the profile folder, keeping the newest five per kubeconfig.

## Known limitations
See [Known limitations](https://github.com/Karthickcjx/Optic/blob/main/docs/KNOWN_LIMITATIONS.md). The main ones:
- The installer is unsigned.
- There are no automatic updates.
- Imported kubeconfigs are not encrypted by Optic.
- Kubeconfig exec plugins run without showing the command first.
- Only Windows x64 builds are published.

## Upgrading
Install over the previous version. Your settings and imported kubeconfigs are kept in `%APPDATA%\Optic`.

## Checksums
`SHA256SUMS.txt` is attached to the release. Verify the installer before you run it (see the [installation guide](https://github.com/Karthickcjx/Optic/blob/main/docs/INSTALLATION.md)).
