/*
 * 客户端渠道判定（官服 / B服 / 国际服）。
 *
 * 为什么单独一个模块：这段逻辑以前埋在 main.js 里，只能靠 `fs.readFileSync(...,'utf8')`
 * 读 config.ini。2026-11-04 有用户报「星铁 / 绝区零的国际服被检测成官服」，
 * 根子是两件事：
 *   1. 米哈游三件套里只有原神的 config.ini 一定带 `game_biz=hk4e_global`；
 *      星铁 / 绝区零的国际服客户端常常**没有 game_biz**，渠道信息在
 *      `cps=hyp_hoyoverse` 和 `uapc={"hkrpg_global":…}` 里；
 *   2. 那份 config.ini 可能是 UTF-16（带 BOM 或双字节零填充），按 utf8 读出来
 *      字符之间夹着 \0，`cps` / `channel` 一个都匹配不上，于是静默落到
 *      「默认官服」分支 —— 路径被写进官服那一行，更新比对也就按 *_cn 走了。
 *
 * 所以这里做三件事：编码自适应解析、多字段交叉判定、以及「读不出来就承认读不出来」
 * （返回空字符串，由调用方决定回退，而不是默默当成官服）。
 *
 * 判定依据优先级（越靠前越可信）：
 *   config.ini 的 game_biz / cps / uapc  →  安装路径里的 global / bilibili 字样
 *   →  exe 名（GenshinImpact.exe 是国际服、YuanShen.exe 是国服）
 *   →  exe 文件版本信息的 CompanyName（COGNOSPHERE = 国际服，米哈游 = 国服）
 */

const fs = require('fs');
const path = require('path');

/** 把 config.ini 的 Buffer 解成文本：兼容 UTF-8 / UTF-8 BOM / UTF-16 LE / UTF-16 BE。 */
function decodeIni(buffer) {
  if (!buffer || !buffer.length) return '';
  // UTF-16 LE / BE 的 BOM
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const low = swapped[i];
      swapped[i] = swapped[i + 1];
      swapped[i + 1] = low;
    }
    return swapped.toString('utf16le');
  }
  // 没有 BOM 的 UTF-16 LE：ASCII 文本会在奇数位上出现大量 \0
  const sample = buffer.subarray(0, Math.min(400, buffer.length));
  let oddNul = 0;
  let evenNul = 0;
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) {
      if (i % 2 === 1) oddNul += 1;
      else evenNul += 1;
    }
  }
  if (oddNul > sample.length / 8 && oddNul > evenNul * 4) return buffer.toString('utf16le');
  const text = buffer.toString('utf8');
  // UTF-8 BOM
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 极简 ini 解析：只要第一个出现的值，段名忽略（这些键都在 [General] 里）。 */
function parseIni(text) {
  const out = new Map();
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#') || line.startsWith('[')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    if (!key || out.has(key)) continue;
    out.set(key, line.slice(eq + 1).trim());
  }
  return out;
}

/**
 * 按 ini 字段判定渠道。
 *
 * 顺序很重要：B服 → 国际服（game_biz / uapc 的硬标记优先于 cps）→ 国服。
 * 返回 '' 表示「这份 ini 里没有足够的证据」，绝不瞎猜。
 *
 * 2026-11-17 说明（用户报障：「绝区零 B服和官服共用一个文件夹」）：
 * 这里**只看 config.ini**。第三方三服切换器会把官服目录里的 config.ini 改成
 * `cps=bilibili`，于是这个目录会被判成 B服 —— 光看 ini 分不出「真 B服客户端」
 * 和「被改过配置的官服客户端」。真正的区别在文件层：B服客户端带渠道 SDK
 * （BLPlatform64 目录），官服本体没有。那一层判据见 resolveChannelFromRoot()。
 * 所以这个函数保持原样（纯 ini 判读），别在这里加「game_biz 优先」——
 * 真 B服客户端的 game_biz 同样是 *_cn（和官服同包），那样会把真 B服判成官服。
 */
function classifyIni(fields) {
  if (!fields) return '';
  const biz = String(fields.get('game_biz') || '').toLowerCase();
  const cps = String(fields.get('cps') || '').toLowerCase();
  const channel = String(fields.get('channel') || '').trim();
  const uapc = String(fields.get('uapc') || '').toLowerCase();
  const sdk = String(fields.get('sdk_version') || '').toLowerCase();

  if (/bilibili/.test(biz) || /bilibili/.test(cps) || channel === '14') return 'bilibili';
  if (/_global\b/.test(biz) || biz === 'global') return 'global';
  if (/_global"/.test(uapc) || /"_global"/.test(uapc)) return 'global';
  if (/_cn\b/.test(biz) || biz === 'cn') return 'official';
  if (/_cn"/.test(uapc)) return 'official';
  // 国际服用 HoYoverse 账号体系，国服用米哈游 / gw_PC
  if (/hoyoverse|cognosphere/.test(cps)) return 'global';
  if (/mihoyo|gw_pc|hyp_cn/.test(cps)) return 'official';
  if (/_global/.test(sdk)) return 'global';
  return '';
}

/**
 * 这个客户端目录里有没有 B服渠道 SDK。
 *
 * B服客户端比官服多一套渠道件（B站自己的登录/支付 SDK），装在：
 *   · 绝区零 / 星铁：<Game>_Data\Plugins\x86_64\BLPlatform64\  ← 在_Data 里面，不在根目录
 *   · 方舟 / 终末地：根目录的 PCGameSDK.dll
 * 这是「文件层」证据，比 config.ini 可信 —— ini 会被第三方三服切换器改，
 * 渠道件不会凭空出现。
 *
 * 2026-11-17 修正：以前只查根目录，结果 B服运行时（渠道件在 _Data\Plugins 里）
 * 被判成官服，界面上那一行直接变成「目录已不在」。
 * 现在往下找三层，但只在 *_Data\Plugins 下面找，避免整棵树乱扫。
 */
function hasBilibiliChannelSdk(root) {
  const dir = String(root || '');
  if (!dir) return false;
  try {
    if (fs.existsSync(path.join(dir, 'BLPlatform64'))) return true;
    if (fs.existsSync(path.join(dir, 'PCGameSDK.dll'))) return true;
    // <Game>_Data\Plugins\x86_64\BLPlatform64（绝区零 / 星铁的渠道件实际位置）
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const item of entries) {
      if (!item.isDirectory()) continue;
      if (!/_Data$/i.test(item.name)) continue;
      const dataDir = path.join(dir, item.name);
      const plugins = path.join(dataDir, 'Plugins');
      if (!fs.existsSync(plugins)) continue;
      let archDirs = [];
      try {
        archDirs = fs.readdirSync(plugins, { withFileTypes: true });
      } catch {
        archDirs = [];
      }
      for (const arch of archDirs) {
        if (!arch.isDirectory()) continue;
        if (fs.existsSync(path.join(plugins, arch.name, 'BLPlatform64'))) return true;
      }
    }
  } catch {
    /* 读不到就当没有 */
  }
  return false;
}

/**
 * 结合 config.ini 与文件层证据判定一个客户端目录到底是哪个渠道。
 *
 * 返回 { channel, evidence }：
 *   channel  '' = 认不出来；'official'/'bilibili'/'global' = 认出来的渠道
 *   evidence 'config'        = 只有 ini 声明
 *           'config+sdk'     = ini 说 B服，且目录里确实有 B服渠道 SDK（真 B服）
 *           'config-conflict'= ini 说 B服，但没有渠道 SDK —— 说明 ini 被第三方
 *                            切换器改过，这份客户端本体其实是官服
 *
 * 2026-11-17 新增（用户报障：「绝区零 B服和官服共用一个文件夹」）：
 * 第三方三服切换器会把官服目录的 config.ini 改成 cps=bilibili，于是官服本体
 * 被判成 B服，自动扫描就把官服路径写进了 B服 那一行 —— 两个渠道共用一个目录。
 * 有了这层「文件层」复核，同一份官服本体无论 ini 被改成什么样，都只会算官服。
 */
function resolveChannelFromRoot(root) {
  const dir = String(root || '');
  if (!dir) return { channel: '', evidence: 'none' };
  const config = readClientConfig(dir);
  if (!config) return { channel: '', evidence: 'none' };
  const declared = classifyIni(config.fields);
  if (declared !== 'bilibili') {
    return { channel: declared, evidence: declared ? 'config' : 'none' };
  }
  if (hasBilibiliChannelSdk(dir)) return { channel: 'bilibili', evidence: 'config+sdk' };
  // ini 说 B服但没有渠道 SDK：这份客户端本体不是 B服
  return { channel: 'official', evidence: 'config-conflict' };
}

/** 读某个客户端目录里的 config.ini；读不到返回 null。 */
function readClientConfig(dir) {
  const target = path.join(dir, 'config.ini');
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile()) return null;
    const text = decodeIni(fs.readFileSync(target));
    const fields = parseIni(text);
    return { text, fields, size: stat.size };
  } catch {
    return null;
  }
}

/**
 * 按编码自适应读一份 ini（不限 config.ini）。
 *
 * 给「要按行改写 ini」的场景用：直接用 fs.readFileSync(file, 'utf8') 读国际服那种
 * UTF-16 的 config.ini，拿到的是满屏乱码，正则匹配不上，改写时会把 cps / game_biz
 * 这些行整份丢掉——客户端的渠道信息就这么没了。
 */
function readIniText(filePath) {
  try {
    return decodeIni(fs.readFileSync(filePath));
  } catch {
    return '';
  }
}

/** 只看 config.ini 的渠道判定：读不出来就返回 ''（调用方不该拿它当官服）。 */
function configChannelFromPath(exePath) {
  if (!exePath) return '';
  const config = readClientConfig(path.dirname(exePath));
  if (!config) return '';
  return classifyIni(config.fields);
}

/**
 * 读客户端 config.ini 里声明的 game_version。
 * 版本号原本是「一个游戏一个」，哪个服更新就写哪个服的版本，切到另一个版本不同的服
 * 就会显示成错的（官服 7.2 切到 7.1 的国际服，界面还写 v7.2）。切服时拿它纠正。
 * 只认纯数字分段，读不到 / 格式怪就返回 ''，绝不覆盖已有版本。
 */
function gameVersionFromPath(exePath) {
  if (!exePath) return '';
  const config = readClientConfig(path.dirname(exePath));
  if (!config) return '';
  const raw = String(config.fields.get('game_version') || '').trim();
  if (!/^\d+(\.\d+){1,3}$/.test(raw)) return '';
  // 7.2.0 → 7.2：与更新链路写进来的两位版本号保持一致
  return raw.replace(/\.0$/, '');
}

/** 安装路径 / 文件名里的线索：比 ini 弱，但不需要读文件。 */
function pathChannelHint(exePath) {
  const folder = String(exePath || '');
  if (/global|国际服/i.test(folder)) return 'global';
  if (/bilibili|b服/i.test(folder)) return 'bilibili';
  // 原神的国际服 exe 叫 GenshinImpact.exe，国服叫 YuanShen.exe
  if (/GenshinImpact\.exe$/i.test(folder)) return 'global';
  if (/YuanShen\.exe$/i.test(folder)) return 'official';
  /*
   * 崩坏3 官方安装器按 game_biz 建目录（bh3_cn / bh3_global），
   * 明日方舟的海外客户端目录里带 Yostar / 台服发行商名。
   * 这些游戏没有米哈游式的 config.ini，目录名往往就是唯一线索。
   */
  if (/bh3_cn/i.test(folder)) return 'official';
  // 崩坏3 国际服目录是 bh3_global：上面第一条 /global|国际服/ 已经能命中（2026-11-17 实测确认）
  // 台服（繁中）官方目录名是 Arknights_TC，公司名 Gryphline
  if (/taiwan|台服|繁中|Arknights_TC|Gryphline/i.test(folder)) return 'taiwan';
  if (/yostar/i.test(folder)) return 'global';
  return '';
}

/** 同步版：ini → 路径 → 默认官服。保持 2.9.0 之前的调用契约。 */
function channelFromInstallPath(exePath) {
  return configChannelFromPath(exePath) || pathChannelHint(exePath) || 'official';
}

/**
 * 渠道 key → 界面上给用户看的名字。
 *
 * 只在「渠道体检」的提示文案里用（切服/启动时发现这一行指向了别的服的客户端）。
 * 别拿它当渠道表的权威来源：哪个渠道存不存在由 main.js 的 builtinChannels 说了算。
 */
function channelLabel(channel) {
  const key = String(channel || '').trim();
  const map = {
    official: '官服',
    bilibili: 'B服',
    global: '国际服',
    wegame: 'WeGame 版',
    custom: '自定义',
    taiwan: '台服',
  };
  return map[key] || key || '未知渠道';
}

module.exports = {
  decodeIni,
  parseIni,
  classifyIni,
  readClientConfig,
  readIniText,
  configChannelFromPath,
  gameVersionFromPath,
  pathChannelHint,
  channelFromInstallPath,
  channelLabel,
  hasBilibiliChannelSdk,
  resolveChannelFromRoot,
};
