import { z } from 'zod';
export const externalTools = [
  { id: 'claude', name: 'Claude Code', command: 'claude' },
  { id: 'copilot', name: 'GitHub Copilot CLI', command: 'copilot' },
  { id: 'agy', name: 'Antigravity CLI', command: 'agy' },
  { id: 'codex', name: 'Codex CLI', command: 'codex' },
  { id: 'opencode', name: 'OpenCode', command: 'opencode' },
] as const;
export const externalToolSchema = z.object({
  selected: z.enum(['none', 'custom', 'claude', 'copilot', 'agy', 'codex', 'opencode']),
  executable: z.string().max(2048).refine(v => !/[\r\n\0]/.test(v)),
  args: z.array(z.string().max(2048).refine(v => !/[\r\n\0]/.test(v))).max(32),
}).strict().refine(v => v.selected !== 'custom' || !!v.executable.trim(), 'Enter a custom executable.');
export type ExternalToolSettings = z.infer<typeof externalToolSchema>;
export interface ExternalToolState { settings: ExternalToolSettings; detected: { id: string; path?: string }[] }
