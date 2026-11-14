'use strict';

const { ipcMain, app, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { loadSecret, saveSecret } = require('./secret-store');


/**
 * 文件 / 目录选择对话框。
 *
 * 从 main.js 的 installIpc() 里整段搬出来（那个函数一度有 11300 多行、
 * 两百多个 IPC）。搬运时逻辑未改，外层依赖通过 ctx 注入。
 */

function installDialogIpc(ctx) {
  const { win } = ctx;

    ipcMain.handle('dialog:pick-executable', async () => {
      const result = await dialog.showOpenDialog(win, {
        title: '选择游戏的启动程序',
        properties: ['openFile'],
        filters: [
          { name: '可执行文件与快捷方式', extensions: ['exe', 'lnk', 'url', 'bat', 'cmd'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      return result.canceled ? null : result.filePaths[0];
    });

    ipcMain.handle('dialog:pick-image', async () => {
      const result = await dialog.showOpenDialog(win, {
        // 头像、封面、自定义背景都走这个选择器，所以标题保持中性
        title: '选择图片',
        properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] }],
      });
      return result.canceled ? null : result.filePaths[0];
    });

    ipcMain.handle('dialog:pick-audio', async () => {
      const result = await dialog.showOpenDialog(win, {
        title: '选择歌曲',
        properties: ['openFile'],
        filters: [{ name: '音频', extensions: ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac'] }],
      });
      return result.canceled ? null : result.filePaths[0];
    });

    ipcMain.handle('dialog:pick-directory', async () => {
      const result = await dialog.showOpenDialog(win, {
        title: '选择文件夹',
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? null : result.filePaths[0];
    });
}

module.exports = { installDialogIpc };
