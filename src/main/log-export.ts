import { BrowserWindow, dialog, type WebContents } from 'electron';
import { writeFile } from 'node:fs/promises';
export async function exportLogs(owner: WebContents, text: string) {
  const window = BrowserWindow.fromWebContents(owner);
  const options = { title: 'Export retained logs', defaultPath: `optic-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.log`, filters: [{ name: 'Log files', extensions: ['log'] }, { name: 'Text files', extensions: ['txt'] }] };
  const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { saved: false };
  await writeFile(result.filePath, text, { encoding: 'utf8', mode: 0o600 });
  return { saved: true };
}
