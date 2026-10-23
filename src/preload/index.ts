import { contextBridge, ipcRenderer } from 'electron';
import { channels, type DesktopAPI, type StreamEvent } from '../shared/protocol';
const api: DesktopAPI = {
  request: (channel, input) => {
    if (!channels.includes(channel)) return Promise.reject(new Error('Unsupported request'));
    return ipcRenderer.invoke(channel, input);
  },
  subscribe: listener => {
    const handler = (_event: Electron.IpcRendererEvent, message: StreamEvent) => listener(message);
    ipcRenderer.on('stream:event', handler);
    return () => ipcRenderer.removeListener('stream:event', handler);
  }
};
contextBridge.exposeInMainWorld('desktop', Object.freeze(api));
