import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dialog } from 'electron';
import { exportCostReport } from '../src/main/cost-export';
import { schemas } from '../src/main/validation';
vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => undefined }, dialog: { showSaveDialog: vi.fn() } }));
afterEach(() => vi.clearAllMocks());
it('writes cost reports only to the path selected in the native save dialog and handles cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'optic-export-test-'));
  try {
    const filePath = join(directory, 'logs.txt'), text = '[team/pod/app] café 日志\n';
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath });
    expect(await exportCostReport({} as any, text, 'csv')).toEqual({ saved: true }); expect(await readFile(filePath, 'utf8')).toBe(text);
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: true, filePath });
    expect(await exportCostReport({} as any, 'replacement', 'csv')).toEqual({ saved: false }); expect(await readFile(filePath, 'utf8')).toBe(text);
    expect(schemas['cost:export'].safeParse({ text: 'x'.repeat(16_000_001), format: 'csv' }).success).toBe(false);
    expect(schemas['cost:export'].parse({ text, format: 'csv', filePath: 'untrusted-path' })).toEqual({ text, format: 'csv' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
