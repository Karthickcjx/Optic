import { BrowserWindow, session } from 'electron';
import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Parser } from 'tar';
import { extensionManifestSchema, extensionPanelSchema, type ExtensionManifest, type ExtensionInfo, type ExtensionContext, type ExtensionReview } from '../shared/extensions';
import { AppError } from './errors';

interface Bundle { manifest: ExtensionManifest; code: string; digest: string; enabled: boolean }
const digest = (manifest: ExtensionManifest, code: string) => createHash('sha256').update(JSON.stringify(manifest)).update('\0').update(code).digest('hex');
export function readExtension(directory: string): Bundle {
  const read = (name: string, max: number) => { const path = join(directory, name), stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error('Invalid bundle file'); return readFileSync(path, 'utf8'); };
  const manifest = extensionManifestSchema.parse(JSON.parse(read('optic-extension.json', 20000)));
  const code = read('extension.js', 1_000_000);
  if (!code.trim()) throw new Error('Empty extension');
  return { manifest, code, digest: digest(manifest, code), enabled: false };
}
export async function readExtensionArchive(path: string): Promise<Bundle> {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000) throw new Error('Invalid package');
  const bytes = gunzipSync(readFileSync(path), { maxOutputLength: 2_000_000 });
  const files = new Map<string, string>();
  await new Promise<void>((resolve, reject) => {
    const parser = new Parser({ strict: true, onReadEntry(entry) {
      const name = entry.path.replace(/^package\//, '');
      if (entry.path.includes('..') || entry.path.includes('\\') || entry.path.startsWith('/') || !['File', 'Directory'].includes(entry.type)) { entry.resume(); parser.abort(new Error('Unsafe package entry')); return; }
      if (!['optic-extension.json', 'extension.js'].includes(name)) { entry.resume(); return; }
      if (files.has(name) || entry.type !== 'File' || entry.size > (name === 'extension.js' ? 1_000_000 : 20000)) { entry.resume(); parser.abort(new Error('Invalid package entry')); return; }
      files.set(name, ''); const chunks: Buffer[] = [];
      entry.on('data', chunk => chunks.push(Buffer.from(chunk)));
      entry.on('end', () => files.set(name, Buffer.concat(chunks).toString('utf8')));
    } });
    parser.on('error', reject); parser.on('end', resolve); parser.end(bytes);
  });
  const manifest = extensionManifestSchema.parse(JSON.parse(files.get('optic-extension.json') ?? 'null')), code = files.get('extension.js');
  if (!code?.trim()) throw new Error('Missing extension code');
  return { manifest, code, digest: digest(manifest, code), enabled: false };
}
export class Extensions {
  private bundles = new Map<string, Bundle>();
  private hosts = new Map<string, BrowserWindow>();
  private states = new Map<string, Pick<ExtensionInfo, 'status' | 'error'>>();
  private pending = new Map<string, { bundle: Bundle; owner: number; expires: number }>();
  private busy = new Set<string>();
  private safe = false;
  constructor(private directory: string) {
    mkdirSync(directory, { recursive: true });
    try { this.safe = JSON.parse(readFileSync(join(directory, 'safe-mode.json'), 'utf8')) === true; } catch {}
    for (const name of readdirSync(directory).filter(n => n.endsWith('.json'))) {
      try {
        const path = join(directory, name); if (lstatSync(path).size > 2_000_000) continue;
        const bundle = JSON.parse(readFileSync(path, 'utf8')) as Bundle;
        bundle.manifest = extensionManifestSchema.parse(bundle.manifest);
        if (name !== `${bundle.manifest.id}.json` || typeof bundle.code !== 'string' || bundle.code.length > 1_000_000 || digest(bundle.manifest, bundle.code) !== bundle.digest) continue;
        bundle.enabled = bundle.enabled === true; this.bundles.set(bundle.manifest.id, bundle);
      } catch { /* Invalid or modified bundles never execute. */ }
    }
  }
  list(): ExtensionInfo[] { return [...this.bundles.values()].map(b => ({ manifest: b.manifest, enabled: b.enabled, ...(this.states.get(b.manifest.id) ?? { status: 'disabled' as const }) })); }
  async start() { if (!this.safe) for (const bundle of this.bundles.values()) if (bundle.enabled && !this.safe) await this.enable(bundle.manifest.id, true).catch(() => {}); }
  safeMode() { return this.safe; }
  async setSafeMode(enabled: boolean) {
    const path = join(this.directory, 'safe-mode.json'); writeFileSync(`${path}.tmp`, JSON.stringify(enabled), { mode: 0o600 }); renameSync(`${path}.tmp`, path);
    this.safe = enabled;
    if (enabled) { for (const id of this.hosts.keys()) this.stop(id); for (const id of this.bundles.keys()) this.states.set(id, { status: 'disabled' }); }
    else await this.start();
    return this.safe;
  }
  async review(directory: string, owner: number, archive = false): Promise<ExtensionReview> {
    for (const [key, value] of this.pending) if (value.expires < Date.now() || value.owner === owner) this.pending.delete(key);
    if (this.pending.size >= 20) throw new AppError('EXTENSION_LIMIT', 'Close pending extension reviews and try again.');
    try { const bundle = archive ? await readExtensionArchive(directory) : readExtension(directory), token = randomUUID(); this.pending.set(token, { bundle, owner, expires: Date.now() + 600000 }); return { token, manifest: bundle.manifest, digest: bundle.digest, replacing: this.bundles.has(bundle.manifest.id) }; }
    catch { throw new AppError('EXTENSION_INVALID', 'Select a bundle with a valid optic-extension.json (API v1) and extension.js, at most 1 MB.'); }
  }
  install(token: string, owner: number) {
    const pending = this.pending.get(token);
    if (!pending || pending.owner !== owner || pending.expires < Date.now()) throw new AppError('EXTENSION_REVIEW', 'Choose and review the extension again.');
    const bundle = pending.bundle, id = bundle.manifest.id;
    if (this.bundles.get(id)?.enabled || this.busy.has(id)) throw new AppError('EXTENSION_BUSY', 'Disable this extension before replacing it.');
    if (!this.bundles.has(id) && this.bundles.size >= 50) throw new AppError('EXTENSION_LIMIT', 'Uninstall an extension before adding another (limit 50).');
    this.persist(bundle); this.bundles.set(id, bundle); this.states.set(id, { status: 'disabled' }); this.pending.delete(token); return this.list();
  }
  private persist(bundle: Bundle) { const path = join(this.directory, `${bundle.manifest.id}.json`); writeFileSync(`${path}.tmp`, JSON.stringify(bundle), { mode: 0o600 }); renameSync(`${path}.tmp`, path); }
  private get(id: string) { const bundle = this.bundles.get(id); if (!bundle) throw new AppError('EXTENSION_MISSING', 'Extension is no longer installed.'); return bundle; }
  private stop(id: string) { const host = this.hosts.get(id); this.hosts.delete(id); if (host && !host.isDestroyed()) host.destroy(); }
  private async bounded<T>(id: string, work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 5000); })]); }
    catch { this.stop(id); this.states.set(id, { status: 'failed', error: 'Extension stopped: it failed, returned invalid data, or exceeded the 5-second limit. Restart to retry.' }); throw new AppError('EXTENSION_FAILED', this.states.get(id)!.error!); }
    finally { clearTimeout(timer); }
  }
  async enable(id: string, enabled: boolean) {
    if (enabled && this.safe) throw new AppError('EXTENSION_SAFE_MODE', 'Turn off extension Safe Mode before enabling extensions.');
    const bundle = this.get(id);
    if (this.busy.has(id)) throw new AppError('EXTENSION_BUSY', 'Wait for the current extension operation.');
    if (enabled && this.hosts.size >= 10 && !this.hosts.has(id)) throw new AppError('EXTENSION_LIMIT', 'At most 10 extensions may run at once.');
    this.busy.add(id);
    try {
      this.stop(id); bundle.enabled = enabled; this.persist(bundle); this.states.set(id, { status: enabled ? 'starting' : 'disabled' });
      if (!enabled) return this.list();
      const isolated = session.fromPartition(`optic-extension-${randomUUID()}`, { cache: false });
      isolated.setPermissionRequestHandler((_w, _p, callback) => callback(false)); isolated.setPermissionCheckHandler(() => false);
      isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('data:text/html,') || details.resourceType !== 'mainFrame' }));
      isolated.on('will-download', event => event.preventDefault());
      const host = new BrowserWindow({ show: false, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false, disableDialogs: true, backgroundThrottling: false } });
      this.hosts.set(id, host);
      host.on('closed', () => { if (this.hosts.get(id) === host) { this.hosts.delete(id); this.states.set(id, { status: 'failed', error: 'Extension host closed. Restart to retry.' }); } });
      host.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      host.webContents.on('will-navigate', event => event.preventDefault());
      host.webContents.on('will-attach-webview', event => event.preventDefault());
      host.webContents.on('render-process-gone', () => { if (this.hosts.get(id) === host) { this.stop(id); this.states.set(id, { status: 'failed', error: 'Extension host exited. Restart to retry.' }); } });
      await this.bounded(id, (async () => {
        await host.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; connect-src \'none\'; frame-src \'none\'; form-action \'none\'">'));
        // WebRTC ICE traffic is not governed by Chromium's URL request filter.
        await host.webContents.executeJavaScript(`(() => { for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCIceTransport', 'RTCIceGatherer']) Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false }); })()`);
        const commands = bundle.manifest.commands.map(c => c.id);
        await host.webContents.executeJavaScript(`(() => { const handlers = new Map(); const allowed = ${JSON.stringify(commands)}; Object.defineProperty(globalThis, 'optic', { value: Object.freeze({ version: 1, registerCommand(id, fn) { if (!allowed.includes(id) || typeof fn !== 'function' || handlers.has(id)) throw Error('Invalid command'); handlers.set(id, fn); } }) }); Object.defineProperty(globalThis, '__opticReady', { value: () => handlers.size === allowed.length }); Object.defineProperty(globalThis, '__opticRun', { value: async (id, context) => { const fn = handlers.get(id); if (!fn) throw Error('Missing command'); const text = JSON.stringify(await fn(Object.freeze(context))); if (typeof text !== 'string' || text.length > 250000) throw Error('Invalid result'); return text; } }); })()`);
        await host.webContents.executeJavaScript(`void (() => { "use strict";\n${bundle.code}\n})()`);
        if (!await host.webContents.executeJavaScript('globalThis.__opticReady()')) throw new Error('Missing command registrations');
      })());
      this.states.set(id, { status: 'running' }); return this.list();
    } finally { this.busy.delete(id); }
  }
  async run(id: string, command: string, context: ExtensionContext) {
    const bundle = this.get(id), host = this.hosts.get(id);
    if (!bundle.enabled || !host || this.states.get(id)?.status !== 'running') throw new AppError('EXTENSION_DISABLED', 'Enable or restart the extension first.');
    if (!bundle.manifest.commands.some(c => c.id === command)) throw new AppError('EXTENSION_COMMAND', 'Unknown extension command.');
    if (this.busy.has(id)) throw new AppError('EXTENSION_BUSY', 'A command is already running.');
    this.busy.add(id);
    try { return await this.bounded(id, (async () => {
      const result = await host.webContents.executeJavaScript(`globalThis.__opticRun(${JSON.stringify(command)}, ${JSON.stringify(bundle.manifest.permissions.includes('context.read') ? context : {})})`);
      if (typeof result !== 'string' || result.length > 250000) throw new Error();
      return extensionPanelSchema.parse(JSON.parse(result));
    })()); } finally { this.busy.delete(id); }
  }
  remove(id: string) { this.get(id); if (this.busy.has(id)) throw new AppError('EXTENSION_BUSY', 'Wait for the current extension operation.'); unlinkSync(join(this.directory, `${id}.json`)); this.stop(id); this.bundles.delete(id); this.states.delete(id); return this.list(); }
  close() { for (const id of this.hosts.keys()) this.stop(id); this.pending.clear(); }
}
