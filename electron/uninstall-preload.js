'use strict';

/**
 * 卸载窗口的 preload。
 *
 * 只暴露卸载需要的四个动作，其余一概不给 —— 这个窗口只跑一次、只做一件事，
 * 没有理由把主程序那套几十个 API 也挂上去。
 */

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const handler = (_event, payload) => {
    try {
      callback(payload);
    } catch {
      /* 渲染层回调抛错不该拖垮主进程 */
    }
  };
  ipcRenderer.on(channel, handler);
  return () => {
    try {
      ipcRenderer.removeListener(channel, handler);
    } catch {
      /* 窗口已销毁 */
    }
  };
}

contextBridge.exposeInMainWorld('uninstall', {
  info: () => ipcRenderer.invoke('uninstall:info'),
  start: () => ipcRenderer.invoke('uninstall:start'),
  onProgress: (callback) => subscribe('uninstall:progress', callback),
  close: () => ipcRenderer.invoke('uninstall:close'),
});