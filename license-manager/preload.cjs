const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('licenseManager', {
  issue: (claims) => ipcRenderer.invoke('license:issue', claims),
  save: (data) => ipcRenderer.invoke('license:save', data),
  history: () => ipcRenderer.invoke('license:history'),
  adminStatus: () => ipcRenderer.invoke('license:admin-status'),
  setupAdmin: (password) => ipcRenderer.invoke('license:admin-setup', password),
  deleteLicense: (licenseId, password) => ipcRenderer.invoke('license:delete', { licenseId, password }),
  gitStatus: () => ipcRenderer.invoke('license:git-status'),
  gitSetup: (config) => ipcRenderer.invoke('license:git-setup', config),
  revokeRemote: (licenseKey, revoked, clinicName, reason, password) =>
    ipcRenderer.invoke('license:revoke-remote', { licenseKey, revoked, clinicName, reason, password }),
});
