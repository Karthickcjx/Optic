import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { ClusterManager } from '../src/main/clusters';
import { kubeconfigChain, mergeKubeconfigs } from '../src/main/kubeconfig-merge';

let dir: string, a: string, b: string, c: string, broken: string, missing: string;
const doc = (body: string) => `apiVersion: v1\nkind: Config\n${body}`;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'optic-merge-'));
  mkdirSync(join(dir, 'b', 'certs'), { recursive: true });
  // A: contexts only (split config); current-context set; dev references cluster and user defined in B.
  a = join(dir, 'a.yaml'); writeFileSync(a, doc(`current-context: dev\ncontexts:\n- name: dev\n  context: { cluster: shared, user: alice, namespace: team }\n- name: anon\n  context: { cluster: shared, user: nobody }\n`));
  // B: cluster and user with relative file references, a duplicate "dev" context and its own current-context.
  b = join(dir, 'b', 'b.yaml'); writeFileSync(b, doc(`current-context: prod\nclusters:\n- name: shared\n  cluster: { server: "https://shared.example:6443", certificate-authority: certs/ca.crt }\n- name: prod\n  cluster: { server: "https://prod.example:6443", insecure-skip-tls-verify: true }\nusers:\n- name: alice\n  user: { client-certificate: certs/alice.crt, client-key: certs/alice.key }\n- name: bob\n  user: { token-file: certs/token, exec: null }\n- name: plugin\n  user:\n    exec: { apiVersion: client.authentication.k8s.io/v1, command: ./bin/get-token, args: [x] }\ncontexts:\n- name: dev\n  context: { cluster: prod, user: bob }\n- name: prod\n  context: { cluster: prod, user: bob }\n- name: plugin\n  context: { cluster: prod, user: plugin }\n`));
  writeFileSync(join(dir, 'b', 'certs', 'token'), 'secret-token-value');
  for (const name of ['ca.crt', 'alice.crt', 'alice.key']) writeFileSync(join(dir, 'b', 'certs', name), `content of ${name}`);
  // C: redefines "shared" (must lose to B) and adds its own context.
  c = join(dir, 'c.yaml'); writeFileSync(c, doc(`clusters:\n- name: shared\n  cluster: { server: "https://evil.example" }\nusers:\n- name: carol\n  user: { token: carol-token }\ncontexts:\n- name: carol\n  context: { cluster: shared, user: carol }\n`));
  broken = join(dir, 'broken.yaml'); writeFileSync(broken, 'apiVersion: v1\nkind: Config\ncontexts: [\n');
  missing = join(dir, 'missing.yaml');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('kubectl-compatible merging', () => {
  it('merges split files with first-definition-wins precedence', () => {
    const merged = mergeKubeconfigs([a, missing, b, c]);
    expect(merged.currentContext).toBe('dev');
    const byName = Object.fromEntries(merged.contexts.map(m => [m.name, m]));
    expect(Object.keys(byName)).toEqual(['dev', 'anon', 'prod', 'plugin', 'carol']);
    expect(byName.dev).toMatchObject({ file: a, context: { cluster: 'shared', user: 'alice', namespace: 'team' }, cluster: { server: 'https://shared.example:6443' }, user: { name: 'alice' } });
    expect(byName.carol.cluster?.server).toBe('https://shared.example:6443');
    expect(byName.anon.user).toBeUndefined();
    expect(byName.prod.file).toBe(b);
  });
  it('resolves relative references against the file that declares them', () => {
    const byName = Object.fromEntries(mergeKubeconfigs([a, b]).contexts.map(m => [m.name, m]));
    expect(byName.dev.cluster?.caFile).toBe(resolve(dir, 'b', 'certs', 'ca.crt'));
    expect(byName.dev.user).toMatchObject({ certFile: resolve(dir, 'b', 'certs', 'alice.crt'), keyFile: resolve(dir, 'b', 'certs', 'alice.key') });
    expect(byName.prod.user?.token).toBe('secret-token-value');
    expect((byName.plugin.user as any).exec.command).toBe(resolve(dir, 'b', 'bin', 'get-token'));
  });
  it('skips malformed and missing files with a warning that names no credentials', () => {
    const merged = mergeKubeconfigs([broken, missing, b]);
    expect(merged.contexts.map(m => m.name)).toEqual(['dev', 'prod', 'plugin']);
    expect(merged.warnings).toEqual([`Could not load kubeconfig: ${broken}`]);
    expect(JSON.stringify(merged.warnings)).not.toMatch(/secret-token-value|carol-token/);
  });
  it('reads the KUBECONFIG list instead of ~/.kube/config, like kubectl', () => {
    expect(kubeconfigChain({ KUBECONFIG: [a, '', b, a].join(delimiter) })).toEqual([a, b]);
    expect(kubeconfigChain({})).toEqual([resolve(homedir(), '.kube', 'config')]);
    expect(kubeconfigChain({ KUBECONFIG: a, WORKBENCH_KUBECONFIG: b })).toEqual([b]);
  });
});

describe('ClusterManager with merged kubeconfigs', () => {
  it('lists merged contexts with stable ids, isolated configs and warnings', () => {
    const manager = new ClusterManager([a, missing, b, c, broken]);
    const { clusters, warnings } = manager.discover();
    expect(clusters.map(x => x.name)).toEqual(['dev', 'anon', 'prod', 'plugin', 'carol']);
    const dev = clusters.find(x => x.name === 'dev')!;
    expect(dev).toMatchObject({ id: createHash('sha256').update(`${a}\0dev`).digest('hex').slice(0, 24), source: a, server: 'https://shared.example:6443', namespace: 'team' });
    expect(warnings).toEqual(expect.arrayContaining([`Could not load kubeconfig: ${broken}`, 'Context anon references a missing user; it connects without credentials.']));
    const { config } = manager.get(dev.id);
    expect(config.getContexts().map(x => x.name)).toEqual(['dev']); expect(config.getUsers().map(u => u.name)).toEqual(['alice']);
    const lease = manager.cliConfig(dev.id);
    try { const exported = readFileSync(lease.path, 'utf8'); expect(exported).toContain('alice.crt'); expect(exported).not.toMatch(/carol-token|secret-token-value/); } finally { lease.cleanup(); }
  });
  it('keeps kubeconfigs imported into Optic isolated from the KUBECONFIG chain', () => {
    const settings = join(dir, 'sources.json'); writeFileSync(settings, JSON.stringify([c]));
    const manager = new ClusterManager([a, b], settings);
    const carol = manager.discover().clusters.find(x => x.name === 'carol')!;
    // Imported on its own, C's "shared" cluster is its own definition.
    expect(carol).toMatchObject({ source: c, server: 'https://evil.example' });
  });
});

// Same files through the real kubectl, when it is installed.
const kubectl = (() => { try { execFileSync('kubectl', ['version', '--client'], { stdio: 'ignore' }); return true; } catch { return false; } })();
describe.skipIf(!kubectl)('agreement with kubectl', () => {
  const run = (...args: string[]) => execFileSync('kubectl', args, { encoding: 'utf8', env: { ...process.env, KUBECONFIG: [a, missing, b, c].join(delimiter) } });
  it('matches kubectl config view and get-contexts', () => {
    const view = JSON.parse(run('config', 'view', '--raw', '-o', 'json'));
    const merged = mergeKubeconfigs([a, missing, b, c]);
    expect(view['current-context']).toBe(merged.currentContext);
    expect(view.contexts.map((x: any) => x.name).sort()).toEqual(merged.contexts.map(m => m.name).sort());
    for (const m of merged.contexts) {
      const k = view.contexts.find((x: any) => x.name === m.name).context;
      expect({ cluster: k.cluster, user: k.user, namespace: k.namespace }).toEqual({ cluster: m.context.cluster, user: m.context.user, namespace: m.context.namespace });
      const cluster = view.clusters.find((x: any) => x.name === m.context.cluster)?.cluster;
      expect(cluster?.server).toBe(m.cluster?.server);
    }
    // config view prints paths as written; --flatten embeds the files kubectl resolved, which must be the ones Optic resolved.
    const flat = JSON.parse(run('config', 'view', '--raw', '--flatten', '-o', 'json'));
    const decode = (v: string) => Buffer.from(v, 'base64').toString('utf8');
    const dev = merged.contexts.find(m => m.name === 'dev')!;
    expect(decode(flat.clusters.find((x: any) => x.name === 'shared').cluster['certificate-authority-data'])).toBe(readFileSync(dev.cluster!.caFile!, 'utf8'));
    const alice = flat.users.find((u: any) => u.name === 'alice').user;
    expect(decode(alice['client-certificate-data'])).toBe(readFileSync(dev.user!.certFile!, 'utf8'));
    expect(decode(alice['client-key-data'])).toBe(readFileSync(dev.user!.keyFile!, 'utf8'));
    const names = run('config', 'get-contexts', '-o', 'name').trim().split(/\r?\n/).sort();
    expect(names).toEqual(merged.contexts.map(m => m.name).sort());
  });
});
