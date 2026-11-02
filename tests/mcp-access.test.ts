import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KubeConfig } from '@kubernetes/client-node';
import { accessPath, authOf, fingerprint, readAccess } from '../src/mcp/access';
import { runMcp } from '../src/mcp/server';
import { redactResource, redactText } from '../src/shared/redaction';

const config = (user: object, server = 'https://api.example:6443', ca = 'Q0E=') => { const c = new KubeConfig(); c.loadFromOptions({ clusters: [{ name: 'c', server, caData: ca, skipTLSVerify: false }], users: [{ name: 'u', ...user }], contexts: [{ name: 'ctx', cluster: 'c', user: 'u' }], currentContext: 'ctx' }); return c; };
const exec = (command: string, args = ['eks', 'get-token']) => ({ exec: { apiVersion: 'client.authentication.k8s.io/v1beta1', command, args, env: [{ name: 'AWS_PROFILE', value: 'prod' }] } });

describe('approval fingerprints', () => {
  it('survive credential rotation but not a new server, CA or credential command', () => {
    const base = fingerprint(config({ token: 'one' }));
    expect(fingerprint(config({ token: 'two' }))).toBe(base);
    expect(fingerprint(config({ token: 'one' }, 'https://evil.example'))).not.toBe(base);
    expect(fingerprint(config({ token: 'one' }, undefined, 'T1RIRVI='))).not.toBe(base);
    expect(fingerprint(config(exec('aws')))).not.toBe(fingerprint(config(exec('/tmp/evil'))));
    expect(fingerprint(config(exec('aws')))).not.toBe(fingerprint(config(exec('aws', ['eks', 'get-token', '--role', 'admin']))));
  });
  it('describe authentication without credential values', () => {
    expect(authOf(config(exec('aws')))).toEqual({ type: 'exec', command: 'aws', args: ['eks', 'get-token'], env: ['AWS_PROFILE'] });
    expect(authOf(config({ token: 'secret' }))).toEqual({ type: 'token' });
    expect(authOf(config({ authProvider: { name: 'gcp', config: { 'cmd-path': 'gcloud', 'access-token': 'secret' } } }))).toEqual({ type: 'auth-provider', provider: 'gcp', command: 'gcloud' });
  });
});

describe('redaction', () => {
  it('removes Secret payloads but keeps their key names and type', () => {
    const secret = redactResource({ apiVersion: 'v1', kind: 'Secret', type: 'kubernetes.io/tls', metadata: { name: 's', annotations: { note: 'x' } }, data: { 'tls.key': 'AAAA' }, stringData: { extra: 'y' } });
    expect(secret).toEqual({ apiVersion: 'v1', kind: 'Secret', type: 'kubernetes.io/tls', metadata: { name: 's' }, dataKeys: ['tls.key', 'extra'] });
  });
  it('masks sensitive names, env values and credential text while keeping references', () => {
    const pod = redactResource({ kind: 'Pod', metadata: { managedFields: [{}], annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{}', 'vault.io/token': 'abc', owner: 'team' } }, spec: { containers: [{ env: [{ name: 'DB_PASSWORD', value: 'p' }, { name: 'MODE', value: 'm' }], args: ['--api-key=xyz', 'run'] }], volumes: [{ secret: { secretName: 'db' } }] } }) as any;
    expect(pod.metadata).toEqual({ annotations: { 'vault.io/token': '[redacted]', owner: 'team' } });
    expect(pod.spec.containers[0]).toEqual({ env: [{ name: 'DB_PASSWORD', value: '[redacted]' }, { name: 'MODE', value: 'm' }], args: ['--api-key=[redacted]', 'run'] });
    expect(pod.spec.volumes[0].secret.secretName).toBe('db');
  });
  it('redacts tokens, JWTs and private keys in free text', () => {
    const text = redactText('Authorization: Bearer abcdefghijkl\njwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2Q\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\npassword: "a b"\nok=1');
    expect(text).toBe('Authorization: Bearer [redacted]\njwt [redacted token]\n[redacted private key]\npassword: [redacted]\nok=1');
  });
});

describe('optic --mcp management commands', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), 'optic-mcp-cli-'));
    const kubeconfig = join(dir, 'config');
    writeFileSync(kubeconfig, 'apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster: { server: "https://api.example:6443" }\nusers:\n- name: u\n  user: { token: secret-value }\ncontexts:\n- name: prod\n  context: { cluster: c, user: u }\ncurrent-context: prod\n');
    writeFileSync(join(dir, 'kubeconfig-sources.json'), JSON.stringify([kubeconfig]));
    const out: string[] = [], err: string[] = [];
    const io = (interactive: boolean, answer = 'prod') => ({ out: (t: string) => out.push(t), err: (t: string) => err.push(t), interactive, ask: async () => answer });
    // ClusterManager also reads ~/.kube/config; WORKBENCH_KUBECONFIG pins discovery to the test files.
    process.env.WORKBENCH_KUBECONFIG = kubeconfig;
    return { out, err, io };
  };
  afterEach(() => { delete process.env.WORKBENCH_KUBECONFIG; });
  it('lists contexts with approval state and auth type, never credentials', async () => {
    const { out, io } = setup();
    expect(await runMcp(['--list'], dir, io(false))).toBe(0);
    expect(out.join('\n')).toMatch(/not approved\s+prod\s+\(token\)/); expect(out.join('\n')).not.toContain('secret-value');
  });
  it('approves only from an interactive terminal with the typed context name', async () => {
    const { err, io } = setup();
    expect(await runMcp(['--allow', 'prod'], dir, io(false))).toBe(1);
    expect(err.join()).toMatch(/interactive terminal/);
    expect(await runMcp(['--allow', 'prod'], dir, io(true, 'wrong'))).toBe(1);
    expect(Object.keys(readAccess(accessPath(dir)).clusters)).toHaveLength(0);
    expect(await runMcp(['--allow', 'prod'], dir, io(true))).toBe(0);
    const store = readAccess(accessPath(dir));
    expect(Object.values(store.clusters)).toEqual([expect.objectContaining({ context: 'prod' })]);
    expect(readFileSync(accessPath(dir), 'utf8')).not.toContain('secret-value');
  });
  it('revokes from any terminal and rejects unknown options', async () => {
    const { io } = setup();
    await runMcp(['--allow', 'prod'], dir, io(true));
    expect(await runMcp(['--revoke', 'prod'], dir, io(false))).toBe(0);
    expect(readAccess(accessPath(dir)).clusters).toEqual({});
    expect(await runMcp(['--revoke', 'prod'], dir, io(false))).toBe(1);
    await runMcp(['--allow', 'prod'], dir, io(true));
    expect(await runMcp(['--revoke-all'], dir, io(false))).toBe(0);
    expect(readAccess(accessPath(dir)).clusters).toEqual({});
    expect(await runMcp(['--write'], dir, io(false))).toBe(2);
  });
  it('treats a missing or corrupt approval file as no approvals', () => {
    setup();
    expect(readAccess(join(dir, 'absent.json')).clusters).toEqual({});
    writeFileSync(accessPath(dir), '{"version":1,"clusters":{"x":{"context":1}}}');
    expect(readAccess(accessPath(dir)).clusters).toEqual({});
  });
});
