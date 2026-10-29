import { Worker } from 'node:worker_threads';

export function parseHelmIndex(source: string, signal: AbortSignal): Promise<Record<string, any[]>> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Catalog cancelled')); return; }
    const worker = new Worker(new URL('./helm-index-worker.js', import.meta.url));
    const finish = (error?: Error, entries?: Record<string, any[]>) => {
      signal.removeEventListener('abort', abort);
      worker.removeAllListeners();
      void worker.terminate();
      error ? reject(error) : resolve(entries!);
    };
    const abort = () => finish(new Error('Catalog cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    worker.once('message', message => message.error ? finish(new Error('Invalid catalog')) : finish(undefined, message.entries));
    worker.once('error', error => finish(error));
    worker.once('exit', () => finish(new Error('Catalog worker exited')));
    worker.postMessage(source);
  });
}
