import { HttpMethod, RequestContext, type KubeConfig } from '@kubernetes/client-node';
import { fetch } from 'undici';
type FailedResponse = { status: number; headers: { get(name: string): string | null }; body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> }; cancel(): Promise<void> } | null };
// Kubernetes explains rejections (admission denials, RBAC, waiting containers) in a v1 Status body.
// Read at most 64 KiB and keep only Status.message and whether it reports field-manager conflicts; other bodies are discarded unread.
export async function kubeFailure(response: FailedResponse, message: string) {
  let detail: string | undefined, fieldConflict = false;
  if (response.body && /\bjson\b/i.test(response.headers.get('content-type') ?? '')) {
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      while (size <= 65536) { const { done, value } = await reader.read(); if (done || !value) break; chunks.push(value); size += value.byteLength; }
      const status = size <= 65536 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      if (status?.kind === 'Status' && status.apiVersion === 'v1' && typeof status.message === 'string' && status.message.trim()) detail = status.message;
      // Server-side apply reports fields owned by another manager as FieldManagerConflict causes (StatusCause.Type is serialized as "reason").
      fieldConflict = status?.kind === 'Status' && Array.isArray(status.details?.causes) && status.details.causes.some((c: { reason?: unknown } | null) => c?.reason === 'FieldManagerConflict');
    } catch { /* Malformed or interrupted bodies keep the status-code classification. */ }
    finally { await reader.cancel().catch(() => {}); }
  } else await response.body?.cancel().catch(() => {});
  return Object.assign(new Error(message), { statusCode: response.status, ...(detail ? { kubernetesMessage: detail } : {}), ...(fieldConflict ? { fieldConflict } : {}) });
}
export async function kubeJson<T = any>(config: KubeConfig, path: string, options: { method?: 'GET' | 'PUT' | 'PATCH' | 'POST' | 'DELETE'; body?: unknown; contentType?: string; signal?: AbortSignal } = {}): Promise<T> {
  const url = config.getCurrentCluster()!.server.replace(/\/$/, '') + path;
  const context = new RequestContext(url, (options.method ?? 'GET') as HttpMethod);
  await config.applySecurityAuthentication(context);
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
  const response = await fetch(url, { method: options.method ?? 'GET', headers: { ...context.getHeaders(), Accept: 'application/json', ...(options.body ? { 'Content-Type': options.contentType ?? 'application/json' } : {}) }, dispatcher: context.getDispatcher(), signal, body: options.body ? JSON.stringify(options.body) : undefined });
  if (!response.ok) throw await kubeFailure(response, 'Kubernetes request failed');
  return await response.json() as T;
}
