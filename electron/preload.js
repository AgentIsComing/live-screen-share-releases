const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApp', {
  getVersion: () => ipcRenderer.invoke('app-version'),
  listDesktopSources: () => ipcRenderer.invoke('list-desktop-sources'),
  getTunnelUrl: () => ipcRenderer.invoke('get-tunnel-url'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  onUpdaterStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('updater-status', handler);
    return () => ipcRenderer.removeListener('updater-status', handler);
  }
});