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
 * 顺序很重要：B服 → 国际服（game_biz / uapc 的硬标记优先于 cps）→ 国服。
 * 返回 '' 表示「这份 ini 里没有足够的证据」，绝不瞎猜。
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
  if (/taiwan|台服|繁中/i.test(folder)) return 'taiwan';
  if (/yostar/i.test(folder)) return 'global';
  return '';
}

/** 同步版：ini → 路径 → 默认官服。保持 2.9.0 之前的调用契约。 */
function channelFromInstallPath(exePath) {
  return configChannelFromPath(exePath) || pathChannelHint(exePath) || 'official';
}

module.exports = {
  decodeIni,
  parseIni,
  classifyIni,
  readClientConfig,
  configChannelFromPath,
  gameVersionFromPath,
  pathChannelHint,
  channelFromInstallPath,
};
