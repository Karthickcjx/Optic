import { parentPort } from 'node:worker_threads';
import { parse } from 'yaml';

parentPort!.once('message', (source: string) => {
  try {
    const data = parse(source);
    if (data?.apiVersion !== 'v1' || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) throw new Error();
    const entries = Object.create(null);
    for (const [name, versions] of Object.entries(data.entries)) {
      if (!Array.isArray(versions)) continue;
      entries[name] = versions.filter(e => e?.name === name && typeof e.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.+-]+)?$/.test(e.version))
        .map(e => ({ name, version: e.version, appVersion: String(e.appVersion ?? ''), description: String(e.description ?? '').slice(0, 2000), deprecated: !!e.deprecated, urls: Array.isArray(e.urls) ? e.urls.filter((url: unknown) => typeof url === 'string') : [] }))
        .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
    }
    parentPort!.postMessage({ entries });
  } catch { parentPort!.postMessage({ error: true }); }
});
