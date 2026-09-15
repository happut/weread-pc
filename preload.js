const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wereadPC', {
  setPowerSave: (on) => ipcRenderer.invoke('power-save', on),
  forceRerender: () => ipcRenderer.invoke('force-rerender'),
  setWindowWidth: (width) => ipcRenderer.invoke('set-window-width', width),
  readShelfCache: () => ipcRenderer.invoke('shelf-cache-read'),
  writeShelfCache: (vm) => ipcRenderer.invoke('shelf-cache-write', vm),
  readAuth: () => ipcRenderer.invoke('auth-read'),
  writeAuth: (a) => ipcRenderer.invoke('auth-write', a),
  readStatsCache: () => ipcRenderer.invoke('stats-cache-read'),
  writeStatsCache: (vm) => ipcRenderer.invoke('stats-cache-write', vm),
  readBookCache: (id) => ipcRenderer.invoke('book-cache-read', id),
  writeBookCache: (id, vm) => ipcRenderer.invoke('book-cache-write', id, vm),
  fetchStats: () => ipcRenderer.invoke('weread-fetch-stats'),
  fetchBook: (id) => ipcRenderer.invoke('weread-fetch-book', id)
});
