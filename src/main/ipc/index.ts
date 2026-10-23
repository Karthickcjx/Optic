import { app, dialog, ipcMain, type WebContents } from 'electron';
import { join } from 'node:path';
import { channels, type Requests, type Result } from '../../shared/protocol';
import { ClusterManager } from '../clusters';
import { ResourceService } from '../resources';
import { SessionService } from '../sessions';
import { Streams } from '../streams';
import { schemas } from '../validation';
import { AppError, fault } from '../errors';
import { ForwardService } from '../forward';

export function registerIpc(isTrusted: (url: string) => boolean) {
  const clusters = new ClusterManager(undefined, join(app.getPath('userData'), 'kubeconfig-sources.json')); const resources = new ResourceService(clusters);
  const streams = new Streams(); const sessions = new SessionService(clusters, streams);
  const forwards = new ForwardService(clusters, streams);
  type Handlers = { [K in keyof Requests]: (input: Requests[K]['input'], owner: WebContents) => Promise<Requests[K]['output']> | Requests[K]['output'] };
  const handlers: Handlers = {
    'clusters:remove': input => { const result = clusters.removeContext(input.clusterId); streams.closeCluster(input.clusterId); return result; },
    'forward:start': (input, owner) => forwards.start(owner, input),
    'clusters:import': async () => { const result = await dialog.showOpenDialog({ title: 'Add kubeconfig files', properties: ['openFile', 'multiSelections'] }); return result.canceled ? clusters.discover() : clusters.addPaths(result.filePaths); },
    'metrics:read': input => resources.metrics(input.clusterId),
    'resources:apply': input => resources.apply(input.clusterId, input.yaml, input.namespace, input.dryRun),
    'resources:scale': input => resources.scale(input, input.replicas),
    'nodes:cordon': input => resources.cordon(input.clusterId, input.name, input.unschedulable),
    'clusters:list': () => clusters.discover(), 'clusters:health': input => clusters.health(input.clusterId),
    'resources:list': input => resources.list(input),
    'resources:watch': (input, owner) => {
      let stop = () => {};
      streams.add(input.id, { owner, clusterId: input.clusterId, dispose: () => stop() });
      stop = resources.watch(input, items => streams.emit(input.id, { id: input.id, type: 'resources', items }), error => streams.error(input.id, error));
    },
    'resources:yaml': input => resources.yaml(input), 'resources:replace': input => resources.replace(input, input.yaml),
    'resources:delete': input => resources.delete(input), 'resources:restart': input => resources.restart(input),
    'logs:start': (input, owner) => sessions.logs(owner, input), 'terminal:open': (input, owner) => sessions.terminal(owner, input),
    'terminal:write': (input, owner) => { const session = streams.get(input.id, owner); if (!session.write) throw new AppError('NOT_TERMINAL', 'Stream does not accept input.'); session.write(input.data); },
    'terminal:resize': (input, owner) => { streams.get(input.id, owner).resize?.(input.cols, input.rows); },
    'stream:ack': (input, owner) => { streams.get(input.id, owner).ack?.(input.seq); },
    'stream:close': (input, owner) => { streams.get(input.id, owner); streams.close(input.id); }
  };
  for (const channel of channels) {
    ipcMain.handle(channel, async (event, raw): Promise<Result<unknown>> => {
      try {
        if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || !isTrusted(event.senderFrame.url)) throw new AppError('UNTRUSTED_SENDER', 'Request rejected.');
        const parsed = schemas[channel].safeParse(raw);
        if (!parsed.success) throw new AppError('INVALID_INPUT', 'Invalid request payload.');
        const handler = handlers[channel] as (input: unknown, owner: WebContents) => unknown;
        return { ok: true, data: await handler(parsed.data, event.sender) };
      } catch (error) { return { ok: false, error: fault(error) }; }
    });
  }
  return streams;
}
