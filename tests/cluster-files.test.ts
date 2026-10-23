import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ClusterManager } from '../src/main/clusters';
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
