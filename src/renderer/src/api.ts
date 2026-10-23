import type { Requests } from '../../shared/protocol';
export async function request<K extends keyof Requests>(channel: K, input: Requests[K]['input']): Promise<Requests[K]['output']> {
  const result = await window.desktop.request(channel, input);
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}
export const closeStream = (id: string) => { void request('stream:close', { id }).catch(() => {}); };
