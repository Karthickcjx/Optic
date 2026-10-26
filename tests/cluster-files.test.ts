import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { ClusterManager } from '../src/main/clusters';
it('persists multiple files with identical context and user names without mixing credentials or CLI targets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'optic-multiple-configs-'));
  try {
    const settings = join(directory, 'sources.json');
    const paths = ['development', 'production'].map(name => join(directory, `${name}.yaml`));
    const originals = paths.map((path, index) => {
      const source = stringify({ apiVersion: 'v1', kind: 'Config', clusters: [{ name: 'shared', cluster: { server: `https://cluster-${index}.example.test` } }], users: [{ name: 'admin', user: { token: `fixture-token-${index}` } }], contexts: [{ name: 'default', context: { cluster: 'shared', user: 'admin', namespace: `team-${index}` } }], 'current-context': 'default' });
      writeFileSync(path, source); return source;
    });
    const manager = new ClusterManager([], settings);
    const imported = manager.addPaths(paths).clusters;
    expect(imported).toHaveLength(2);
    expect(new Set(imported.map(c => c.id)).size).toBe(2);
    expect(manager.addPaths(paths).clusters).toHaveLength(2);
    const restored = new ClusterManager([], settings);
    expect(restored.discover().clusters.map(c => c.id)).toEqual(imported.map(c => c.id));
    imported.forEach((cluster, index) => {
      expect(restored.get(cluster.id).config.getCurrentUser()?.token).toBe(`fixture-token-${index}`);
      const lease = restored.cliConfig(cluster.id);
      try {
        const isolated = parse(readFileSync(lease.path, 'utf8'));
        expect(isolated.clusters).toHaveLength(1);
        expect(isolated.clusters[0].cluster.server).toBe(`https://cluster-${index}.example.test`);
        expect(isolated.users[0].user.token).toBe(`fixture-token-${index}`);
        expect(isolated.contexts[0].context.namespace).toBe(`team-${index}`);
      } finally { lease.cleanup(); }
      expect(readFileSync(paths[index], 'utf8')).toBe(originals[index]);
    });
    restored.disconnect(imported[0].id);
    expect(() => restored.get(imported[0].id)).toThrow('Cluster is disconnected');
    expect(restored.get(imported[1].id).cluster.connected).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
it('backs up kubeconfig and removes only the chosen context, preserving shared credentials', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-config-test-'));
  try {
    const path = join(directory, 'config');
    const original = '# retain this comment\napiVersion: v1\nkind: Config\nclusters:\n- name: shared\n  cluster:\n    server: https://localhost:6443\nusers:\n- name: shared\n  user: {}\ncontexts:\n- name: first\n  context: {cluster: shared, user: shared}\n- name: second\n  context: {cluster: shared, user: shared}\ncurrent-context: first\n';
    writeFileSync(path, original);
    const manager = new ClusterManager([path]); const { clusters } = manager.discover();
    const result = manager.removeContext(clusters.find(c => c.name === 'first')!.id);
    expect(readFileSync(result.backup, 'utf8')).toBe(original);
    const edited = readFileSync(path, 'utf8'), document = parse(edited);
    expect(edited).toContain('# retain this comment');
    expect(document.contexts.map((c: any) => c.name)).toEqual(['second']);
    expect(document.clusters).toHaveLength(1); expect(document.users).toHaveLength(1);
    expect(document['current-context']).toBe('');
    expect(result.clusters.map(c => c.name)).toEqual(['second']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
