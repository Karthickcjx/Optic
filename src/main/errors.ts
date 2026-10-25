import type { Fault } from '../shared/protocol';
export class AppError extends Error { constructor(public code: string, message: string) { super(message); } }
export function fault(error: unknown): Fault {
  if (error instanceof AppError) return { code: error.code, message: error.message, retryable: false };
  const causes: { code?: number | string; statusCode?: number; name?: string; cause?: unknown }[] = [];
  let current = error;
  // Fetch wraps transport failures in TypeError.cause. Bound traversal and never
  // forward raw messages, which can contain credentials or request URLs.
  while (current && typeof current === 'object' && causes.length < 8 && !causes.includes(current)) {
    causes.push(current); current = (current as { cause?: unknown }).cause;
  }
  const codes = causes.map(e => e.statusCode ?? e.code);
  const code = codes.find(c => typeof c === 'number') ?? codes.find(c => ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'].includes(String(c)));
  if (code === 401 || code === 403) return { code: 'FORBIDDEN', message: 'The cluster rejected this request. Check credentials and RBAC permissions.', retryable: false };
  if (code === 404) return { code: 'NOT_FOUND', message: 'This resource or API is unavailable.', retryable: false };
  if (code === 409) return { code: 'CONFLICT', message: 'The resource changed. Reload its YAML before saving.', retryable: true };
  if (code === 422 || code === 400) return { code: 'INVALID_RESOURCE', message: 'Kubernetes rejected the resource. Check its required fields, API version and schema.', retryable: false };
  if (code === 429) return { code: 'RATE_LIMITED', message: 'The API server is limiting requests. Wait briefly before retrying.', retryable: true };
  if (causes.some(e => e.name === 'TimeoutError') || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(String(code))) return { code: 'TIMEOUT', message: 'The Kubernetes API did not respond in time. Check your network or VPN and retry.', retryable: true };
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'].includes(String(code))) return { code: 'UNREACHABLE', message: 'The API server could not be reached. Check the kubeconfig server address, DNS, network and VPN.', retryable: true };
  return { code: 'REQUEST_FAILED', message: 'Request failed. Check cluster connectivity, kubeconfig authentication, and installed command-line tools.', retryable: true };
}
