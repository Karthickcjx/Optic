import * as pty from 'node-pty';
type Parent = { on(event: 'message', listener: (event: { data: any }) => void): void; postMessage(value: unknown): void };
const parent = (process as NodeJS.Process & { parentPort: Parent }).parentPort;
let terminal: pty.IPty | undefined;
let seq = 0;
const pending = new Map<number, number>();
let queuedBytes = 0;
parent.on('message', ({ data: message }) => {
  try {
    if (message.type === 'open') {
      terminal = pty.spawn(message.file, message.args, { name: 'xterm-256color', cols: message.cols, rows: message.rows, cwd: message.cwd, env: message.env });
      terminal.onData(data => {
        const current = ++seq; pending.set(current, Buffer.byteLength(data)); queuedBytes += Buffer.byteLength(data);
        parent.postMessage({ type: 'data', data, seq: current });
        if (queuedBytes > 262144) terminal?.pause();
      });
      terminal.onExit(({ exitCode }) => { parent.postMessage({ type: 'end', exitCode }); process.exit(0); });
      parent.postMessage({ type: 'ready' });
    } else if (message.type === 'write') terminal?.write(message.data);
    else if (message.type === 'resize') terminal?.resize(message.cols, message.rows);
    else if (message.type === 'ack') {
      queuedBytes -= pending.get(message.seq) ?? 0; pending.delete(message.seq);
      if (queuedBytes < 65536) terminal?.resume();
    } else if (message.type === 'close') { terminal?.kill(); setTimeout(() => process.exit(0), 100).unref(); }
  } catch { parent.postMessage({ type: 'error' }); terminal?.kill(); process.exit(1); }
});
