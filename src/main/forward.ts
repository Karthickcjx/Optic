import { spawn, type ChildProcess } from 'node:child_process';
import type { WebContents } from 'electron';
import type { ClusterManager } from './clusters';
import type { Streams } from './streams';
import type { Requests } from '../shared/protocol';
import { AppError } from './errors';

export function forwardArgs(source: string, context: string, input: Requests['forward:start']['input']) {
  return ['--kubeconfig', source, '--context', context, '--namespace', input.namespace, 'port-forward', '--address=127.0.0.1', `${input.kind}/${input.name}`, `${input.localPort || ''}:${input.remotePort}`];
}
export class ForwardService {
  constructor(private clusters: ClusterManager, private streams: Streams) {}
  async start(owner: WebContents, input: Requests['forward:start']['input']) {
    const { cluster } = this.clusters.get(input.clusterId);
    let child: ChildProcess | undefined, closed = false, timer: NodeJS.Timeout | undefined;
    this.streams.add(input.id, { owner, clusterId: input.clusterId, dispose: () => { closed = true; clearTimeout(timer); child?.kill(); } });
    try {
      return await new Promise<{ localPort: number }>((resolve, reject) => {
        let ready = false, settled = false, buffer = '';
        const fail = (message: string) => {
          const error = new AppError('FORWARD_FAILED', message);
          if (!settled) { settled = true; reject(error); }
          if (!closed) { this.streams.error(input.id, error); this.streams.end(input.id); }
        };
        child = spawn('kubectl', forwardArgs(cluster.source, cluster.name, input), { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        timer = setTimeout(() => fail('Port-forward startup timed out. Check connectivity and pod readiness.'), 20000);
        const output = (chunk: Buffer) => {
          if (closed || ready) return;
          buffer = (buffer + chunk.toString()).slice(-8192);
          const match = buffer.match(/Forwarding from 127\.0\.0\.1:(\d+)\s+->/);
          if (match) { ready = true; settled = true; clearTimeout(timer); resolve({ localPort: Number(match[1]) }); }
        };
        child.stdout?.on('data', output); child.stderr?.on('data', output);
        child.on('error', () => fail('Could not start kubectl. Install kubectl on PATH to use port forwarding.'));
        child.on('exit', code => {
          clearTimeout(timer);
          if (!ready) fail('Port forwarding stopped before becoming ready. Check the local port, pod/service, credentials and RBAC.');
          else if (!closed) { if (code) this.streams.error(input.id, new AppError('FORWARD_ENDED', 'Port forwarding disconnected. Restart it to reconnect.')); this.streams.end(input.id, code ?? undefined); }
        });
      });
    } catch (error) { this.streams.close(input.id); throw error; }
  }
}
