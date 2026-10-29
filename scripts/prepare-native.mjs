import { chmod, lstat } from 'node:fs/promises';
import { join } from 'node:path';

// node-pty 1.1.0 publishes macOS spawn-helper binaries as 0644 (upstream #919).
// Fix the known package files before dev/packaging, never at application runtime.
if (process.platform === 'darwin') {
  for (const arch of ['arm64', 'x64']) {
    const helper = join('node_modules', 'node-pty', 'prebuilds', `darwin-${arch}`, 'spawn-helper');
    const file = await lstat(helper);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error(`Unexpected PTY helper: ${helper}`);
    await chmod(helper, 0o755);
  }
}
