# Troubleshooting

| Symptom | What to check |
|---|---|
| SmartScreen blocks the installer | Expected for this unsigned beta. Verify the SHA-256 checksum, then **More info → Run anyway**. Don't disable SmartScreen. |
| No clusters listed | Is `KUBECONFIG` set? Optic then reads only those files, like kubectl. Run `kubectl config get-contexts` to compare. Use **Reload kubeconfig** after edits. |
| "Invalid cluster in context …" | The context's cluster is missing or has no `https://` server. Check `kubectl config view`. |
| "references a missing user" | The context's user isn't defined in any `KUBECONFIG` file; Optic connects without credentials. |
| `FORBIDDEN: Kubernetes API: … is forbidden` | Your Kubernetes identity lacks that permission. Optic cannot bypass RBAC. |
| `TIMEOUT` / `UNREACHABLE` | VPN, proxy or DNS problem. Check **Cluster settings → Proxy** and the server address. |
| Exec credential errors (`aws`, `kubelogin`, `gke-gcloud-auth-plugin`) | The command must be on `PATH` and signed in. Test it with `kubectl get ns`. |
| Pod shell or port forward fails | Install `kubectl` and make sure it's on `PATH`. |
| Helm pages fail | Install `helm` (3.x) and make sure it's on `PATH`. |
| Apply says "Another field manager owns these fields" | Another tool owns those fields. Enable **Override field conflicts** only if Optic should take ownership. |
| Argo CD or Flux page says not installed | The cluster doesn't serve the `argoproj.io` or `*.toolkit.fluxcd.io` APIs. After installing, choose **Refresh**. |
| AI client can't connect to Optic | Use the exact command shown on the **AI Access** page. "Optic MCP server ready" on stderr means it started. `NOT_APPROVED` means the cluster isn't approved yet. |
| Leftover temporary files after a crash | Optic removes them at its next start (only ones that can't be in use). |

## Reporting a bug
Open a GitHub issue with:
- the Optic version (shown in the Navigator footer);
- your Windows version;
- the steps to reproduce.

**Never attach kubeconfigs, tokens, certificates or unredacted logs.** Report security problems privately (see SECURITY.md).
