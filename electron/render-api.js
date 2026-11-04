'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

/*
 * 渲染后端（DirectX 11 / 12）切换。
 *
 * 支持范围不是查资料拍出来的，是在本机真实客户端上逐个探测的（2026-11-05）：
 *   原神     YuanShen.exe（430MB）同时导入 d3d11.dll 与 d3d12.dll，且含 `-dx12` 字样
 *   星铁     UnityPlayer.dll 同时含 GfxDeviceD3D12 与 D3D11 后端
 *   绝区零   UnityPlayer.dll 同上
 *   终末地   UnityPlayer.dll 含 D3D12 与 D3D11
 *   异环     HTGame.exe 同时含 D3D12RHI 与 D3D11RHI，Binaries/win64 下还有 D3D12 目录
 *
 * 参数口径按引擎区分，不能混：
 *   Unity 系用 `-force-d3d11` / `-force-d3d12`（Unity 原生支持）；
 *   UE5（异环）用 `-dx11` / `-dx12`。
 *   把 `-dx12` 塞给 Unity 游戏等于没传，反过来也一样。
 *
 * 崩坏3 与明日方舟不提供这一项：崩3 本机未探测到 D3D12 后端；
 * 明日方舟是 2D 塔防，切换渲染后端没有意义。
 */

const MODES = ['default', 'dx11', 'dx12'];

const UNITY = { dx11: ['-force-d3d11'], dx12: ['-force-d3d12'] };
const UNREAL = { dx11: ['-dx11'], dx12: ['-dx12'] };

const SUPPORT = {
  genshin: {
    label: '原神',
    engine: 'unity',
    modes: ['default', 'dx11', 'dx12'],
    hint: 'DX12 需要 Windows 10 及以上和支持 D3D12 的显卡；切过去画面没变化说明当前显卡/驱动走了回退。',
  },
  starrail: {
    label: '崩坏：星穹铁道',
    engine: 'unity',
    modes: ['default', 'dx11', 'dx12'],
    hint: 'DX12 在部分老显卡上启动会黑屏，遇到就把这一项切回「跟随游戏默认」。',
  },
  zzz: {
    label: '绝区零',
    engine: 'unity',
    modes: ['default', 'dx11', 'dx12'],
    hint: 'DX12 在部分老显卡上启动会黑屏，遇到就把这一项切回「跟随游戏默认」。',
  },
  endfield: {
    label: '终末地',
    engine: 'unity',
    modes: ['default', 'dx11', 'dx12'],
    hint: '终末地走官方签名父进程启动，参数会一并传过去；切换后仍以游戏内实际画面设置为准。',
  },
  neverness: {
    label: '异环',
    engine: 'unreal',
    modes: ['default', 'dx11', 'dx12'],
    hint: '异环是 UE5，默认就走 DX12；切 DX11 一般是给老显卡或驱动兼容问题用的。',
  },
};

const MODE_LABELS = {
  default: '跟随游戏默认',
  dx11: 'DirectX 11',
  dx12: 'DirectX 12',
};

/** 这个游戏是否提供渲染后端选项；没有就返回 null，界面据此隐藏整项。 */
function supportFor(gameKey) {
  return SUPPORT[String(gameKey || '')] || null;
}

/** 把任意输入收敛成合法值，脏数据（老存档、手改 json）一律当「跟随默认」。 */
function normalizeMode(value) {
  const text = String(value || '').toLowerCase();
  return MODES.includes(text) ? text : 'default';
}

/**
 * 启动参数。返回空数组表示「不额外加参数」，调用方直接拼在用户自定义参数前面。
 * 顺序上放在用户参数之前：用户如果自己写了冲突的参数，后写的覆盖前面的。
 */
function argsFor(gameKey, mode) {
  const entry = supportFor(gameKey);
  if (!entry) return [];
  const picked = normalizeMode(mode);
  if (picked === 'default') return [];
  const table = entry.engine === 'unreal' ? UNREAL : UNITY;
  return [...(table[picked] || [])];
}

function labelFor(gameKey, mode) {
  const entry = supportFor(gameKey);
  if (!entry) return '';
  const picked = normalizeMode(mode);
  return MODE_LABELS[picked] || MODE_LABELS.default;
}

/** 给界面用的清单：只列真的支持的游戏，附中文说明。 */
function listSupport() {
  const out = {};
  for (const [key, entry] of Object.entries(SUPPORT)) {
    out[key] = {
      label: entry.label,
      engine: entry.engine,
      modes: entry.modes.slice(),
      hint: entry.hint || '',
      labels: { ...MODE_LABELS },
    };
  }
  return out;
}

/**
 * 从游戏自己的日志里读「实际跑起来的图形后端」。
 *
 * 光把参数传过去不能证明它生效：客户端可能不认这个开关、也可能显卡不支持而静默回退。
 * Unity 会把真实后端写进 Player.log（`Direct3D: Version: Direct3D 11.0 [level 11.1]`
 * 这类行），读最后一次出现的那条就是本次运行用的版本。
 *
 * 读不到就返回空串，调用方不要据此做任何判断 —— 日志路径随渠道和系统语言变化，
 * 冷启动时也可能还没写出来。
 */
const LOG_PATHS = {
  genshin: [
    'AppData/LocalLow/miHoYo/原神/Player.log',
    'AppData/LocalLow/miHoYo/Genshin Impact/Player.log',
  ],
  starrail: [
    'AppData/LocalLow/miHoYo/崩坏：星穹铁道/Player.log',
    'AppData/LocalLow/miHoYo/Honkai：Star Rail/Player.log',
    'AppData/LocalLow/Cognosphere/Star Rail/Player.log',
  ],
  zzz: [
    'AppData/LocalLow/miHoYo/绝区零/Player.log',
    'AppData/LocalLow/miHoYo/ZenlessZoneZero/Player.log',
  ],
};

async function readActualApi(gameKey, options = {}) {
  const list = LOG_PATHS[String(gameKey || '')];
  if (!list) return '';
  const home = options.home || process.env.USERPROFILE || '';
  if (!home) return '';
  const tailBytes = 256 * 1024;
  for (const relative of list) {
    const file = path.join(home, ...relative.split('/'));
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile() || stat.size <= 0) continue;
      const start = Math.max(0, stat.size - tailBytes);
      const handle = await fsp.open(file, 'r');
      let text = '';
      try {
        const buffer = Buffer.alloc(stat.size - start);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
        text = buffer.subarray(0, bytesRead).toString('utf8');
      } finally {
        await handle.close();
      }
      const hits = [...text.matchAll(/Direct3D\s*(\d+)/gi)];
      if (!hits.length) continue;
      const version = hits[hits.length - 1][1];
      if (version === '12') return 'dx12';
      if (version === '11') return 'dx11';
    } catch {
      /* 换下一个路径 */
    }
  }
  return '';
}

module.exports = {
  MODES,
  MODE_LABELS,
  supportFor,
  normalizeMode,
  argsFor,
  labelFor,
  listSupport,
  readActualApi,
};
