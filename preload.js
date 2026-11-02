'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widget', {
  getInitial: () => ipcRenderer.invoke('get-initial'),
  getStats: () => ipcRenderer.invoke('get-stats'),
  refresh: () => ipcRenderer.invoke('refresh'),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setHeight: (h, scaleTag, wide) => ipcRenderer.send('layout-report', { innerW: window.innerWidth, innerH: window.innerHeight, appH: h, scale: scaleTag, wide }),
  setWidth: (w) => ipcRenderer.send('window-width', w),
  hide: () => ipcRenderer.send('window-hide'),
  quit: () => ipcRenderer.send('window-quit'),
  onQuota: (cb) => ipcRenderer.on('quota', (_e, payload) => cb(payload)),
  onSettings: (cb) => ipcRenderer.on('settings', (_e, s) => cb(s)),
});
