import { externalToolLaunch } from './external-tools';
import { utilityProcess, type WebContents } from 'electron';
import { resolveLocalShell } from './terminal-profiles';
import { CoreV1Api, RequestContext, HttpMethod } from '@kubernetes/client-node';
import { fetch } from 'undici';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClusterManager } from './clusters';
import type { Streams } from './streams';
import type { Requests } from '../shared/protocol';
import { AppError } from './errors';

export class SessionService {
  constructor(private clusters: ClusterManager, private streams: Streams) {}
  async logs(owner: WebContents, options: Requests['logs:start']['input']) {
    const { id } = options;
    let stopped = false, controller: AbortController | undefined, sequence = 0;
    let pending: { seq: number; done: (error?: Error | null) => void } | undefined;
    let ackTimer: NodeJS.Timeout | undefined;
    const decoder = new StringDecoder('utf8');
    const output = new Writable({ highWaterMark: 65536, write: (chunk, _encoding, done) => {
      if (stopped) { done(); return; }
      const data = decoder.write(chunk);
      if (!data) { done(); return; }
      const seq = ++sequence; pending = { seq, done };
      this.streams.emit(id, { id, type: 'data', data, seq });
      ackTimer = setTimeout(() => { this.streams.error(id, new AppError('SLOW_CONSUMER', 'Log viewer stopped consuming data. Reopen the stream.')); this.streams.end(id); }, 30000);
    } });
    this.streams.add(id, { owner, clusterId: options.clusterId, dispose: () => {
      stopped = true; clearTimeout(ackTimer); controller?.abort(); pending?.done(); pending = undefined; output.destroy();
    }, ack: seq => { if (pending?.seq === seq) { clearTimeout(ackTimer); const done = pending.done; pending = undefined; done(); } } });
    output.on('finish', () => this.streams.end(id));
    output.on('error', error => { if (!stopped) { this.streams.error(id, error); this.streams.end(id); } });
    try {
      const config = this.clusters.get(options.clusterId).config;
      let container = options.container;
      if (!container) {
        const pod = await config.makeApiClient(CoreV1Api).readNamespacedPod({ name: options.pod, namespace: options.namespace });
        container = pod.spec?.containers[0]?.name;
      }
      if (stopped) return;
      if (!container) throw new AppError('NO_CONTAINER', 'No container is available.');
      controller = new AbortController();
      const url = new URL(`${config.getCurrentCluster()!.server}/api/v1/namespaces/${encodeURIComponent(options.namespace)}/pods/${encodeURIComponent(options.pod)}/log`);
      url.search = new URLSearchParams({ container, follow: String(!options.previous), previous: String(options.previous ?? false), ...(options.sinceTime ? { sinceTime: options.sinceTime } : { tailLines: String(options.tailLines ?? 500) }), timestamps: 'true' }).toString();
      const context = new RequestContext(url.href, HttpMethod.GET);
      await config.applySecurityAuthentication(context);
      if (stopped) return;
      const timeout = setTimeout(() => controller?.abort(), 15000);
      let response;
      try { response = await fetch(url, { headers: context.getHeaders(), dispatcher: context.getDispatcher(), signal: controller.signal }); }
      finally { clearTimeout(timeout); }
      if (!response.ok || !response.body) { await response.body?.cancel(); throw Object.assign(new Error('Log request failed'), { statusCode: response.status }); }
      void pipeline(Readable.fromWeb(response.body as any), output).catch(error => {
        if (!stopped) { this.streams.error(id, error); this.streams.end(id); }
      });
    } catch (error) { if (!stopped) this.streams.close(id); throw error; }
  }
  async terminal(owner: WebContents, options: Requests['terminal:open']['input'], onClosed?: () => void, remoteCommand?: string[]) {
    const { id } = options;
    const local = options.pod ? undefined : options.externalTool ? externalToolLaunch() : resolveLocalShell(options.localShell);
    let file = local?.file ?? '';
    let args: string[] = local?.args ?? [];
    const lease = options.clusterId ? this.clusters.cliConfig(options.clusterId) : undefined;
    const environment = { ...process.env, TERM: 'xterm-256color', ...(lease ? { KUBECONFIG: lease.path } : {}), ...(options.localShell === 'gitbash' ? { CHERE_INVOKING: '1' } : {}) };
    // A local terminal inherits the user's environment. Pod selection is passed as argv, never interpolated shell code.
    if (options.pod) {
      const { cluster } = this.clusters.get(options.clusterId!);
      // ConPTY requires the executable extension; unlike execFile, it does not
      // resolve a bare kubectl command through Windows PATHEXT.
      file = process.platform === 'win32' ? 'kubectl.exe' : 'kubectl';
      args = ['--kubeconfig', lease!.path, '--context', cluster.name, '--namespace', options.namespace!, 'exec', '-it', options.pod];
      if (options.container) args.push('-c', options.container);
      args.push('--', ...(remoteCommand ?? [options.shell ?? lease?.settings.containerShell ?? '/bin/sh']));
    }
    let worker: ReturnType<typeof utilityProcess.fork>;
    try { worker = utilityProcess.fork(join(dirname(fileURLToPath(import.meta.url)), 'pty-worker.js'), [], { serviceName: 'Optic terminal', stdio: 'pipe' }); }
    catch (error) { lease?.cleanup(); onClosed?.(); throw error; }
    let closed = false;
    const post = (value: unknown) => { if (!closed) worker.postMessage(value); };
    try {
      this.streams.add(id, { owner, clusterId: options.clusterId,
        dispose: () => { if (closed) return; post({ type: 'close' }); closed = true; lease?.cleanup(); onClosed?.(); setTimeout(() => worker.kill(), 500).unref(); },
        write: data => post({ type: 'write', data }), resize: (cols, rows) => post({ type: 'resize', cols, rows }), ack: seq => post({ type: 'ack', seq })
      });
    } catch (error) { worker.kill(); lease?.cleanup(); onClosed?.(); throw error; }
    // Drain diagnostic pipes without forwarding potentially sensitive process environment details.
    worker.stdout?.resume(); worker.stderr?.resume();
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      const timeout = setTimeout(() => { reject(new AppError('TERMINAL_TIMEOUT', 'Terminal startup timed out.')); this.streams.close(id); }, 15000);
      worker.on('message', (message: any) => {
        if (closed) return;
        if (message.type === 'ready') { ready = true; clearTimeout(timeout); resolve(); }
        else if (message.type === 'data') this.streams.emit(id, { id, type: 'data', data: message.data, seq: message.seq });
        else if (message.type === 'end') this.streams.end(id, message.exitCode);
        else if (message.type === 'error') {
          const error = new AppError('TERMINAL_FAILED', 'Could not start terminal. Check your shell, kubectl, and node-pty installation.');
          clearTimeout(timeout); reject(error); this.streams.error(id, error); this.streams.end(id, 1);
        }
      });
      worker.on('exit', code => { clearTimeout(timeout); if (!ready) reject(new AppError('TERMINAL_FAILED', 'Terminal helper exited before startup.')); if (!closed) this.streams.end(id, code); });
      worker.on('spawn', () => post({ type: 'open', file, args, cwd: lease?.settings.terminalCwd || homedir(), env: environment, cols: options.cols, rows: options.rows }));
    });
  }
}
