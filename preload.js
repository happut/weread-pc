const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wereadPC', {
  setPowerSave: (on) => ipcRenderer.invoke('power-save', on),
  forceRerender: () => ipcRenderer.invoke('force-rerender'),
  setWindowWidth: (width) => ipcRenderer.invoke('set-window-width', width),
  readShelfCache: () => ipcRenderer.invoke('shelf-cache-read'),
  writeShelfCache: (vm) => ipcRenderer.invoke('shelf-cache-write', vm)
});
