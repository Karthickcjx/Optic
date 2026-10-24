// Explicit status filters work with both Helm 3 and Helm 4 (--all was removed in 4).
export const helmReleaseStatuses = ['--deployed', '--failed', '--pending', '--uninstalled', '--uninstalling', '--superseded'];

// Never expose raw stderr: templates and authentication plugins can print secrets.
export function helmFailure(error: { code?: string | number | null; killed?: boolean }, stderr = '') {
  if (error.code === 'ENOENT') return 'Helm is not installed or is missing from PATH. Install Helm and restart Optic.';
  if (error.killed || /timed out|deadline exceeded/i.test(stderr)) return 'Helm timed out waiting for the operation. Check release status and pod events before retrying; some resources may already exist.';
  if (/cannot re-use a name|already exists/i.test(stderr)) return 'A release or resource with this name already exists. Open Helm Releases and inspect it; upgrade the existing release or choose another name.';
  if (/another operation .* in progress/i.test(stderr)) return 'Another Helm operation is pending for this release. Inspect its status and history before retrying.';
  if (/unknown flag/i.test(stderr)) return 'This Helm executable does not support an option requested by Optic. Check the installed Helm version and update Optic.';
  if (/forbidden|unauthorized/i.test(stderr)) return 'Access was denied by the cluster or chart registry. Check cluster RBAC, credentials and registry access.';
  if (/cluster unreachable|connection refused|no such host|i\/o timeout/i.test(stderr)) return 'Helm could not reach the cluster or chart registry. Check the selected context, network and VPN.';
  if (/toomanyrequests|too many requests|429/i.test(stderr)) return 'The chart registry is rate limiting downloads. Wait before retrying or configure registry authentication.';
  if (/values don.t meet|schema|execution error|parse error|template:/i.test(stderr)) return 'The chart rejected its values or could not render a template. Check the pinned chart version, required values and chart README.';
  return 'Helm failed. Check chart requirements, permissions and release status. A failed installation may leave resources; inspect the release before retrying.';
}
