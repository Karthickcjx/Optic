import type { PodTarget } from './protocol';
export const maxLogSources = 8;
export const maxLogLines = 5000;
export const maxLogCharacters = 1_000_000;
export interface LogOptions { clusterId: string; sources: PodTarget[] }
export function logSourceKey(source: PodTarget) { return `${source.namespace}/${source.pod}/${source.container ?? 'default'}`; }
export const shellPresets = ['/bin/sh', '/bin/bash', '/bin/ash', '/bin/zsh', 'sh', 'bash', 'pwsh', 'powershell.exe', 'cmd.exe'];
// One executable, never a shell command or argument string.
export function validContainerShell(value: string) { return value.length > 0 && value.length <= 512 && /^[a-zA-Z0-9/\\][a-zA-Z0-9_./\\:-]*$/.test(value); }
