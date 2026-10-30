import { z } from 'zod';
export const extensionId = z.string().regex(/^[a-z][a-z0-9-]{1,63}\.[a-z][a-z0-9-]{1,63}$/);
export const extensionManifestSchema = z.object({
  apiVersion: z.literal(1), id: extensionId, name: z.string().min(1).max(80),
  version: z.string().regex(/^\d+\.\d+\.\d+$/), description: z.string().max(500),
  permissions: z.array(z.literal('context.read')).max(1).default([]),
  commands: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), title: z.string().min(1).max(80) }).strict()).min(1).max(20)
}).strict().refine(m => new Set(m.commands.map(c => c.id)).size === m.commands.length, 'Command IDs must be unique');
export type ExtensionManifest = z.infer<typeof extensionManifestSchema>;
export const extensionPanelSchema = z.object({ title: z.string().max(120), text: z.string().max(20000).optional(), columns: z.array(z.string().max(80)).max(10).optional(), rows: z.array(z.array(z.string().max(1000)).max(10)).max(200).optional() }).strict();
export type ExtensionPanel = z.infer<typeof extensionPanelSchema>;
export interface ExtensionContext { clusterName?: string; namespace?: string }
/** Global API available to a bundled extension.js. No imports or Node APIs. */
export interface OpticExtensionAPI {
  readonly version: 1;
  registerCommand(id: string, handler: (context: Readonly<ExtensionContext>) => ExtensionPanel | Promise<ExtensionPanel>): void;
}
export interface ExtensionInfo { manifest: ExtensionManifest; enabled: boolean; status: 'disabled' | 'starting' | 'running' | 'failed'; error?: string }
export interface ExtensionReview { token: string; manifest: ExtensionManifest; digest: string; replacing: boolean }
