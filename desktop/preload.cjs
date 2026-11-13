const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mosaicNative', {
  bootstrap: ipcRenderer.sendSync('mosaic:bootstrap'),
  saveState: (state) => ipcRenderer.invoke('mosaic:save', state),
  syncPanes: (data) => ipcRenderer.invoke('mosaic:sync', data),
  switchProfile: (paneId, profileId) =>
    ipcRenderer.invoke('mosaic:switch-profile', { paneId, profileId }),
  requestClose: (paneIds) => ipcRenderer.invoke('mosaic:request-close', paneIds),
  openProfileLogin: (profileId, provider) =>
    ipcRenderer.invoke('mosaic:profile-login', { profileId, provider }),
  listCredentials: (data) => ipcRenderer.invoke('mosaic:credentials-list', data),
  saveCredential: (data) => ipcRenderer.invoke('mosaic:credentials-save', data),
  deleteCredential: (profileId, credentialId) =>
    ipcRenderer.invoke('mosaic:credentials-remove', { profileId, credentialId }),
  fillCredential: (data) => ipcRenderer.invoke('mosaic:credentials-fill', data),
  layout: (data) => ipcRenderer.invoke('mosaic:layout', data),
  command: (paneId, action, value) =>
    ipcRenderer.invoke('mosaic:command', { paneId, action, value }),
  openInChrome: (paneId) => ipcRenderer.invoke('mosaic:open-chrome', paneId),
  useMosaic: (paneId) => ipcRenderer.invoke('mosaic:use-mosaic', paneId),
  agentInfo: () => ipcRenderer.invoke('mosaic:agent-info'),
  setAgentAccess: (data) => ipcRenderer.invoke('mosaic:agent-access', data),
  stopAgent: (paneId) => ipcRenderer.invoke('mosaic:agent-stop', paneId),
  resumeAgent: (paneId) => ipcRenderer.invoke('mosaic:agent-resume', paneId),
  aiProviders: () => ipcRenderer.invoke('mosaic:ai-providers'),
  aiState: () => ipcRenderer.invoke('mosaic:ai-state'),
  aiCreateChat: (input) => ipcRenderer.invoke('mosaic:ai-create', input),
  aiUpdateChat: (id, patch) => ipcRenderer.invoke('mosaic:ai-update', { id, patch }),
  aiForkChat: (id, provider, carryContext) => ipcRenderer.invoke('mosaic:ai-fork', { id, provider, carryContext }),
  aiSend: (id, text) => ipcRenderer.invoke('mosaic:ai-send', { id, text }),
  aiStop: (id) => ipcRenderer.invoke('mosaic:ai-stop', id),
  aiLogin: (provider) => ipcRenderer.invoke('mosaic:ai-login', provider),
  appInfo: () => ipcRenderer.invoke('mosaic:app-info'),
  setAppPreferences: (patch) => ipcRenderer.invoke('mosaic:app-preferences', patch),
  checkUpdates: () => ipcRenderer.invoke('mosaic:check-updates'),
  openAppLink: (topic) => ipcRenderer.invoke('mosaic:app-link', topic),
  exportDiagnostics: () => ipcRenderer.invoke('mosaic:export-diagnostics'),
  clearMetrics: () => ipcRenderer.invoke('mosaic:clear-metrics'),
  onEvent: (listener) => {
    const callback = (_event, value) => listener(value);
    ipcRenderer.on('mosaic:event', callback);
    return () => ipcRenderer.removeListener('mosaic:event', callback);
  },
});
