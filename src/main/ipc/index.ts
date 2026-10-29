import { trivyInstallCommands } from '../../shared/security';
import { localShellProfiles } from '../terminal-profiles';
import { Imports } from '../imports';
import { Deployments } from '../deploy';
import { SecurityReports } from '../security';
import { exportCostReport } from '../cost-export';
import { CostReports } from '../cost-report';
import { OverviewMetrics } from '../overview-metrics';
import { ResourceMetrics } from '../resource-metrics';
import { exportLogs } from '../log-export';
import { ResourceActions } from '../resource-actions';
import { HelmService } from '../helm';
import { Providers } from '../providers';
import { Monitoring } from '../monitoring';
import { NodeShell } from '../node-shell';
import { app, clipboard, dialog, shell, ipcMain, type WebContents } from 'electron';
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
  const securityReports = new SecurityReports(clusters);
  const costReports = new CostReports(clusters);
  const overviewMetrics = new OverviewMetrics(clusters);
  const resourceMetrics = new ResourceMetrics(clusters, resources);
  const actions = new ResourceActions(clusters, resources);
  const streams = new Streams(); const sessions = new SessionService(clusters, streams);
  const providers = new Providers(clusters), monitoring = new Monitoring(clusters), nodeShell = new NodeShell(clusters, streams, sessions);
  const imports = new Imports();
  const helm: HelmService = new HelmService(clusters, join(app.getPath('userData'), 'helm-repositories.json'), id => monitoring.isBusy(id) || deployments.isBusy(id));
  const deployments: Deployments = new Deployments(clusters, imports, id => monitoring.isBusy(id) || helm.isBusy(id) || actions.isBusy(id), join(app.getPath('userData'), 'import-operations.json'));
  const operationBusy = (id: string) => monitoring.isBusy(id) || helm.isBusy(id) || actions.isBusy(id) || deployments.isBusy(id);
  app.on('before-quit', () => { deployments.close(); imports.close(); monitoring.dispose(); helm.dispose(); actions.dispose(); });
  const forwards = new ForwardService(clusters, streams);
  type Handlers = { [K in keyof Requests]: (input: Requests[K]['input'], owner: WebContents) => Promise<Requests[K]['output']> | Requests[K]['output'] };
  const handlers: Handlers = {
    'terminal:clipboard-read': async () => { const text = await clipboard.readText(); if (text.length > 60000) throw new AppError('CLIPBOARD_TOO_LARGE', 'Terminal paste is limited to 60,000 characters. Paste a smaller selection.'); return text; },
    'terminal:clipboard-write': input => clipboard.writeText(input.text),
    'terminal:profiles': () => localShellProfiles(),
    'deploy:stop': input => deployments.stop(input.id),
    'imports:dependencies': (input, owner) => deployments.dependencies(input.id, owner.id),
    'imports:pick': async (input, owner) => {
      const directory = ['folder', 'kustomize', 'chart'].includes(input.kind);
      const result = await dialog.showOpenDialog({ title: `Import ${input.kind}`, properties: directory ? ['openDirectory'] : ['openFile', ...(input.kind === 'archive' ? [] : ['multiSelections' as const])], filters: directory ? [] : [{ name: input.kind === 'archive' ? 'Helm chart' : 'YAML / JSON', extensions: input.kind === 'archive' ? ['tgz'] : input.kind === 'certificate' ? ['pem', 'crt', 'cer'] : ['yaml', 'yml', 'json'] }] });
      return result.canceled ? undefined : imports.add(input.kind, result.filePaths, owner.id);
    },
    'imports:remote': (input, owner) => deployments.remote(input, owner.id),
    'imports:dispose': (input, owner) => imports.dispose(input.id, owner.id),
    'deploy:prepare': (input, owner) => deployments.prepare(input, owner.id),
    'deploy:discard': (input, owner) => deployments.discard(input.id, owner.id),
    'deploy:start': (input, owner) => deployments.start(input.id, owner.id),
    'deploy:status': () => deployments.status(),
    'deploy:dismiss': input => deployments.dismiss(input.id),
    'security:copy-install': () => clipboard.writeText(trivyInstallCommands),
    'security:reports': input => securityReports.read(input),
    'security:detail': input => securityReports.detail(input),
    'cost:export': (input, owner) => exportCostReport(owner, input.text, input.format),
    'logs:export': (input, owner) => exportLogs(owner, input.text),
    'nodes:drain-preview': input => actions.drainPreview(input),
    'nodes:drain': input => actions.drain(input, input.options),
    'deployments:revisions': input => actions.revisions(input),
    'deployments:rollback': input => actions.rollback(input, input.revision, input.replicaSetUid),
    'cronjobs:trigger': input => actions.trigger(input, input.jobName),
    'cronjobs:suspend': input => actions.suspend(input, input.suspend),
    'resources:edit': input => actions.edit(input, input.changes, input.dryRun),
    'helm:repositories': () => helm.repositories(),
    'helm:repository-save': input => helm.saveRepository(input.repository, input.remove),
    'helm:charts': input => helm.charts(input.repository, input.refresh),
    'helm:versions': input => helm.versions(input.repository, input.chart),
    'helm:chart-info': input => helm.chartInfo(input.repository, input.chart, input.version),
    'helm:releases': input => helm.releases(input.clusterId, input.namespace),
    'helm:details': input => helm.details(input),
    'helm:preview': input => helm.preview(input),
    'helm:apply': input => helm.apply(input.plan, input.token),
    'helm:rollback': input => helm.rollback(input, input.revision),
    'helm:uninstall': input => helm.uninstall(input),

    'settings:get': input => clusters.settings(input.clusterId),
    'settings:save': input => { if (operationBusy(input.clusterId)) throw new AppError('BUSY', 'Wait for the active operation before changing settings.'); const result = clusters.saveSettings(input.clusterId, input.settings); streams.closeCluster(input.clusterId); return result; },
    'settings:directory': async () => { const result = await dialog.showOpenDialog({ title: 'Terminal working directory', properties: ['openDirectory'] }); return result.canceled ? undefined : result.filePaths[0]; },
    'settings:reveal': input => shell.showItemInFolder(clusters.get(input.clusterId, true).cluster.source),
    'clusters:connect': input => clusters.connect(input.clusterId),
    'clusters:disconnect': input => { if (operationBusy(input.clusterId)) throw new AppError('BUSY', 'Wait for the active operation before disconnecting.'); clusters.disconnect(input.clusterId); streams.closeCluster(input.clusterId); },
    'cost:report': input => costReports.read(input),
    'cost:read': input => providers.cost(input.clusterId),
    'monitoring:version': input => monitoring.latestVersion(input.component),
    'monitoring:status': input => monitoring.status(input.clusterId),
    'monitoring:apply': input => { if (helm.isBusy(input.clusterId) || deployments.isBusy(input.clusterId)) throw new AppError('HELM_BUSY', 'Wait for the active Helm operation.'); return monitoring.apply(input.clusterId, input.changes); },
    'nodeshell:open': (input, owner) => nodeShell.open(owner, input),
    'clusters:remove': input => { if (operationBusy(input.clusterId)) throw new AppError('BUSY', 'Wait for the active operation before removing the context.'); const result = clusters.removeContext(input.clusterId); streams.closeCluster(input.clusterId); return result; },
    'forward:start': (input, owner) => forwards.start(owner, input),
    'clusters:import-clipboard': input => clusters.importClipboard(input.yaml),
    'clusters:import': async () => { const result = await dialog.showOpenDialog({ title: 'Add kubeconfig files', properties: ['openFile', 'multiSelections'] }); return result.canceled ? clusters.discover() : clusters.addPaths(result.filePaths); },
    'metrics:resource': input => resourceMetrics.read(input),
    'metrics:history': input => overviewMetrics.read(input.clusterId, input.minutes),
    'metrics:read': input => resources.metrics(input.clusterId),
    'resources:apply': input => resources.apply(input.clusterId, input.yaml, input.namespace, input.dryRun),
    'resources:scale': input => resources.scale(input, input.replicas),
    'nodes:cordon': input => { if (actions.isBusy(input.clusterId)) throw new AppError('BUSY', 'Wait for the active resource action before changing node scheduling.'); return resources.cordon(input.clusterId, input.name, input.unschedulable); },
    'clusters:list': () => clusters.discover(), 'clusters:health': input => clusters.health(input.clusterId),
    'resources:get': input => resources.get(input),
    'resources:list': input => resources.list(input),
    'resources:watch': (input, owner) => {
      clusters.get(input.clusterId);
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
