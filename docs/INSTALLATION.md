# Installing Optic (Windows public beta)

## Requirements
- Windows 10 or 11, x64.
- Network access to the Kubernetes API servers you use.
- **Optional** command-line tools on `PATH`:

  | Tool | Needed for |
  |---|---|
  | `kubectl` | Pod shells, port forwarding, node drain, Kustomize imports |
  | `helm` | Helm installs and the monitoring stack |
  | Cloud CLIs (`aws`, `az`, `gcloud`, `kubelogin`) | Kubeconfigs that authenticate through them |

## 1. Download and verify
1. From the GitHub **Releases** page, download `Optic-0.9.0-beta.1-win-x64.exe` and `SHA256SUMS.txt`. Only download from this repository.
2. Compare the checksum in PowerShell:
   ```powershell
   (Get-FileHash .\Optic-0.9.0-beta.1-win-x64.exe -Algorithm SHA256).Hash.ToLower()
   Select-String Optic-0.9.0-beta.1-win-x64.exe .\SHA256SUMS.txt
   ```
   The two values must match. If they don't, do not run the installer.

## 2. Install
1. Run the installer. Because this beta is not code-signed, **SmartScreen** shows "Windows protected your PC". If the checksum matched, choose **More info → Run anyway**. Do not disable SmartScreen or your organization's controls; if policy blocks unsigned software, wait for a signed release.
2. Choose whether to install for yourself or all users, and choose the folder. The installer creates a desktop and Start-menu shortcut.

**Silent install (per-user):**
```powershell
.\Optic-0.9.0-beta.1-win-x64.exe /S /currentuser
```

## 3. First start
- **Clusters load automatically** from `~/.kube/config`, or from the `KUBECONFIG` files (merged as kubectl does).
- **To add more,** use **Add kubeconfig** (file or paste).
- **Before importing,** review any kubeconfig: authentication plugins (`exec`) run commands on your computer.

## Upgrading
Run the newer installer. Settings, imported kubeconfigs, MCP approvals and backups in `%APPDATA%\Optic` are kept.

## Uninstalling
Use **Settings → Apps → Optic → Uninstall**, or run `"<install folder>\Uninstall Optic.exe"`. Your profile in `%APPDATA%\Optic` is kept. Delete that folder to remove all Optic data, including imported kubeconfigs, which contain credentials.

## AI clients (optional)
1. In Optic, open **Cluster settings → AI Access** and approve a cluster.
2. Register the server with your AI client. For Claude Code:
   ```powershell
   claude mcp add optic-kubernetes -- "C:\Users\<you>\AppData\Local\Programs\Optic\Optic.exe" --mcp
   ```
   Use your actual install path; the AI Access page shows the exact command.
