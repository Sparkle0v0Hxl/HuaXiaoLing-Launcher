'use strict';

/**
 * PowerShell 可执行文件的定位。
 *
 * 为什么需要这个模块：
 * 以前不少地方直接写 `execFile('powershell.exe', ...)`，靠 PATH 去找。开发机上有
 * System32 在 PATH 里，一切正常；但用户的机器上 PATH 经常被安全软件、精简版系统、
 * 或者「只装了 PowerShell 7」之类的情况改坏，这时 spawn 会直接报
 * `spawn powershell.exe ENOENT`，功能就哑了 —— 最典型的是生成 B服客户端时
 * 解压渠道 SDK 那一步，报错还不明显，用户只看到「硬链接过程提示 ENOENT」。
 *
 * 这里的做法和 main.js 里原先的 powershellExe() 一致：先按 SystemRoot 拼绝对路径，
 * 64 位系统上优先 Sysnative（32 位进程访问 64 位 System32 的正确入口），
 * 全都不存在时才退回裸名字（留一手，万一有系统把 PowerShell 装在别处并配好了 PATH）。
 */

const fs = require('fs');
const path = require('path');

/** 缓存结果，避免每次 spawn 前都做三次 existsSync。 */
let cached = null;

/**
 * 拿到可用的 powershell.exe 路径。
 * @returns {string} 绝对路径；实在找不到时返回 'powershell.exe'（交给 PATH 兜底）
 */
function powershellExe() {
  if (cached) return cached;

  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const candidates = [
    // 32 位进程在 64 位系统上：System32 会被重定向到 SysWOW64，Sysnative 才是真的 64 位
    path.join(root, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        cached = candidate;
        return cached;
      }
    } catch {
      /* 权限不足之类，继续试下一个 */
    }
  }

  cached = 'powershell.exe';
  return cached;
}

/** 测试用：清掉缓存。 */
function resetPowershellCache() {
  cached = null;
}

module.exports = { powershellExe, resetPowershellCache };
