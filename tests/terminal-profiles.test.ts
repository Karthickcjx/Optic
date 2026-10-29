import { expect, it } from 'vitest';
import { join } from 'node:path';
import { shellCommands } from '../src/main/terminal-profiles';
import { schemas } from '../src/main/validation';
it('discovers Windows profiles using executable paths and separate argv', () => {
  const win = 'C:\\Windows', programs = 'C:\\Program Files';
  const files = new Set([join(win, 'System32', 'cmd.exe'), join(win, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), join(programs, 'PowerShell', '7', 'pwsh.exe'), join(programs, 'Git', 'bin', 'bash.exe')]);
  const profiles = shellCommands('win32', { SystemRoot: win, ProgramFiles: programs, PATH: '' }, p => files.has(p));
  expect(profiles.system.file).toBe(profiles.cmd.file);
  expect(profiles.powershell.args).toEqual(['-NoLogo']); expect(profiles.gitbash.args).toEqual(['--login', '-i']);
  expect(Object.values(profiles).every(p => !!p.file)).toBe(true);
});
it('does not substitute missing Git Bash with Windows or WSL bash', () => {
  const profiles = shellCommands('win32', { PATH: 'C:\\Windows\\System32' }, p => p.endsWith('bash.exe'));
  // Known Git locations are checked; PATH bash.exe is never treated as Git Bash.
  expect(profiles.gitbash.file).not.toContain('System32');
  expect(shellCommands('win32', {}, () => false).gitbash.file).toBeUndefined();
});
it('supports Unix default shells and pwsh without exposing Windows shells', () => {
  const profiles = shellCommands('linux', { SHELL: '/bin/zsh', PATH: '/usr/bin' }, p => ['/bin/zsh', '/usr/bin/pwsh'].includes(p));
  expect(profiles.system.file).toBe('/bin/zsh'); expect(profiles.cmd.file).toBeUndefined(); expect(profiles.gitbash.file).toBeUndefined();
});
it('accepts only known local shell ids and separates pod shell selection', () => {
  const base = { id: '4db5f762-7ad1-4634-a0eb-87a1dbab33c5', cols: 100, rows: 24 };
  expect(schemas['terminal:open'].safeParse({ ...base, localShell: 'powershell' }).success).toBe(true);
  expect(schemas['terminal:open'].safeParse({ ...base, localShell: 'cmd.exe /c command' }).success).toBe(false);
  expect(schemas['terminal:open'].safeParse({ ...base, localShell: 'gitbash', pod: 'app', namespace: 'default', clusterId: 'test' }).success).toBe(false);
  expect(schemas['terminal:open'].safeParse({ ...base, shell: '/bin/sh' }).success).toBe(false);
});
