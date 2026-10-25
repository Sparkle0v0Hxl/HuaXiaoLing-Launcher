'use strict';

/**
 * 音乐登录窗口专用 preload。
 *
 * QQ 音乐 / 酷狗登录完成后，凭证 cookie 的名字不一定在候选列表里，
 * 主进程的轮询可能永远判定「没登录」，窗口就一直挂着。
 * 这个 preload 把主进程的「我已登录」兜底接口暴露给官网页面里的提示条按钮，
 * 让用户能手动触发一次整袋 cookie 的保存。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hxlMusicLoginConfirm', () => ipcRenderer.invoke('music:login-confirm'));
