import type { Resource } from './protocol';
export type Severity = 'error' | 'warning' | 'normal';
export function logSeverity(line: string): Severity {
  const text = line.replace(/\x1b\[[0-9;]*m/g, '');
  // Prefer an explicit level over words in an informational message.
  const level = text.match(/(?:"?(?:level|severity|log.level)"?\s*[:=]\s*"?|\[)(trace|debug|info|warn(?:ing)?|error|err|fatal|panic|critical)\b/i)?.[1]?.toLowerCase();
  if (level) return /error|err|fatal|panic|critical/.test(level) ? 'error' : /^warn/.test(level) ? 'warning' : 'normal';
  if (/\b(?:no|zero|0)\s+errors?\b|\berrors?\s*[:=]\s*0\b/i.test(text)) return 'normal';
  if (/\b(?:error|fatal|panic|exception|failed|failure|crashloopbackoff|imagepullbackoff|errimagepull|oomkilled)\b/i.test(text)) return 'error';
  return /\bwarn(?:ing)?\b/i.test(text) ? 'warning' : 'normal';
}
export function conditionSeverity(c: any): Severity {
  if (/^(Complete|Succeeded)$/i.test(c.type ?? '') && c.status === 'False') return 'normal';
  const negative = /^(?:.*Pressure|NetworkUnavailable|Degraded|Failed|FailureTarget|ReplicaFailure)$/i.test(c.type ?? '');
  const positive = /^(Ready|ContainersReady|Initialized|PodScheduled|Available|Progressing|Healthy|Established|NamesAccepted|Complete|Succeeded)$/i.test(c.type ?? '');
  if (negative) return c.status === 'True' ? 'error' : c.status === 'Unknown' ? 'warning' : 'normal';
  if (positive && c.status === 'False') return 'error';
  if (c.status === 'Unknown') return 'warning';
  return logSeverity(String(c.reason ?? ''));
}
export function containerSeverity(state: any): Severity {
  if (state?.terminated) return state.terminated.exitCode !== undefined && state.terminated.exitCode !== 0 || /Error|OOMKilled|Failed/.test(state.terminated.reason ?? '') ? 'error' : 'normal';
  if (state?.waiting) return /Error|Crash|BackOff|ErrImage|Invalid|CannotRun|Failed/.test(state.waiting.reason ?? '') ? 'error' : 'warning';
  return 'normal';
}
export function resourceSeverity(r: Resource): Severity {
  const s = r.status ?? {};
  if (r.kind === 'Event') return logSeverity(`${r.reason ?? ''} ${r.message ?? ''}`) === 'error' ? 'error' : r.type === 'Warning' ? 'warning' : 'normal';
  const containers = [...(s.containerStatuses ?? []), ...(s.initContainerStatuses ?? []), ...(s.ephemeralContainerStatuses ?? [])];
  if ((r.kind === 'Job' && s.failed > 0 && !s.succeeded) || /^(Failed|Lost|Error)$/.test(s.phase ?? '') || /Evicted|Error|Failed|OOMKilled/.test(s.reason ?? '') || containers.some(c => containerSeverity(c.state) === 'error') || s.conditions?.some((c: any) => conditionSeverity(c) === 'error')) return 'error';
  return s.phase === 'Pending' || containers.some(c => containerSeverity(c.state) === 'warning') ? 'warning' : 'normal';
}
