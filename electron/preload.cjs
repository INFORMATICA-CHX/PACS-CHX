const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('localPacs', {
  startServer: () => ipcRenderer.invoke('server:start'),
  stopServer: () => ipcRenderer.invoke('server:stop'),
  getServerStatus: () => ipcRenderer.invoke('server:status'),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  openViewer: (apiPort) => ipcRenderer.invoke('viewer:open', apiPort),
  openFolder: () => ipcRenderer.invoke('dialog:open-folder'),
});
