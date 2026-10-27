'use strict';
// 控制台与气泡窗口的预加载：只暴露窗口操作，不暴露 Node 能力。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('companionBridge', {
  minimize: () => ipcRenderer.send('companion:window', 'minimize'),
  maximize: () => ipcRenderer.send('companion:window', 'maximize'),
  close: () => ipcRenderer.send('companion:window', 'close'),
  pin: (value) => ipcRenderer.send('companion:window', value ? 'pin' : 'unpin'),
  openConsole: (tab) => ipcRenderer.send('companion:console', typeof tab === 'string' ? tab : 'home'),
  openCard: () => ipcRenderer.send('companion:card'),
  openStatus: (source) => ipcRenderer.send('companion:open-status', source === 'dsh' ? 'dsh' : 'codex'),
  statusHover: (value) => ipcRenderer.send('companion:status-hover', !!value),
  pickFolder: (current) => ipcRenderer.invoke('companion:pick-folder', typeof current === 'string' ? current : ''),
  bubblePass: (value) => ipcRenderer.send('companion:bubble-pass', !!value),
  bubbleVisible: (value) => ipcRenderer.send('companion:bubble-visible', !!value),
  onTab: (fn) => ipcRenderer.on('companion:tab', (_event, tab) => fn(tab)),
  onTail: (fn) => ipcRenderer.on('companion:tail', (_event, x) => fn(x)),
});
