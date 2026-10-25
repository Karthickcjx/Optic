import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dialog } from 'electron';
import { exportLogs } from '../src/main/log-export';
import { schemas } from '../src/main/validation';
vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => undefined }, dialog: { showSaveDialog: vi.fn() } }));
afterEach(() => vi.clearAllMocks());
it('writes UTF-8 logs only to the path selected in the native save dialog and handles cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'optic-export-test-'));
  try {
    const filePath = join(directory, 'logs.txt'), text = '[team/pod/app] café 日志\n';
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath });
    expect(await exportLogs({} as any, text)).toEqual({ saved: true }); expect(await readFile(filePath, 'utf8')).toBe(text);
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: true, filePath });
    expect(await exportLogs({} as any, 'replacement')).toEqual({ saved: false }); expect(await readFile(filePath, 'utf8')).toBe(text);
    expect(schemas['logs:export'].safeParse({ text: 'x'.repeat(8_000_001) }).success).toBe(false);
    expect(schemas['logs:export'].parse({ text, filePath: 'untrusted-path' })).toEqual({ text });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
