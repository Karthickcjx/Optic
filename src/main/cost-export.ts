import { BrowserWindow, dialog, type WebContents } from 'electron';
import { writeFile } from 'node:fs/promises';
export async function exportCostReport(owner: WebContents, text: string, format: 'csv' | 'json') {
  const window = BrowserWindow.fromWebContents(owner);
  const options = { title: 'Export cost report', defaultPath: `optic-cost-${new Date().toISOString().replace(/[:.]/g, '-')}.${format}`, filters: [{ name: format.toUpperCase() + ' report', extensions: [format] }] };
  const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { saved: false };
  await writeFile(result.filePath, text, { encoding: 'utf8', mode: 0o600 });
  return { saved: true };
}
