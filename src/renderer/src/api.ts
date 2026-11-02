import type { Requests } from '../../shared/protocol';
export async function request<K extends keyof Requests>(channel: K, input: Requests[K]['input']): Promise<Requests[K]['output']> {
  const result = await window.desktop.request(channel, input);
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.data;
}
export const closeStream = (id: string) => { void request('stream:close', { id }).catch(() => {}); };
