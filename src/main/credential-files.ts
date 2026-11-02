import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { uptime } from 'node:os';

// Credential-bearing files Optic writes, and the only names its cleanup will ever touch:
// - <profile>/sessions/session-XXXXXX/{config,.owner}: per-session kubeconfigs, owned by the PID in .owner.
// - <tmp>/optic-<purpose>-XXXXXX: older session kubeconfigs and staging folders (charts, manifests, Helm values).
// - <profile>/kubeconfig-backups/<hash>-<file>.<time>.bak: copies of a kubeconfig before a context was removed.
const sessionName = /^session-[A-Za-z0-9]{6}$/;
const tempName = /^optic-(session|plan|import|fetch|dependencies|chart-helm|monitoring-helm)-[A-Za-z0-9]{6}$/;
const backupName = /^([0-9a-f]{12})-.+\.\d{8}T\d{6}Z-[0-9a-f]{8}\.bak$/;

export function createSessionDirectory(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(root, 'session-'));
  writeFileSync(join(directory, '.owner'), String(process.pid), { mode: 0o600 });
  return directory;
}

const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
// Only real directories that are direct children of root; symbolic links are never followed or removed.
const directories = (root: string, pattern: RegExp) => { try { return readdirSync(root).filter(n => pattern.test(n)).filter(n => { const s = lstatSync(join(root, n)); return s.isDirectory() && !s.isSymbolicLink(); }); } catch { return []; } };

// Removes credential files that cannot still be in use: sessions whose owning process has exited, and anything created
// before the machine last booted (no process from before a reboot can be using it). Returns the removed paths.
export function sweepStaleCredentialFiles(options: { sessionsRoot?: string; tempRoot?: string; bootTime?: number; alive?: (pid: number) => boolean }) {
  const bootTime = options.bootTime ?? Date.now() - uptime() * 1000, alive = options.alive ?? pidAlive, removed: string[] = [];
  const beforeBoot = (path: string) => lstatSync(path).mtimeMs < bootTime - 60_000;
  const remove = (path: string) => { try { rmSync(path, { recursive: true, force: true, maxRetries: 2 }); removed.push(path); } catch { /* retried at the next start */ } };
  if (options.sessionsRoot) for (const name of directories(options.sessionsRoot, sessionName)) {
    const path = join(options.sessionsRoot, name);
    let pid = NaN; try { pid = Number.parseInt(readFileSync(join(path, '.owner'), 'utf8'), 10); } catch { /* no owner recorded */ }
    if (pid === process.pid) continue;
    if ((Number.isInteger(pid) && pid > 0 && !alive(pid)) || beforeBoot(path)) remove(path);
  }
  if (options.tempRoot) for (const name of directories(options.tempRoot, tempName)) { const path = join(options.tempRoot, name); if (beforeBoot(path)) remove(path); }
  return removed;
}

// Writes a backup of a kubeconfig into Optic's profile and keeps only the newest `keep` backups of that same file.
export function writeKubeconfigBackup(root: string, source: string, contents: string, keep = 5, now = new Date()) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const key = createHash('sha256').update(source).digest('hex').slice(0, 12);
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const path = join(root, `${key}-${basename(source)}.${stamp}-${randomUUID().slice(0, 8)}.bak`);
  writeFileSync(path, contents, { mode: 0o600, flag: 'wx' });
  const own = readdirSync(root).filter(n => backupName.exec(n)?.[1] === key).filter(n => lstatSync(join(root, n)).isFile()).sort();
  for (const old of own.slice(0, Math.max(0, own.length - keep))) rmSync(join(root, old), { force: true });
  return path;
}
