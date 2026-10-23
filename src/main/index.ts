import { app, BrowserWindow, session } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerIpc } from './ipc';

const directory = dirname(fileURLToPath(import.meta.url));
const renderer = pathToFileURL(join(directory, '../renderer/index.html')).href;
const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
const trusted = (url: string) => devUrl ? new URL(url).origin === new URL(devUrl).origin : url.split('#')[0] === renderer;
const streams = registerIpc(trusted);
function createWindow() {
  const window = new BrowserWindow({ width: 1440, height: 960, minWidth: 1000, minHeight: 680, backgroundColor: '#202224', title: 'Optic', show: false,
    icon: join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'resources', process.platform === 'win32' ? 'icon.ico' : 'logo.png'),
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#27292c', symbolColor: '#bfc3c8', height: 35 },
    webPreferences: { preload: join(directory, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  });
  const contents = window.webContents;
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!trusted(url)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) streams.closeOwner(window.webContents); });
  window.webContents.on('render-process-gone', () => streams.closeOwner(window.webContents));
  window.on('closed', () => streams.closeOwner(contents));
  window.once('ready-to-show', () => window.show());
  if (devUrl) void window.loadURL(devUrl); else void window.loadURL(renderer);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    const policy = `default-src 'self'; script-src 'self'${devUrl ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ${devUrl ? 'ws://localhost:* ws://127.0.0.1:*' : ''}; object-src 'none'; frame-src 'none'; base-uri 'none'`;
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] } }));
    createWindow();
  });
  app.on('second-instance', () => { const window = BrowserWindow.getAllWindows()[0]; window?.show(); window?.focus(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => streams.closeAll());
}
