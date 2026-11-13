const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('accountWindow', {
  command: (action, value) => ipcRenderer.invoke('mosaic:account-command', action, value),
  onState: (callback) => ipcRenderer.on('mosaic:account-state', (_event, state) => callback(state)),
});
