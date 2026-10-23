import type { WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ClusterManager } from './clusters';
import type { Streams } from './streams';
import type { SessionService } from './sessions';
import type { Requests } from '../shared/protocol';
import { kubeJson } from './kube-http';
import { AppError } from './errors';
export function nodeShellManifest(node: string, name: string, image: string, secret: string) {
  return { apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: 'kube-system', labels: { 'app.kubernetes.io/managed-by': 'optic', 'optic.dev/purpose': 'node-shell' } }, spec: {
    nodeName: node, hostPID: true, hostNetwork: true, restartPolicy: 'Never', activeDeadlineSeconds: 3600,
    automountServiceAccountToken: false, tolerations: [{ operator: 'Exists' }],
    ...(secret ? { imagePullSecrets: [{ name: secret }] } : {}),
    containers: [{ name: 'shell', image, command: ['/bin/sh', '-c', 'sleep 3600'], securityContext: { privileged: true, runAsUser: 0 }, resources: { requests: { cpu: '10m', memory: '16Mi' }, limits: { memory: '256Mi' } } }]
  } };
}
export class NodeShell {
  constructor(private clusters: ClusterManager, private streams: Streams, private sessions: SessionService) {}
  async open(owner: WebContents, input: Requests['nodeshell:open']['input']) {
    const config = this.clusters.get(input.clusterId).config, settings = this.clusters.settings(input.clusterId);
    const name = `optic-shell-${randomUUID().slice(0, 12)}`, path = `/api/v1/namespaces/kube-system/pods/${name}`;
    const abort = new AbortController(); let transferred = false, created = false, uid: string | undefined;
    const cleanup = async () => { if (!created) return; created = false; try { await kubeJson(config, path, { method: 'DELETE', body: { apiVersion: 'v1', kind: 'DeleteOptions', gracePeriodSeconds: 0, ...(uid ? { preconditions: { uid } } : {}) } }); } catch { console.warn('Optic node-shell cleanup failed; inspect pods labeled optic.dev/purpose=node-shell in kube-system.'); } };
    this.streams.add(input.id, { owner, clusterId: input.clusterId, dispose: () => { if (!transferred) { abort.abort(); void cleanup(); } } });
    try {
      // Only perform creation after an explicit user confirmation in the node detail view.
      const response = await kubeJson<any>(config, '/api/v1/namespaces/kube-system/pods', { method: 'POST', body: nodeShellManifest(input.node, name, settings.nodeShellImage, settings.nodeShellPullSecret) });
      created = true; uid = response.metadata?.uid;
      if (abort.signal.aborted) throw new AppError('CANCELLED', 'Node shell cancelled.');
      let ready = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        const pod = await kubeJson<any>(config, path, { signal: abort.signal });
        if (pod.status?.phase === 'Running') { ready = true; break; }
        if (['Failed', 'Succeeded'].includes(pod.status?.phase)) throw new AppError('NODE_SHELL_FAILED', 'Node shell pod exited before becoming ready.');
        await delay(2000, undefined, { signal: abort.signal });
      }
      if (!ready) throw new AppError('NODE_SHELL_TIMEOUT', 'Node shell pod did not become ready. Check image, scheduling and admission policy.');
      transferred = true; this.streams.close(input.id);
      await this.sessions.terminal(owner, { ...input, namespace: 'kube-system', pod: name, container: 'shell' }, () => { void cleanup(); }, ['nsenter', '--target', '1', '--mount', '--uts', '--ipc', '--net', '--pid', '--', '/bin/sh']);
    } catch (error) { this.streams.close(input.id); await cleanup(); throw error; }
  }
}
