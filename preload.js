const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  notify: (title, body) => ipcRenderer.send('notify', title, body),
  updateTrayTitle: (title, status) => ipcRenderer.send('update-tray-title', title, status),
  setAlwaysOnTop: (flag) => ipcRenderer.send('set-always-on-top', flag),
  onTimerAction: (callback) => {
    ipcRenderer.on('timer-action', (event, action) => callback(action));
  },
  onAlwaysOnTopChanged: (callback) => {
    ipcRenderer.on('always-on-top-changed', (event, flag) => callback(flag));
  },
});
