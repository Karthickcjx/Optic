import { beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from '../src/renderer/src/api';
import { loadPaletteItems, matchItems, type PaletteItem } from '../src/renderer/src/CommandPalette';
vi.mock('../src/renderer/src/api', () => ({ request: vi.fn() }));

const named = (...names: [string, string?][]) => names.map(([name, namespace]) => ({ metadata: { name, namespace } }));
const app = { apiVersion: 'argoproj.io/v1alpha1', kind: 'Application', plural: 'applications', namespaced: true };
let clusterSeq = 0;
beforeEach(() => {
  vi.mocked(request).mockReset();
  vi.mocked(request).mockImplementation((async (channel: string, input: any) => {
    if (channel === 'gitops:detect') return { types: { applications: app }, unavailableGroups: [] };
    if (channel !== 'resources:list') throw new Error(channel);
    if (input.kind === 'secrets') return named(['db-password', 'team']);
    if (input.kind === 'configmaps') throw Object.assign(new Error('Forbidden'), { code: 'FORBIDDEN' });
    if (input.kind === 'pods') return named(['api-gateway-7d9', 'team'], ['web-api', 'team']);
    if (input.kind === 'custom') return named(['guestbook', 'argocd']);
    return [];
  }) as any);
});

describe('palette resource search', () => {
  it('lists each kind once, scoped to the namespace, and caches names for repeated searches', async () => {
    const cluster = `c${++clusterSeq}`;
    const first = await loadPaletteItems(cluster, 'team');
    expect(vi.mocked(request).mock.calls.filter(([c]) => c === 'resources:list').map(([, i]: any) => [i.kind, i.namespace])).toEqual(expect.arrayContaining([['namespaces', undefined], ['pods', 'team'], ['secrets', 'team'], ['custom', undefined]]));
    expect(first.items.map(i => `${i.label}:${i.name}`)).toEqual(expect.arrayContaining(['Pod:api-gateway-7d9', 'Secret:db-password', 'Application:guestbook']));
    expect(first.failed).toEqual(['ConfigMaps']);
    const calls = vi.mocked(request).mock.calls.length;
    await loadPaletteItems(cluster, 'team');
    expect(vi.mocked(request).mock.calls.length).toBe(calls);
    await loadPaletteItems(cluster, 'other');
    expect(vi.mocked(request).mock.calls.length).toBeGreaterThan(calls);
  });
  it('keeps names only, never object contents (Secrets included)', async () => {
    vi.mocked(request).mockImplementation((async (channel: string, input: any) => channel === 'gitops:detect' ? { types: {} } : input.kind === 'secrets' ? [{ metadata: { name: 's', namespace: 'n' }, data: { password: 'aGk=' } }] : []) as any);
    const { items } = await loadPaletteItems(`c${++clusterSeq}`, 'n');
    expect(JSON.stringify(items)).not.toContain('aGk=');
    expect(items).toEqual([{ kind: 'secrets', label: 'Secret', name: 's', namespace: 'n', custom: undefined }]);
  });
  it('ranks prefix matches first, needs two characters and limits results', () => {
    const items: PaletteItem[] = ['web-api', 'api-gateway', 'api', 'rapid'].map(name => ({ kind: 'pods', label: 'Pod', name }));
    expect(matchItems(items, 'a')).toEqual([]);
    expect(matchItems(items, 'API').map(i => i.name)).toEqual(['api', 'api-gateway', 'rapid', 'web-api']);
    expect(matchItems(Array.from({ length: 100 }, (_, i) => ({ kind: 'pods' as const, label: 'Pod', name: `pod-${i}` })), 'pod', 10)).toHaveLength(10);
  });
});
