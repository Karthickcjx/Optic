import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClusterManager } from '../src/main/clusters';
import { createSessionDirectory, sweepStaleCredentialFiles, writeKubeconfigBackup } from '../src/main/credential-files';

let root: string;
const boot = Date.now() - 3600e3;
const old = (path: string) => { const t = new Date(boot - 86400e3); utimesSync(path, t, t); };
const session = (dir: string, name: string, owner?: string) => { const path = join(dir, name); mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'config'), 'token: secret'); if (owner !== undefined) writeFileSync(join(path, '.owner'), owner); return path; };
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'optic-cred-test-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('stale credential cleanup', () => {
  it('removes sessions of exited processes and pre-boot leftovers, and nothing that may be in use', () => {
    const sessions = join(root, 'sessions');
    const dead = session(sessions, 'session-dead01', '424242'), live = session(sessions, 'session-live01', '515151'), mine = session(sessions, 'session-mine01', String(process.pid));
    const ownerless = session(sessions, 'session-nownr1'), ownerlessOld = session(sessions, 'session-nownr2'); old(ownerlessOld);
    const liveButOld = session(sessions, 'session-oldliv', '515151'); old(liveButOld);
    const removed = sweepStaleCredentialFiles({ sessionsRoot: sessions, bootTime: boot, alive: pid => pid === 515151 });
    expect(removed.sort()).toEqual([dead, liveButOld, ownerlessOld].sort());
    for (const kept of [live, mine, ownerless]) expect(readFileSync(join(kept, 'config'), 'utf8')).toBe('token: secret');
  });
  it('only removes Optic-named folders in the temp directory, and only if created before boot', () => {
    const temp = join(root, 'tmp'); mkdirSync(temp);
    const stale = session(temp, 'optic-session-AbC123'); old(stale);
    const staging = session(temp, 'optic-plan-x1Y2z3'); old(staging);
    const recent = session(temp, 'optic-session-recent');
    const lookalike = session(temp, 'optic-session-toolong1'); old(lookalike);
    const user = join(temp, 'my-kubeconfig'); writeFileSync(user, 'user credentials'); old(user);
    const removed = sweepStaleCredentialFiles({ tempRoot: temp, bootTime: boot });
    expect(removed.sort()).toEqual([stale, staging].sort());
    expect(existsSync(recent)).toBe(true); expect(existsSync(lookalike)).toBe(true); expect(readFileSync(user, 'utf8')).toBe('user credentials');
  });
  it('never follows or removes symbolic links, even when they match', () => {
    const temp = join(root, 'tmp'), target = join(root, 'precious'); mkdirSync(temp); mkdirSync(target); writeFileSync(join(target, 'kubeconfig'), 'keep me');
    const link = join(temp, 'optic-session-L1nk00'); symlinkSync(target, link, 'junction');
    const sessions = join(root, 'sessions'); mkdirSync(sessions); symlinkSync(target, join(sessions, 'session-L1nk00'), 'junction');
    expect(sweepStaleCredentialFiles({ tempRoot: temp, sessionsRoot: sessions, bootTime: Date.now() + 86400e3, alive: () => false })).toEqual([]);
    expect(readFileSync(join(target, 'kubeconfig'), 'utf8')).toBe('keep me'); expect(existsSync(link)).toBe(true);
  });
  it('tolerates missing directories', () => {
    expect(sweepStaleCredentialFiles({ tempRoot: join(root, 'absent'), sessionsRoot: join(root, 'absent2') })).toEqual([]);
  });
});

describe('kubeconfig backups', () => {
  it('keeps the five newest backups of a file and never touches other files', () => {
    const backups = join(root, 'backups'); mkdirSync(backups);
    writeFileSync(join(backups, 'notes.txt'), 'mine');
    const other = writeKubeconfigBackup(backups, '/home/u/.kube/other', 'other file', 5, new Date('2026-01-01T00:00:00Z'));
    const made = Array.from({ length: 7 }, (_, i) => writeKubeconfigBackup(backups, '/home/u/.kube/config', `version ${i}`, 5, new Date(Date.UTC(2026, 0, 1, 0, i))));
    expect(made.slice(2).every(existsSync)).toBe(true); expect(made.slice(0, 2).some(existsSync)).toBe(false);
    expect(readFileSync(made[6], 'utf8')).toBe('version 6');
    expect(existsSync(other)).toBe(true); expect(readFileSync(join(backups, 'notes.txt'), 'utf8')).toBe('mine');
    expect(readdirSync(backups)).toHaveLength(7);
  });
});

describe('ClusterManager credential files', () => {
  const kubeconfig = (dir: string) => { const path = join(dir, 'config'); writeFileSync(path, 'apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster: { server: "https://api.example:6443" }\nusers:\n- name: u\n  user: { token: original-secret }\ncontexts:\n- name: one\n  context: { cluster: c, user: u }\n- name: two\n  context: { cluster: c, user: u }\n'); return path; };
  it('writes session kubeconfigs into the profile with an owner, and removes them on cleanup', () => {
    const profile = join(root, 'profile'), manager = new ClusterManager([kubeconfig(root)], join(profile, 'kubeconfig-sources.json'));
    const lease = manager.cliConfig(manager.discover().clusters[0].id);
    expect(lease.path.startsWith(join(profile, 'sessions'))).toBe(true);
    expect(readFileSync(join(lease.path, '..', '.owner'), 'utf8')).toBe(String(process.pid));
    expect(readFileSync(lease.path, 'utf8')).toContain('original-secret');
    expect(manager.sweepStaleFiles()).toBe(0); expect(existsSync(lease.path)).toBe(true); // own, in-use session survives
    lease.cleanup(); expect(existsSync(join(lease.path, '..'))).toBe(false);
  });
  it('cleans up a crashed session at the next start without touching the original kubeconfig', () => {
    const profile = join(root, 'profile'), source = kubeconfig(root), original = readFileSync(source, 'utf8');
    const crashed = createSessionDirectory(join(profile, 'sessions')); writeFileSync(join(crashed, 'config'), 'leaked'); writeFileSync(join(crashed, '.owner'), '2147483646');
    const manager = new ClusterManager([source], join(profile, 'kubeconfig-sources.json'));
    expect(manager.sweepStaleFiles()).toBeGreaterThanOrEqual(1);
    expect(existsSync(crashed)).toBe(false); expect(readFileSync(source, 'utf8')).toBe(original);
  });
  it('backs up into the profile before removing a context, keeping the original credentials intact in the backup', () => {
    const profile = join(root, 'profile'), source = kubeconfig(root), original = readFileSync(source, 'utf8');
    const manager = new ClusterManager([source], join(profile, 'kubeconfig-sources.json'));
    const result = manager.removeContext(manager.discover().clusters.find(c => c.name === 'one')!.id);
    expect(result.backup.startsWith(join(profile, 'kubeconfig-backups'))).toBe(true);
    expect(readFileSync(result.backup, 'utf8')).toBe(original);
    const updated = readFileSync(source, 'utf8');
    expect(updated).not.toContain('name: one'); expect(updated).toContain('original-secret'); expect(updated).toContain('name: two');
    expect(readdirSync(root).filter(n => n.endsWith('.bak'))).toEqual([]);
  });
});
