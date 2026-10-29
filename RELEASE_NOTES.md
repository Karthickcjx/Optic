# Optic 0.1.0-beta.1

First public beta of Optic, a Kubernetes desktop workspace.

## Included

- Multiple kubeconfig imports from files or pasted YAML; cluster and namespace navigation.
- Resource tables, details, YAML editing, related resources and confirmed workload actions.
- Helm repositories, chart/release management and Import and Deploy workflows.
- Pod logs, multi-pod logs, exports, local/container terminals and split panes.
- Prometheus metrics, historical estimates and cost reports with explicit data coverage.
- Security report browsing through supported Trivy Operator APIs.

## Requirements and limitations

- Windows x64 is the initial installer target. macOS and Linux require platform validation before binary publication.
- A reachable Kubernetes API and suitable RBAC are required. Install `kubectl` for pod terminals and Helm for chart operations. Authentication plugins referenced by kubeconfig must also be installed.
- Prometheus, kube-state-metrics and cAdvisor are required for historical estimates. Data before monitoring was installed cannot be reconstructed. Security reports require the operator and report CRDs.
- Beta installers are unsigned. Organization application-control policies may prevent execution. No automatic updater is included.
- Tests cover fixture-backed desktop workflows and selected live-cluster checks, not every Kubernetes distribution, chart or cloud provider. Back up important configuration and review mutations before applying.
- Pricing is an estimate and excludes some charges. Imported credentials remain in your local profile; see SECURITY.md.

## Installation

Download the Windows x64 installer and SHA256SUMS.txt from the matching GitHub release. In PowerShell, run `Get-FileHash .\Optic-0.1.0-beta.1-win-x64.exe -Algorithm SHA256` and compare the result with the checksum file, then run the installer if permitted by your system policy.

To run from source, use Node.js 24, `npm ci`, then `npm run dev`. Source archives alone do not include dependencies or built binaries.

## Feedback

Open a GitHub issue with your Optic version, OS, Kubernetes version and sanitized reproduction steps. Never attach an unredacted kubeconfig. For security issues, use SECURITY.md.
