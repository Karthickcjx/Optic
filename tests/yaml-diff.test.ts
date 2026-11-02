import { describe, expect, it, vi } from 'vitest';
import { diffLines, diffSegments, type DiffLine } from '../src/shared/yaml-diff';
import { ResourceService } from '../src/main/resources';
import { fault } from '../src/main/errors';
import { schemas } from '../src/main/validation';
import { kubeJson } from '../src/main/kube-http';
vi.mock('../src/main/kube-http', () => ({ kubeJson: vi.fn(async () => ({})) }));

const side = (lines: DiffLine[], type: 'add' | 'remove') => lines.filter(l => l.type !== type).map(l => l.text).join('\n');
// Reference LCS length, used to check the Myers diff is minimal.
const lcs = (a: string[], b: string[]) => { const t = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0)); for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) t[i][j] = a[i - 1] === b[j - 1] ? t[i - 1][j - 1] + 1 : Math.max(t[i - 1][j], t[i][j - 1]); return t[a.length][b.length]; };

describe('YAML line diff', () => {
  it('marks added, removed and unchanged lines with old and new line numbers', () => {
    const lines = diffLines('a: 1\nb: 2\nc: 3', 'a: 1\nb: 5\nc: 3\nd: 4')!;
    expect(lines).toEqual([
      { type: 'same', text: 'a: 1', oldLine: 1, newLine: 1 },
      { type: 'remove', text: 'b: 2', oldLine: 2 },
      { type: 'add', text: 'b: 5', newLine: 2 },
      { type: 'same', text: 'c: 3', oldLine: 3, newLine: 3 },
      { type: 'add', text: 'd: 4', newLine: 4 }
    ]);
    expect(diffLines('x', 'x')!.every(l => l.type === 'same')).toBe(true);
    expect(diffLines('', 'a')).toEqual([{ type: 'remove', text: '', oldLine: 1 }, { type: 'add', text: 'a', newLine: 1 }]);
  });
  it('reconstructs both versions and is minimal for random edits', () => {
    let seed = 7; const rand = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    for (let run = 0; run < 300; run++) {
      const a = Array.from({ length: rand(25) }, () => `k${rand(6)}`), b = a.filter(() => rand(4) > 0).flatMap(l => rand(5) ? [l] : [l, `n${rand(6)}`]);
      const lines = diffLines(a.join('\n'), b.join('\n'))!;
      expect(side(lines, 'add')).toBe(a.join('\n')); expect(side(lines, 'remove')).toBe(b.join('\n'));
      expect(lines.filter(l => l.type === 'same').length).toBe(lcs(a.join('\n').split('\n'), b.join('\n').split('\n')));
    }
  });
  it('gives up beyond the edit limit instead of doing unbounded work', () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`).join('\n'), b = Array.from({ length: 50 }, (_, i) => `b${i}`).join('\n');
    expect(diffLines(a, b, 20)).toBeUndefined();
    expect(diffLines(a, b)).toHaveLength(100);
  });
  it('collapses long unchanged runs around changes', () => {
    const before = Array.from({ length: 30 }, (_, i) => `l${i}`), after = [...before]; after[15] = 'changed';
    const segments = diffSegments(diffLines(before.join('\n'), after.join('\n'))!, 3);
    expect(segments.map(s => 'skipped' in s ? s.skipped : s.lines.length)).toEqual([12, 8, 11]);
  });
});

describe('YAML replace dry run', () => {
  const service = new ResourceService({ get: () => ({ config: {} }) } as any);
  const target = { clusterId: 'c', kind: 'configmaps' as const, namespace: 'default', name: 'app' };
  const yaml = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\n  namespace: default\n  resourceVersion: "4"\ndata:\n  a: b\n';
  it('validates with dryRun=All and saves without it', async () => {
    await service.replace(target, yaml, true); await service.replace(target, yaml);
    expect(vi.mocked(kubeJson).mock.calls.map(([, path, options]) => [path, options?.method])).toEqual([
      ['/api/v1/namespaces/default/configmaps/app?dryRun=All', 'PUT'], ['/api/v1/namespaces/default/configmaps/app', 'PUT']]);
  });
  it('reports invalid YAML with its line and never contacts the cluster', async () => {
    vi.mocked(kubeJson).mockClear();
    const result = await service.replace(target, 'metadata:\n  name: [app\n').then(() => undefined, fault);
    expect(result).toMatchObject({ code: 'INVALID_RESOURCE' }); expect(result?.message).toMatch(/line \d+/);
    expect(kubeJson).not.toHaveBeenCalled();
  });
  it('accepts dryRun only as an optional boolean at the IPC boundary', () => {
    expect(schemas['resources:replace'].safeParse({ ...target, yaml, dryRun: true }).success).toBe(true);
    expect(schemas['resources:replace'].safeParse({ ...target, yaml }).success).toBe(true);
    expect(schemas['resources:replace'].safeParse({ ...target, yaml, dryRun: 'yes' }).success).toBe(false);
  });
});
