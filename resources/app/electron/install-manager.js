'use strict';

/**
 * 安装与更新：检测已装版本 + 与官方最新版对比。
 *
 * 只做「信息层」——把本地版本、官方版本、安装位置、更新源摊开给用户看，
 * 并给出可执行动作（启动官方启动器 / 打开安装目录 / 跳官网）。
 *
 * 为什么不自己做全量下载更新：
 *   1. 米哈游的更新要走 hyp.dll 的分段客户端，拿不到清单就无法校验完整性；
 *   2. 鹰角的分卷 zip 是 43GB 级别，自研下载器没有断点续传校验是灾难；
 *   3. 用户装官方启动器后，更新本来就该由它负责，重复造轮子风险大于收益。
 * 所以这里给的是「看得到 + 一键到官方入口」，而不是假装能替它更新。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** 从 exe 的文件版本信息里读版本号（米哈游 Unity 游戏都写了 FileVersion）。 */
function fileVersion(exePath) {
  try {
    const script = `(Get-Item -LiteralPath '${String(exePath).replace(/'/g, "''")}').VersionInfo.FileVersion`;
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 }
    );
    const text = String(out || '').trim();
    return text || '';
  } catch {
    return '';
  }
}

/** 目录里是否像是一个游戏安装（有几个大文件 + exe）。 */
function looksInstalled(root, entryName) {
  if (!root) return null;
  try {
    const stat = fs.statSync(root);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  const entry = path.join(root, entryName);
  const hasEntry = fs.existsSync(entry);
  let totalBytes = 0;
  let fileCount = 0;
  try {
    // 只算第一层 + 一级子目录，够判断「是不是装过」了，不做全量扫描
    for (const name of fs.readdirSync(root)) {
      const full = path.join(root, name);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isFile()) {
        totalBytes += st.size;
        fileCount += 1;
      } else if (st.isDirectory()) {
        try {
          for (const sub of fs.readdirSync(full)) {
            const sf = path.join(full, sub);
            const st2 = fs.statSync(sf);
            if (st2.isFile()) {
              totalBytes += st2.size;
              fileCount += 1;
            }
          }
        } catch {
          /* 没权限的目录跳过 */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return { root, entry, hasEntry, totalBytes, fileCount };
}

/**
 * 米哈游官方启动器：注册表里记着安装路径。
 * 读不到就退回常见安装目录。
 */
function miyousheLauncherCandidates() {
  const fromReg = [];
  const regKeys = [
    'HKCU\\Software\\miHoYo\\HYP',
    'HKLM\\Software\\miHoYo\\HYP',
    'HKLM\\Software\\WOW6432Node\\miHoYo\\HYP',
  ];
  for (const key of regKeys) {
    try {
      const out = execFileSync('reg.exe', ['query', key, '/v', 'InstallPath'], {
        encoding: 'buffer',
        windowsHide: true,
        timeout: 5000,
      });
      const text = out.toString('latin1');
      const match = text.match(/InstallPath\s+REG_\w+\s+(\S.*?)\s*$/m);
      if (match) fromReg.push(match[1].trim());
    } catch {
      /* 没有就跳过 */
    }
  }
  const common = [
    'C:\\Program Files\\miHoYo Launcher',
    'C:\\Program Files\\HoYoPlay',
    'D:\\Program Files\\miHoYo Launcher',
    'D:\\HoYoPlay',
    'E:\\miHoYo Launcher',
    'E:\\HoYoPlay',
  ];
  return [...fromReg, ...common];
}

function findMiyousheLauncher() {
  const exeNames = ['HYP.exe', 'launcher.exe', 'HoYoPlay.exe'];
  for (const dir of miyousheLauncherCandidates()) {
    for (const name of exeNames) {
      const full = path.join(dir, name);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

module.exports = { fileVersion, looksInstalled, findMiyousheLauncher, miyousheLauncherCandidates };
