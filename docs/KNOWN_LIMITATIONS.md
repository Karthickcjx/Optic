# Known limitations (0.9.0-beta.1)

## Distribution
- **The installer is not code-signed.** SmartScreen warns about it, and organizational policies may block it. Verify the SHA-256 checksum.
- **There are no automatic updates.** Check the Releases page and install newer versions over the old one.
- **Only Windows x64 builds are published.** macOS and Linux builds are smoke-tested in CI but not released.

## Credentials and security
- **Imported kubeconfigs are not encrypted.** They are stored in `%APPDATA%\Optic\kubeconfigs`, protected only by your Windows account, the same way kubectl's `~/.kube/config` is.
- **Exec plugins run without being shown first.** A kubeconfig's authentication command (for example `aws eks get-token`) runs when you connect, and the import dialog shows only a general warning. The MCP server is different: it shows the command and binds its approval to it.
- **Values that aren't Secrets aren't fully hidden.** Environment variables and ConfigMap values are shown in YAML and in the "Additional API details" panel, as kubectl shows them. Only Secrets are fully hidden.
- **The MCP server runs Optic.exe in Node mode.** That's needed because Windows GUI programs can't read standard input directly, so Electron's "run as Node" capability stays enabled.

## Kubernetes features
- **GitOps is read-only.** Argo CD's desired-versus-live manifests, its child resource tree and, on Argo CD 3, per-resource health come from the Argo CD server and are not shown.
- **Watch updates send full lists.** Each watch update sends the complete list of that resource type to the UI. Very large namespaces (tens of thousands of objects) may feel slow; select a namespace.
- **Recent Activity is limited by event retention.** Kubernetes keeps events for about an hour by default; deployment history covers longer.
- **Palette search is namespace-scoped.** Workloads are searched in the current namespace; choose "All namespaces" to widen the search.

## Reliability
- **There is no crash reporter.** If the app misbehaves, restart it and report the steps (see Troubleshooting).
