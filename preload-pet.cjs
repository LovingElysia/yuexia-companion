'use strict';
// 桌宠与礼物窗口的预加载：先原样载入月下动作包自己的 preload（window.petBridge），
// 再额外提供 window.yuexiaCompanion。原包 preload 的路径由主进程通过启动参数传入。
const { contextBridge, ipcRenderer } = require('electron');

const arg = process.argv.find((a) => a.startsWith('--yuexia-base-preload='));
if (arg) require(arg.slice('--yuexia-base-preload='.length));

contextBridge.exposeInMainWorld('yuexiaCompanion', {
  openConsole: (tab) => ipcRenderer.send('companion:console', typeof tab === 'string' ? tab : 'home'),
  openCard: () => ipcRenderer.send('companion:card'),
  toggleStatus: () => ipcRenderer.send('companion:status'),
});
