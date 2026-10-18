'use strict';
/* Единственное, что окно получает от Electron: скрыть, показать, сменить горячую клавишу и узнать, что клавишу нажали. Доступа к файлам и системе нет. */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('dotamateOverlay', {
  hide: () => ipcRenderer.send('overlay:hide'),
  show: () => ipcRenderer.send('overlay:show'),
  setHotkey: (k) => ipcRenderer.send('overlay:hotkey', String(k).slice(0, 20)),
  onToggle: (fn) => { if (typeof fn === 'function') ipcRenderer.on('overlay:toggled', (_e, visible) => fn(!!visible)); }
});
