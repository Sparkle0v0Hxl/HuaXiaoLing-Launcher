'use strict';

/**
 * 鸣潮（Wuthering Waves）启动参数。
 *
 * 为什么需要这个模块（2026-11-16 「提示要官方启动器」）：
 *
 * 库洛客户端 `Client-Win64-Shipping.exe` 启动后会做一条 UE4 断言：
 *   Fatal error: [File:Unknown] [Line: 54] kuro: Use launcher to start game!
 * 只要断言触发，进程十几秒到几十秒就自己退掉 —— 表现就是「点了开始游戏，弹一下就没了」。
 *
 * 关键事实（本机实测，见 _wuwa-ab-test.ps1）：
 *   - 客户端二进制里**没有** QueryFullProcessImageName / NtQueryInformationProcess /
 *     ParentProcessId 这类读父进程路径的 API。所以它**不是**在检查「父进程是不是官方启动器」，
 *     父进程是谁根本不重要。
 *   - 它要的是「由启动器给出的启动上下文」：pak 加密密钥（bNeedExternalKeys）、
 *     UKuroLauncherLibrary 注入的库函数、以及命令行里的画质档位。
 *   - A/B 实测：同一个父进程（PowerShell Start-Process）、同一个 exe，
 *     不带参数 → 进程退出；带 `-krqlv=hd` → 进程存活。
 *   - 对照参考项目 Haiyu（_haiyu/BundleGameResourceProvider.Launch.cs）也是直接 spawn
 *     本体 + 拼 `-krqlv=<hd|sd|uhd>`（外加可选的 `-krpkg=<type>`），也不介入父进程。
 *
 * 画质档位从哪来：客户端根目录的 `launcherDownloadConfig.json` 里 `bundles` 的键。
 * 官服 `{"appId":"10003",...,"bundles":{"HD":{...}}}`、B服 `{"appId":"10004",...,"bundles":{"HD":{...}}}`，
 * 所以两个渠道都是 hd。键名大小写不固定（HD / hd / SD / UHD），统一转小写。
 *
 * 注意：这个参数是**必需**的 —— 缺了客户端就断言自杀。所以这里读不到配置时也不能放弃，
 * 退到 hd（HD 是官方唯一在发的档位，最不可能出错），并让调用方把日志记下来。
 */

const fs = require('node:fs');
const path = require('node:path');

const LAUNCHER_CONFIG_NAME = 'launcherDownloadConfig.json';

/** 合法的画质档位。客户端里对应 `%sHD/`、`%sSD/`、`%sUHD/` 三种 pak 目录。 */
const QUALITY_VALUES = ['hd', 'sd', 'uhd'];

/**
 * 从 launcherDownloadConfig.json 里读出画质档位。
 *
 * @param {string} clientRoot 客户端本体根目录（含 launcherDownloadConfig.json 的那一层）
 * @returns {string} hd / sd / uhd；读不到时返回 ''（调用方决定退路）
 */
function readQualityFromConfig(clientRoot) {
  if (!clientRoot) return '';
  let raw = '';
  try {
    raw = fs.readFileSync(path.join(clientRoot, LAUNCHER_CONFIG_NAME), 'utf8');
  } catch {
    return '';
  }
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    return '';
  }
  const bundles = data && typeof data.bundles === 'object' && data.bundles ? data.bundles : null;
  if (!bundles) return '';
  for (const key of Object.keys(bundles)) {
    const value = String(key || '').trim().toLowerCase();
    if (QUALITY_VALUES.includes(value)) return value;
  }
  return '';
}

/**
 * 往上级目录找本体根（最多 5 层），判定依据是根目录里有 launcherDownloadConfig.json。
 * 传 exe 或目录都行。
 */
function findClientRoot(dirOrExe) {
  let dir = String(dirOrExe || '').trim();
  if (!dir) return '';
  if (path.extname(dir).toLowerCase() === '.exe') dir = path.dirname(dir);
  dir = path.normalize(dir);
  for (let depth = 0; depth < 5 && dir; depth += 1) {
    if (fs.existsSync(path.join(dir, LAUNCHER_CONFIG_NAME))) return dir;
    const next = path.dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return '';
}

/**
 * 算出鸣潮启动时必须带的参数。
 *
 * @param {string} target 启动目标（客户端 exe 或其所在目录）
 * @param {string[]} existingArgs 已经拼好的参数（用户自定义 + 渲染后端）
 * @returns {{ args: string[], quality: string, source: string, note: string }}
 *   args    —— 需要追加到命令行里的参数（已去掉用户自己写过的同类参数）
 *   quality —— 实际采用的画质档位
 *   source  —— 档位来源：'config' | 'fallback-hd' | 'none'
 *   note    —— 给日志看的一句话说明
 */
function resolveLaunchArgs(target, existingArgs) {
  const args = Array.isArray(existingArgs) ? existingArgs.map((item) => String(item)) : [];

  // 用户自己已经写了 -krqlv=xxx 就尊重用户的，不覆盖（后写的参数优先，客户端取最后一个）。
  const userPicked = args.some((item) => /^\s*-krqlv=/i.test(item));
  if (userPicked) {
    const picked = (args.find((item) => /^\s*-krqlv=/i.test(item)) || '').replace(/^\s*-krqlv=/i, '').toLowerCase();
    return {
      args: [],
      quality: QUALITY_VALUES.includes(picked) ? picked : picked,
      source: 'user',
      note: `用户自己指定了 -krqlv=${picked}，不覆盖`,
    };
  }

  const root = findClientRoot(target);
  const fromConfig = readQualityFromConfig(root);
  const quality = QUALITY_VALUES.includes(fromConfig) ? fromConfig : 'hd';

  if (!QUALITY_VALUES.includes(fromConfig)) {
    return {
      args: ['-krqlv=hd'],
      quality,
      source: 'fallback-hd',
      note: root
        ? `launcherDownloadConfig.json 里没认出的画质档位（读到 "${fromConfig || '空'}"），按官方在发的 HD 走`
        : '没找到 launcherDownloadConfig.json，按官方在发的 HD 走',
    };
  }
  return {
    args: ['-krqlv=' + quality],
    quality,
    source: 'config',
    note: `画质档位取自 launcherDownloadConfig.json 的 bundles（${quality}）`,
  };
}

module.exports = {
  LAUNCHER_CONFIG_NAME,
  QUALITY_VALUES,
  readQualityFromConfig,
  findClientRoot,
  resolveLaunchArgs,
};
