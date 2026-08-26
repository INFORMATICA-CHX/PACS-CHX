const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('licenseManager', {
  issue: (claims) => ipcRenderer.invoke('license:issue', claims),
  save: (data) => ipcRenderer.invoke('license:save', data),
  history: () => ipcRenderer.invoke('license:history'),
  adminStatus: () => ipcRenderer.invoke('license:admin-status'),
  setupAdmin: (password) => ipcRenderer.invoke('license:admin-setup', password),
  deleteLicense: (licenseId, password) => ipcRenderer.invoke('license:delete', { licenseId, password }),
  supabaseStatus: () => ipcRenderer.invoke('license:supabase-status'),
  supabaseSetup: (serviceKey) => ipcRenderer.invoke('license:supabase-setup', serviceKey),
  revokeRemote: (licenseKey, revoked, clinicName, reason, password) =>
    ipcRenderer.invoke('license:revoke-remote', { licenseKey, revoked, clinicName, reason, password }),
});
