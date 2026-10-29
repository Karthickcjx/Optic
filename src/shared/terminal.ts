export const localShellIds = ['system', 'cmd', 'powershell', 'pwsh', 'gitbash'] as const;
export type LocalShellId = typeof localShellIds[number];
export interface LocalShellProfile { id: LocalShellId; label: string; available: boolean }
