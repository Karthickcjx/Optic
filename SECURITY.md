# Security policy

Optic is beta software. Only the latest beta receives fixes; there is no production support SLA.

Report vulnerabilities privately through GitHub's **Security → Report a vulnerability** when available. Do not post kubeconfigs, tokens, certificates, logs containing secrets, or exploit details in public issues. If private reporting is unavailable, open an issue requesting a private contact without sensitive details.

Kubeconfigs can execute local authentication plugins. Import only trusted files. Terminals run with your operating-system permissions. Cluster actions use your kubeconfig permissions; Optic is not an authorization boundary. Prefer least-privilege Kubernetes credentials.

Optic stores imported kubeconfigs in its local application profile. They are not encrypted by Optic. Protect your operating-system account and disk. Exports and terminal output may contain sensitive information; review them before sharing.

The application connects to configured Kubernetes APIs, chart repositories/registries and optional public cloud pricing services. No analytics service is configured. Cost reports are estimates, not billing records. Missing telemetry is not billed as zero usage.

Download releases only from this repository. Check SHA-256 checksums. Unsigned beta installers may be blocked by operating-system or organization policy; do not disable those protections. Signing and notarization are not yet available.
