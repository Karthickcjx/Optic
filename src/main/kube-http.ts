import { HttpMethod, RequestContext, type KubeConfig } from '@kubernetes/client-node';
import { fetch } from 'undici';
export async function kubeJson<T = any>(config: KubeConfig, path: string, options: { method?: 'GET' | 'PUT' | 'PATCH' | 'POST' | 'DELETE'; body?: unknown; contentType?: string; signal?: AbortSignal } = {}): Promise<T> {
  const url = config.getCurrentCluster()!.server.replace(/\/$/, '') + path;
  const context = new RequestContext(url, (options.method ?? 'GET') as HttpMethod);
  await config.applySecurityAuthentication(context);
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
  const response = await fetch(url, { method: options.method ?? 'GET', headers: { ...context.getHeaders(), Accept: 'application/json', ...(options.body ? { 'Content-Type': options.contentType ?? 'application/json' } : {}) }, dispatcher: context.getDispatcher(), signal, body: options.body ? JSON.stringify(options.body) : undefined });
  if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error('Kubernetes request failed'), { statusCode: response.status }); }
  return await response.json() as T;
}
