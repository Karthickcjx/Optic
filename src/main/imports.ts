import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, lstatSync, readFileSync, writeFileSync, rmSync, createReadStream } from 'node:fs';
import { basename, dirname, join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { Parser, x } from 'tar';
import { AppError } from './errors';
import type { ImportKind, ImportSource } from '../shared/deploy';

function fail(message: string): never { throw new AppError('INVALID_IMPORT', message); }
export function safeArchivePath(path: string) {
  const parts = path.replace(/\\/g, '/').split('/');
  return !!path && !isAbsolute(path) && !/[:\x00-\x1f]/.test(path) && !parts.includes('..') && !path.startsWith('/') && !path.startsWith('\\');
}
export async function inspectArchive(path: string) {
  let size = 0, count = 0; const paths = new Set<string>();
  if (lstatSync(path).size > 20 * 1024 * 1024) fail('Compressed charts are limited to 20 MiB.');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    const parser = new Parser({ strict: true, maxDecompressionRatio: 100, onReadEntry(entry) {
      size += entry.size; count++;
      const normalized = entry.path.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
      if (!safeArchivePath(entry.path) || !['File', 'Directory'].includes(entry.type) || size > 100 * 1024 * 1024 || count > 2000 || paths.has(normalized)) {
        parser.abort(new AppError('INVALID_IMPORT', 'Unsafe chart archive: links, duplicate paths, traversal or extraction limits detected.')); return;
      }
      paths.add(normalized); entry.resume();
    } });
    const timer = setTimeout(() => parser.abort(new Error('Archive inspection timed out')), 30000);
    parser.on('error', error => { clearTimeout(timer); stream.destroy(); reject(error); });
    parser.on('end', () => { clearTimeout(timer); resolve(); });
    stream.on('error', error => { clearTimeout(timer); parser.abort(error); reject(error); });
    stream.pipe(parser);
  });
}
type Stored = { source: ImportSource; directory: string; owner: number; bytes: number; expires: number };
export class Imports {
  private sources = new Map<string, Stored>();
  private sweep = setInterval(() => { for (const [id, item] of this.sources) if (item.expires < Date.now()) this.remove(id); }, 60000).unref();
  get(id: string, owner: number) { const item = this.sources.get(id); if (!item || item.owner !== owner || item.expires < Date.now()) fail('Import expired. Select the source again.'); item.expires = Date.now() + 3600000; return item; }
  private remove(id: string) { const item = this.sources.get(id); if (item) { rmSync(item.directory, { recursive: true, force: true }); this.sources.delete(id); } }
  dispose(id: string, owner: number) { this.get(id, owner); this.remove(id); }
  close() { clearInterval(this.sweep); for (const id of this.sources.keys()) this.remove(id); }
  async add(kind: ImportKind, paths: string[], owner: number): Promise<ImportSource> {
    if (this.sources.size >= 50) fail('Too many staged imports. Close unused import dialogs.');
    const directory = mkdtempSync(join(tmpdir(), 'optic-import-')); const files: string[] = []; let bytes = 0;
    const limit = ['chart', 'archive', 'kustomize'].includes(kind) ? 100 * 1024 * 1024 : 20 * 1024 * 1024;
    const copy = (from: string, to: string) => {
      const stat = lstatSync(from);
      if (stat.isSymbolicLink() || !stat.isFile()) fail('Imports cannot contain links or special files.');
      bytes += stat.size;
      if (bytes > limit || files.length >= (kind === 'chart' || kind === 'archive' ? 2000 : 200)) fail('Import exceeds the file count or size limit.');
      const data = readFileSync(from); if (data.length !== stat.size) fail('Source changed while being imported. Try again.');
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 }); writeFileSync(to, data, { mode: 0o600 }); files.push(relative(directory, to).replace(/\\/g, '/'));
    };
    const walk = (root: string, dir: string, depth = 0) => {
      if (depth > 30) fail('Directory nesting exceeds the import limit.');
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (['.git', 'node_modules', '.svn'].includes(entry.name)) continue;
        const path = join(dir, entry.name); if (entry.isSymbolicLink()) fail('Imports cannot contain symbolic links.');
        if (entry.isDirectory()) walk(root, path, depth + 1);
        else if (kind !== 'folder' || /\.(ya?ml|json)$/i.test(entry.name)) copy(path, join(directory, relative(root, path)));
      }
    };
    try {
      if (paths.some(p => lstatSync(p).isSymbolicLink())) fail('Select a regular file or directory.');
      if (['folder', 'chart', 'kustomize'].includes(kind)) walk(paths[0], paths[0]);
      else for (let i = 0; i < paths.length; i++) copy(paths[i], join(directory, kind === 'archive' ? 'chart.tgz' : `${i + 1}-${basename(paths[i])}`));
      let chart: ImportSource['chart'];
      if (kind === 'archive') {
        await inspectArchive(join(directory, 'chart.tgz'));
        const extracted = join(directory, 'unpacked'); mkdirSync(extracted);
        await x({ file: join(directory, 'chart.tgz'), cwd: extracted, strict: true });
        const roots = readdirSync(extracted); if (roots.length !== 1 || !lstatSync(join(extracted, roots[0])).isDirectory()) fail('A chart archive must contain one chart directory.');
        chart = this.chart(join(extracted, roots[0]));
      } else if (kind === 'chart') chart = this.chart(directory);
      if (kind === 'kustomize' && !files.some(f => /(?:^|\/)(kustomization\.ya?ml|Kustomization)$/.test(f))) fail('Select a directory containing a kustomization file.');
      if (!files.length) fail('No supported files found.');
      const source = { id: randomUUID(), kind, label: basename(paths[0]) + (paths.length > 1 ? ` (+${paths.length - 1})` : ''), files, chart };
      this.sources.set(source.id, { source, directory, owner, bytes, expires: Date.now() + 3600000 }); return source;
    } catch (error) { rmSync(directory, { recursive: true, force: true }); if (error instanceof AppError) throw error; fail('Could not read this import. Check its format, permissions and size.'); }
  }
  private chart(directory: string) {
    let doc: any; try { doc = parse(readFileSync(join(directory, 'Chart.yaml'), 'utf8'), { maxAliasCount: 50 }); } catch { fail('Chart.yaml is missing or invalid.'); }
    if (!doc || !['v1', 'v2'].includes(doc.apiVersion) || !/^[a-zA-Z0-9][\w.-]*$/.test(doc.name ?? '') || typeof doc.version !== 'string' || !/^\d+\.\d+\.\d+/.test(doc.version)) fail('Chart.yaml requires a supported apiVersion, name and semantic version.');
    return { name: doc.name as string, version: doc.version as string, dependencies: Array.isArray(doc.dependencies) ? doc.dependencies.map((d: any) => String(d.name)) : [] };
  }
}
