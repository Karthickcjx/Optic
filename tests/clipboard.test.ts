import { it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClusterManager } from '../src/main/clusters';
const config = 'apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster: {server: "https://localhost:6443"}\nusers:\n- name: u\n  user: {}\ncontexts:\n- name: pasted\n  context: {cluster: c, user: u}\ncurrent-context: pasted\n';
it('persists clipboard contexts, deduplicates imports and restores them after restart', () => {
 const dir = mkdtempSync(join(tmpdir(), 'optic-clipboard-test-'));
 try {
  const sources = join(dir, 'sources.json'), manager = new ClusterManager([], sources);
  const result = manager.importClipboard(config);
  expect(result.clusters[0].name).toBe('pasted');
  expect(readFileSync(result.clusters[0].source, 'utf8')).toBe(config);
  manager.importClipboard(config);
  expect(readdirSync(join(dir, 'kubeconfigs'))).toHaveLength(1);
  expect(new ClusterManager([], sources).discover().clusters).toHaveLength(1);
 } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('rejects empty, malformed, oversized and relative-path clipboard configs without leaking contents', () => {
 const manager = new ClusterManager([], 'unused');
 expect(() => manager.importClipboard('')).toThrow('empty');
 expect(() => manager.importClipboard('private-value')).toThrow('valid v1 kubeconfig');
 expect(() => manager.importClipboard('x'.repeat(8_000_001))).toThrow('8 MB');
 expect(() => manager.importClipboard(config.replace('user: {}', 'user: {client-key: relative.key}'))).toThrow('absolute');
 expect(() => manager.importClipboard(config.replace('cluster: c, user: u', 'cluster: missing, user: u'))).toThrow('context references');
});
