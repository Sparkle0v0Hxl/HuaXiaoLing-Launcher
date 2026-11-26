'use strict';

/*
 * 蓝色星原：切服 = 换启动器的渠道配置（整份复制，不解密不修改）。
 *
 * ── 原理（2026-11-26 用户实测确认）────────────────────────────────
 * 渠道身份完全由 <启动器目录>/res/app_config.dat 决定：
 *   官服 C000 = 192 字节
 *   B服  C001 = 368 字节
 * 这两个文件本身就是加好密的完整成品，**不需要解密再加密**，
 * 切换时整份复制即可。用户实测：换完双击 launcher.exe 就进了 B服，
 * 而 launcher.exe 和其余 79 个文件一个都没动。
 *
 * ── 配置从哪来 ──────────────────────────────────────────────────
 *   ① userData 已有 → 直接用
 *   ② 本机装了对应渠道的启动器 → 直接读它的 res/app_config.dat（零下载）
 *   ③ 都没有 → 从官方安装包提取（官服 URL 固定可远程取，B服 需用户提供安装包）
 */

const fs = require('node:fs');
const path = require('node:path');
const azurChannel = require('./azur-channel');

/** 各渠道常见的启动器安装根目录（用于「本机已装」的探测）。 */
const LAUNCHER_ROOTS = [
  'H:\\AzurPromilia',
  'H:\\AzurPromilia bilibili',
  'C:\\Program Files\\AzurPromilia',
  'C:\\Program Files (x86)\\AzurPromilia',
  'D:\\AzurPromilia',
  'E:\\AzurPromilia',
];

/**
 * 把某个渠道的配置写进启动器，让下次启动走那个渠道。
 *
 * @param {object} opts
 * @param {string} opts.userData
 * @param {string} opts.channel  'official' | 'bilibili' | 'global'
 * @param {string} [opts.launcherDir] 目标启动器目录（不给就按渠道自动找）
 * @param {(msg:string)=>void} [opts.onLog]
 * @returns {Promise<{ok:boolean, channelCode?:string, launcherDir?:string, size?:number, source?:string, error?:string}>}
 */
async function applyChannelToLauncher({ userData, channel, launcherDir, onLog = () => {} } = {}) {
  const channelCode = channelToCode(channel);
  if (!channelCode) {
    return { ok: false, error: `蓝色星原没有「${channel}」这个渠道` };
  }

  /* 目标启动器目录 */
  const targetDir = launcherDir || pickLauncherDir(channelCode);
  if (!targetDir) {
    return {
      ok: false,
      error: `没有找到${azurChannel.KNOWN_CHANNELS[channelCode].label}的官方启动器目录，请先在设置里指定它的位置。`,
    };
  }

  /* 拿配置 */
  let acquired;
  try {
    acquired = await azurChannel.acquireChannelConfig({
      userData,
      channelCode,
      launcherRoots: LAUNCHER_ROOTS,
    });
  } catch (error) {
    return { ok: false, error: error.message };
  }
  onLog(`[azur] 渠道配置来源：${acquired.source}（${acquired.size} 字节）`);

  /* 写进去 */
  let applied;
  try {
    applied = await azurChannel.applyChannelConfig(userData, channelCode, targetDir);
  } catch (error) {
    return { ok: false, error: error.message };
  }

  onLog(
    applied.changed
      ? `[azur] 已把 ${channelCode} 配置写入 ${targetDir}（${applied.size} 字节）`
      : `[azur] ${targetDir} 已是 ${channelCode}，无需改动`
  );

  return {
    ok: true,
    channelCode,
    launcherDir: targetDir,
    size: applied.size,
    changed: applied.changed,
    source: acquired.source,
  };
}

/** 渠道英文名 → 官方渠道号。 */
function channelToCode(channel) {
  const key = String(channel || '').toLowerCase();
  if (key === 'official') return 'C000';
  if (key === 'bilibili') return 'C001';
  /* 国际服 / 繁中走 C500，但那是另一套客户端目录，暂不在这里处理 */
  return '';
}

/**
 * 按渠道挑一个启动器目录。
 *
 * 优先找「当前配置就是该渠道」的（说明那个目录本来就是这个渠道的启动器）；
 * 找不到就退回第一个可用的（换配置后它就变成该渠道了）。
 */
function pickLauncherDir(channelCode) {
  const dirs = azurChannel.findLauncherDirs(LAUNCHER_ROOTS);
  if (!dirs.length) return '';
  for (const d of dirs) {
    const cutils = azurChannel.loadCutils(d.dir);
    const info = azurChannel.readChannelCode(d.dir, cutils);
    if (info && info.channelCode === channelCode) return d.dir;
  }
  /* 没有现成同渠道的，用第一个（官服优先） */
  return dirs[0].dir;
}

/** 读当前启动器是哪个渠道（给界面显示用）。 */
function currentLauncherChannel(launcherDir) {
  if (!launcherDir) return null;
  const cutils = azurChannel.loadCutils(launcherDir);
  const info = azurChannel.readChannelCode(launcherDir, cutils);
  if (!info) return null;
  const meta = azurChannel.KNOWN_CHANNELS[info.channelCode];
  return {
    channelCode: info.channelCode,
    channel: meta ? meta.channel : '',
    label: meta ? meta.label : info.channelCode,
    size: info.size,
    launcherDir,
  };
}

/** 列出本机所有蓝原启动器及其当前渠道。 */
function listLaunchers() {
  const dirs = azurChannel.findLauncherDirs(LAUNCHER_ROOTS);
  return dirs.map((d) => {
    const cur = currentLauncherChannel(d.dir);
    return {
      dir: d.dir,
      exe: d.exe,
      channelCode: cur ? cur.channelCode : '',
      label: cur ? cur.label : '未知渠道',
      size: cur ? cur.size : 0,
    };
  });
}

module.exports = {
  applyChannelToLauncher,
  channelToCode,
  pickLauncherDir,
  currentLauncherChannel,
  listLaunchers,
  LAUNCHER_ROOTS,
};
