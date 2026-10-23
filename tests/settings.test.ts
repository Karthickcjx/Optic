import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KubeConfig } from '@kubernetes/client-node';
import { ClusterManager } from '../src/main/clusters';
import { ClusterSettingsStore, clusterSettingsSchema } from '../src/main/cluster-settings';
import { defaultClusterSettings } from '../src/shared/cluster-settings';
import { schemas } from '../src/main/validation';
it('rejects credential-bearing proxies, invalid shell images and unpinned installs', () => {
  for (const proxyUrl of ['file:///config', 'http://user:secret@proxy:8080', 'http://proxy/path']) expect(clusterSettingsSchema.safeParse({ ...defaultClusterSettings, proxyUrl }).success).toBe(false);
  expect(clusterSettingsSchema.safeParse({ ...defaultClusterSettings, proxyUrl: 'http://localhost:8080' }).success).toBe(true);
  expect(clusterSettingsSchema.safeParse({ ...defaultClusterSettings, nodeShellImage: 'alpine;curl x' }).success).toBe(false);
  expect(schemas['monitoring:apply'].safeParse({ clusterId: 'c', changes: [{ component: 'prometheus', action: 'install', version: '' }] }).success).toBe(false);
});
it('persists isolated settings, injects proxy/namespace into temporary CLI config and preserves original', () => {
  const directory = mkdtempSync(join(tmpdir(), 'optic-settings-test-'));
  try {
    const path = join(directory, 'config'), sources = join(directory, 'sources.json');
    const original = 'apiVersion: v1\nkind: Config\nclusters:\n- name: cluster\n  cluster: {server: "https://localhost:6443"}\nusers:\n- name: user\n  user: {}\ncontexts:\n- name: first\n  context: {cluster: cluster, user: user}\n- name: second\n  context: {cluster: cluster, user: user}\ncurrent-context: first\n';
    writeFileSync(path, original);
    const manager = new ClusterManager([path], sources); const { clusters } = manager.discover();
    const first = clusters.find(c => c.name === 'first')!.id, second = clusters.find(c => c.name === 'second')!.id;
    manager.saveSettings(first, { ...defaultClusterSettings, proxyUrl: 'http://localhost:8888', defaultNamespace: 'team-a', terminalCwd: directory });
    expect(manager.get(first).config.getCurrentCluster()?.proxyUrl).toBe('http://localhost:8888');
    expect(manager.get(second).config.getCurrentCluster()?.proxyUrl).toBeUndefined();
    const lease = manager.cliConfig(first); const config = new KubeConfig(); config.loadFromFile(lease.path);
    expect(config.getCurrentCluster()?.proxyUrl).toBe('http://localhost:8888');
    expect(config.getContextObject('first')?.namespace).toBe('team-a');
    expect(config.getCurrentContext()).toBe('first'); lease.cleanup(); expect(existsSync(lease.path)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(original);
    const reloaded = new ClusterSettingsStore(join(directory, 'cluster-settings.json')); expect(reloaded.get(first).defaultNamespace).toBe('team-a');
    manager.disconnect(first); expect(() => manager.get(first)).toThrow('disconnected'); expect(manager.settings(first).defaultNamespace).toBe('team-a');
    expect(manager.discover().clusters.find(c => c.id === first)?.connected).toBe(false);
    expect(() => manager.get(second)).not.toThrow();
    expect(() => manager.saveSettings(second, { ...defaultClusterSettings, terminalCwd: join(directory, 'missing') })).toThrow('directory');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
