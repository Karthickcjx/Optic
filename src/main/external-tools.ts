import { app } from 'electron';
import { accessSync, constants, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { externalTools, externalToolSchema, type ExternalToolSettings } from '../shared/external-tools';
import { AppError } from './errors';
import { resolveLocalShell } from './terminal-profiles';

export function findTool(command: string, env = process.env, platform = process.platform): string | undefined {
  const extensions = platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(command) ? ['.exe', '.cmd', '.bat'] : [''];
  const dirs = isAbsolute(command) ? [''] : (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const dir of dirs) for (const ext of extensions) {
    const path = dir ? join(dir.replace(/^"|"$/g, ''), command + ext) : command + ext;
    try { if (statSync(path).isFile()) { accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK); return path; } } catch { /* Continue PATH discovery. */ }
  }
}
function settingsFile() { return join(app.getPath('userData'), 'external-tools.json'); }
export function readExternalTools(): ExternalToolSettings {
  try { return externalToolSchema.parse(JSON.parse(readFileSync(settingsFile(), 'utf8'))); }
  catch { return { selected: 'none', executable: '', args: [] }; }
}
export function externalToolState() { return { settings: readExternalTools(), detected: externalTools.map(t => ({ id: t.id, path: findTool(t.command) })) }; }
export function saveExternalTools(input: ExternalToolSettings) {
  const settings = externalToolSchema.parse(input);
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), { mode: 0o600 });
  return externalToolState();
}
export function externalToolLaunch() {
  const settings = readExternalTools();
  if (settings.selected === 'none') throw new AppError('TOOL_DISABLED', 'Select an external tool in Preferences first.');
  const command = settings.selected === 'custom' ? settings.executable.trim() : externalTools.find(t => t.id === settings.selected)!.command;
  const file = findTool(command);
  if (!file) throw new AppError('TOOL_UNAVAILABLE', 'The selected tool was not found. Check its installation and refresh detection in Preferences.');
  const args = settings.selected === 'custom' ? settings.args : [];
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    if ([file, ...args].some(v => /[&|<>^%!"\r\n]/.test(v))) throw new AppError('TOOL_ARGUMENTS', 'Batch launchers cannot accept shell metacharacters. Use an executable directly for these arguments.');
    const shell = resolveLocalShell('powershell');
    const quote = (v: string) => "'" + v.replace(/'/g, "''") + "'";
    return { file: shell.file, args: ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(`& ${[file, ...args].map(quote).join(' ')}; exit $LASTEXITCODE`, 'utf16le').toString('base64')] };
  }
  return { file, args };
}
