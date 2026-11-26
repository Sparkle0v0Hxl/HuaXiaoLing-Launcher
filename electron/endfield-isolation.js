'use strict';

/**
 * 终末地渠道运行时「隔离性」快速检查（生成/切服后当场跑）。
 *
 * ── 为什么只查根目录 ──────────────────────────────────────────────────
 *
 * 隔离问题全部发生在**根目录**这一层：
 *   · 渠道 SDK 冲突：hgsdk.dll ↔ gfsdk.dll / glfoundation.dll（都在根目录）
 *   · sdkdata 配置走错通道：sdkdata/sdk_*_config（sdkdata 是根目录下的直接子目录）
 *   · 误删全渠道通用件：PlatformProcess.exe / webviewsdk.dll / onechannellc.dll（根目录）
 *
 * 所以只读**一层目录列表**就能覆盖最致命的 90% 问题 —— 开销是几次 readdir，
 * 几十毫秒，对硬盘几乎没有负担。
 *
 * 刻意**不**做的（留给 `_verify-endfield-channel-isolation.js` 那个离线脚本）：
 *   · 递归比对每个可写文件的 inode（硬链接穿透检查）—— 要 stat 上万个文件，
 *     那是「离线体检」的活，不该塞进用户每次切服的路径里。
 *   · 拿官方本体当基准做全量差异 —— 同理。
 *
 * 换句话说：这个模块负责「立刻发现明显错」，离线脚本负责「彻底体检」。
 */

const fs = require('node:fs');
const path = require('node:path');

/* ── 规则表（与 main.js / 离线脚本保持同步）────────────────────────── */

/** 每个渠道「绝对不能有」的其它渠道专属件。 */
const FOREIGN_FILES = {
  official: ['gfsdk.dll', 'glfoundation.dll', 'PCGameSDK.dll', 'BLPlatform64', 'discord_partner_sdk.dll', 'socialsdk_gf.dll'],
  bilibili: ['gfsdk.dll', 'glfoundation.dll', 'discord_partner_sdk.dll', 'socialsdk_gf.dll'],
  global: ['hgsdk.dll', 'PCGameSDK.dll', 'BLPlatform64'],
  play: ['hgsdk.dll', 'PCGameSDK.dll', 'BLPlatform64'],
  steam: ['hgsdk.dll', 'PCGameSDK.dll', 'BLPlatform64'],
};

/** 每个渠道 sdkdata 下允许保留的 sdk_*_config 前缀。 */
const SDK_KEEP = {
  official: ['sdk_hgsdk_config'],
  bilibili: [],
  global: ['sdk_glsdk_config'],
  play: ['sdk_glsdk_config'],
  steam: ['sdk_hgsdk_config', 'sdk_glsdk_config'],
};

/** 全渠道通用、绝不能缺的平台组件（误删会让官方完整性校验失败）。 */
const UNIVERSAL_REQUIRED = ['PlatformProcess.exe', 'webviewsdk.dll', 'onechannellc.dll'];

/** 每个渠道必须有的文件。 */
const CHANNEL_REQUIRED = {
  official: ['Endfield.exe'],
  bilibili: ['Endfield.exe', 'hgsdk.dll'],
  global: ['Endfield.exe'],
  play: ['Endfield.exe'],
  steam: ['Endfield.exe'],
};

/**
 * 检查一个渠道运行时目录的根层隔离性。
 *
 * 全程同步 readdir（只有一两层，量很小）。任何异常都吞掉 ——
 * 这是个「锦上添花」的检查，绝不能让生成/切服流程因为它失败。
 *
 * @param {string} runtimeRoot 运行时根目录
 * @param {string} channel 渠道 key（official / bilibili / global / play / steam）
 * @returns {{ok:boolean, problems:string[], checked:number}}
 */
function checkChannelRuntimeIsolation(runtimeRoot, channel) {
  const problems = [];
  let checked = 0;
  try {
    const dir = String(runtimeRoot || '');
    const ch = String(channel || '').toLowerCase();
    if (!dir || !ch) return { ok: true, problems, checked };

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // 目录不存在：不算问题（可能是刚被清掉、或被用户挪走）
      return { ok: true, problems, checked };
    }
    const lower = new Map();
    for (const e of entries) lower.set(e.name.toLowerCase(), { name: e.name, isDir: e.isDirectory() });
    checked = entries.length;

    /* ① 外渠道文件混入 */
    for (const name of FOREIGN_FILES[ch] || []) {
      const hit = lower.get(name.toLowerCase());
      if (hit) {
        problems.push(
          '混入了外渠道文件 ' + hit.name + '（' + ch + ' 渠道不该有它，会导致平台 SDK 冲突、启动几秒就崩）'
        );
      }
    }

    /* ② 全渠道通用件缺失 */
    for (const name of UNIVERSAL_REQUIRED) {
      if (!lower.has(name.toLowerCase())) {
        problems.push(
          '缺全渠道通用文件 ' + name + '（官方完整性校验会报「检查资源完整性时发现异常」）'
        );
      }
    }

    /* ③ 本渠道必需件缺失 */
    for (const name of CHANNEL_REQUIRED[ch] || []) {
      if (!lower.has(name.toLowerCase())) {
        problems.push('缺本渠道必需文件 ' + name);
      }
    }

    /* ④ sdkdata 里的 SDK 配置只能是本渠道的 */
    const sdkEntry = lower.get('sdkdata');
    if (sdkEntry && sdkEntry.isDir) {
      const keep = SDK_KEEP[ch] || [];
      let sdkNames = [];
      try {
        sdkNames = fs.readdirSync(path.join(dir, sdkEntry.name));
      } catch {
        sdkNames = [];
      }
      for (const n of sdkNames) {
        if (!/^sdk_[a-z]+_config/i.test(n)) continue;
        const nLower = n.toLowerCase();
        const allowed = keep.some((p) => nLower.startsWith(p.toLowerCase()));
        if (!allowed) {
          problems.push(
            'sdkdata 里混入了不该有的配置 ' + n + '（' + ch + ' 只允许：' + (keep.length ? keep.join(', ') : '无') + '）'
          );
        }
      }
    }
  } catch (error) {
    // 检查本身出错：记为一条问题，让调用方至少能在日志里看到
    problems.push('隔离检查自身异常：' + (error && error.message ? error.message : error));
  }
  return { ok: problems.length === 0, problems, checked };
}

module.exports = {
  checkChannelRuntimeIsolation,
  FOREIGN_FILES,
  SDK_KEEP,
  UNIVERSAL_REQUIRED,
  CHANNEL_REQUIRED,
};
