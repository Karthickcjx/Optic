import type { Fault } from '../shared/protocol';
export class AppError extends Error { constructor(public code: string, message: string) { super(message); } }
export function fault(error: unknown): Fault {
  if (error instanceof AppError) return { code: error.code, message: error.message, retryable: false };
  const e = error as { code?: number | string; statusCode?: number; name?: string };
  const code = e?.statusCode ?? e?.code;
  if (code === 401 || code === 403) return { code: 'FORBIDDEN', message: 'The cluster rejected this request. Check credentials and RBAC permissions.', retryable: false };
  if (code === 404) return { code: 'NOT_FOUND', message: 'This resource or API is unavailable.', retryable: false };
  if (code === 409) return { code: 'CONFLICT', message: 'The resource changed. Reload its YAML before saving.', retryable: true };
  if (code === 422 || code === 400) return { code: 'INVALID_RESOURCE', message: 'Kubernetes rejected the resource. Check its required fields, API version and schema.', retryable: false };
  if (code === 429) return { code: 'RATE_LIMITED', message: 'The API server is limiting requests. Wait briefly before retrying.', retryable: true };
  if (e?.name === 'TimeoutError' || code === 'ETIMEDOUT') return { code: 'TIMEOUT', message: 'The Kubernetes API did not respond in time. Check your network or VPN and retry.', retryable: true };
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') return { code: 'UNREACHABLE', message: 'The API server could not be reached. Check the kubeconfig server address, network and VPN.', retryable: true };
  return { code: 'REQUEST_FAILED', message: 'Request failed. Check cluster connectivity, kubeconfig authentication, and installed command-line tools.', retryable: true };
}
