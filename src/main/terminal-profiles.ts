import { existsSync, statSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import { AppError } from './errors';
import type { LocalShellId, LocalShellProfile } from '../shared/terminal';

export function shellCommands(platform = process.platform, env: NodeJS.ProcessEnv = process.env, isFile = (path: string) => { try { return existsSync(path) && statSync(path).isFile(); } catch { return false; } }) {
  const find = (...paths: (string | undefined)[]) => paths.find((path): path is string => !!path && isFile(path));
  const fromPath = (name: string) => (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean).map(dir => join(dir.replace(/^"|"$/g, ''), name));
  const win = env.SystemRoot || 'C:\\Windows';
  const cmd = platform === 'win32' ? find(env.COMSPEC, join(win, 'System32', 'cmd.exe'), ...fromPath('cmd.exe')) : undefined;
  const powershell = platform === 'win32' ? find(join(win, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ...fromPath('powershell.exe')) : undefined;
  const pwsh = find(...fromPath(platform === 'win32' ? 'pwsh.exe' : 'pwsh'), ...(platform === 'win32' ? [join(env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')] : []));
  const git = platform === 'win32' ? find(...fromPath('git.exe')) : undefined;
  const gitbash = platform === 'win32' ? find(
    ...[env.ProgramFiles || 'C:\\Program Files', env['ProgramFiles(x86)'], env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs') : undefined].filter((p): p is string => !!p).map(p => join(p, 'Git', 'bin', 'bash.exe')),
    ...(git ? [join(dirname(dirname(git)), 'bin', 'bash.exe'), join(dirname(git), 'bash.exe')] : []),
  ) : undefined;
  return {
    system: { file: platform === 'win32' ? cmd : find(env.SHELL, '/bin/bash', '/bin/sh'), args: [] as string[], label: platform === 'win32' ? 'Default (Command Prompt)' : 'System shell' },
    cmd: { file: cmd, args: [], label: 'Command Prompt' },
    powershell: { file: powershell, args: ['-NoLogo'], label: 'Windows PowerShell' },
    pwsh: { file: pwsh, args: ['-NoLogo'], label: 'PowerShell 7' },
    gitbash: { file: gitbash, args: ['--login', '-i'], label: 'Git Bash' },
  };
}
export function localShellProfiles(): LocalShellProfile[] { return Object.entries(shellCommands()).map(([id, shell]) => ({ id: id as LocalShellId, label: shell.label, available: !!shell.file })); }
export function resolveLocalShell(id: LocalShellId = 'system') {
  const shell = shellCommands()[id];
  if (!shell?.file) throw new AppError('SHELL_UNAVAILABLE', `${shell?.label ?? 'Selected shell'} is not installed or could not be found. Install it and refresh the terminal profiles.`);
  return { file: shell.file, args: shell.args };
}
