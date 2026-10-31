'use strict';

/**
 * 启动页背景的「文字擦除」处理（v2）。
 *
 * 官方版本图的标题 / 版本号 / logo 几乎都烧录在左上角（左侧 43% × 上侧
 * 40% 的范围），且文字是「亮 + 低饱和」的美术字。做法：
 *
 * 1. 在文字带里挑出亮（luma > 0.42）且低饱和（sat < 0.38）的像素当种子，
 *    膨胀 26px 把笔画间的字腔、柔光投影一并罩住；
 * 2. 把原图缩到 1/8，在低分辨率上做调和填补（反复盒式模糊、掩膜外像素
 *    每轮贴回原图），收敛后放大回原尺寸 —— 文字带本来是渐变天空 / 暗角，
 *    低分辨率的调和场放上去足够平滑；
 * 3. 掩膜经 11px 盒式模糊当羽化权重，把填补层和原图混合，过渡落在
 *    干净背景上，不留字形轮廓。
 *
 * 结果按源文件 mtime 缓存（clean3.png），只在官方图更新时重算一次。
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

/* 图片解码：nativeImage 只能解 png / jpg，官方版本图现在大量是 webp
   （原神 / 星铁 / 绝区零都是 2560×1440 的 VP8X），createFromPath 直接返回
   空图 —— 去字逻辑因此静默失败，启动页只能显示带烧录文字的原图。

   这里借渲染进程的 Chromium 解码：离屏 BrowserWindow 里画到 canvas，再把
   RGBA 取回来。顺带用 drawImage 的高质量缩放把宽度压到 2560 以内，省掉
   后续手工缩放的模糊损失。窗口复用，只在官方图更新时跑一次。 */
let decoderWindow = null;

async function ensureDecoderWindow() {
  if (decoderWindow && !decoderWindow.isDestroyed()) return decoderWindow;
  const { BrowserWindow } = require('electron');
  decoderWindow = new BrowserWindow({
    show: false,
    width: 16,
    height: 16,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true },
  });
  await decoderWindow.loadURL('about:blank');
  return decoderWindow;
}

function mimeOf(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (ext === 'webp') return 'image/webp';
  if (ext === 'avif') return 'image/avif';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  return 'image/png';
}

async function decodeToRgba(sourcePath, maxWidth = 2560) {
  // 1) 先试 nativeImage（png / jpg 能解，快且不依赖窗口）
  try {
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromPath(sourcePath);
    if (img && !img.isEmpty()) {
      const size = img.getSize();
      if (size.width && size.height) {
        const scale = Math.min(1, maxWidth / size.width);
        const w = Math.max(1, Math.round(size.width * scale));
        const h = Math.max(1, Math.round(size.height * scale));
        const shaped = scale < 1 ? img.resize({ width: w, height: h }) : img;
        const bitmap = shaped.toBitmap(); // BGRA
        if (bitmap && bitmap.length >= w * h * 4) {
          const rgba = new Uint8ClampedArray(w * h * 4);
          for (let p = 0; p < w * h; p += 1) {
            const i = p * 4;
            rgba[i] = bitmap[i + 2];
            rgba[i + 1] = bitmap[i + 1];
            rgba[i + 2] = bitmap[i];
            rgba[i + 3] = 255;
          }
          return { width: w, height: h, rgba };
        }
      }
    }
  } catch {
    /* 落到 Chromium 解码 */
  }

  // 2) webp / avif 等：交渲染进程解
  try {
    const buffer = await fsp.readFile(sourcePath);
    const dataUrl = `data:${mimeOf(sourcePath)};base64,${buffer.toString('base64')}`;
    const win = await ensureDecoderWindow();
    const raw = await win.webContents.executeJavaScript(
      `(async () => {
        const img = new Image();
        img.src = ${JSON.stringify(dataUrl)};
        await img.decode();
        const scale = Math.min(1, ${maxWidth} / img.naturalWidth);
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h).data;
        const CHUNK = 0x8000;
        let s = '';
        for (let i = 0; i < d.length; i += CHUNK) {
          s += String.fromCharCode.apply(null, d.subarray(i, i + CHUNK));
        }
        return JSON.stringify({ w: w, h: h, b64: btoa(s) });
      })()`,
      true
    );
    const parsed = JSON.parse(raw);
    const rgba = new Uint8ClampedArray(Buffer.from(parsed.b64, 'base64'));
    if (!parsed.w || !parsed.h || rgba.length < parsed.w * parsed.h * 4) return null;
    return { width: parsed.w, height: parsed.h, rgba };
  } catch {
    return null;
  }
}

/** 盒式模糊（c 通道 Float32 图），两次累积和滑窗，O(n) 与半径无关。 */
function boxBlur(src, w, h, c, r) {
  if (r < 1) return src.slice();
  const tmp = new Float32Array(src.length);
  const win = 2 * r + 1;
  for (let y = 0; y < h; y += 1) {
    const row = y * w * c;
    for (let ch = 0; ch < c; ch += 1) {
      let sum = 0;
      for (let k = -r; k <= r; k += 1) {
        sum += src[row + Math.min(w - 1, Math.max(0, k)) * c + ch];
      }
      tmp[row + ch] = sum / win;
      for (let x = 1; x < w; x += 1) {
        sum +=
          src[row + Math.min(w - 1, x + r) * c + ch] -
          src[row + Math.max(0, x - r - 1) * c + ch];
        tmp[row + x * c + ch] = sum / win;
      }
    }
  }
  const out = new Float32Array(src.length);
  for (let x = 0; x < w; x += 1) {
    const col = x * c;
    for (let ch = 0; ch < c; ch += 1) {
      let sum = 0;
      for (let k = -r; k <= r; k += 1) {
        sum += tmp[Math.min(h - 1, Math.max(0, k)) * w * c + col + ch];
      }
      out[col + ch] = sum / win;
      for (let y = 1; y < h; y += 1) {
        sum +=
          tmp[Math.min(h - 1, y + r) * w * c + col + ch] -
          tmp[Math.max(0, y - r - 1) * w * c + col + ch];
        out[y * w * c + col + ch] = sum / win;
      }
    }
  }
  return out;
}

/** 二值膨胀：4 邻域 + 两对角，n 轮。返回新数组。 */
function dilate(mask, w, h, n) {
  let cur = mask;
  for (let pass = 0; pass < n; pass += 1) {
    const next = new Uint8Array(cur.length);
    for (let y = 0; y < h; y += 1) {
      const rowUp = (y - 1) * w;
      const rowDown = (y + 1) * w;
      const row = y * w;
      for (let x = 0; x < w; x += 1) {
        const i = row + x;
        if (cur[i]) {
          next[i] = 1;
          continue;
        }
        if (
          (x > 0 && cur[i - 1]) ||
          (x < w - 1 && cur[i + 1]) ||
          (y > 0 && cur[rowUp + x]) ||
          (y < h - 1 && cur[rowDown + x]) ||
          (x > 0 && y > 0 && cur[rowUp + x - 1]) ||
          (x < w - 1 && y < h - 1 && cur[rowDown + x + 1])
        ) {
          next[i] = 1;
        }
      }
    }
    cur = next;
  }
  return cur;
}

/**
 * 灰度形态学可分离滤波：isMin=true 取窗口最小值（腐蚀），否则取最大值（膨胀）。
 * 顶帽变换用它把「细亮结构」和「大块亮区」分开 —— 这是保住人物头发、
 * 只擦掉烧录文字的关键：腐蚀会整块抹掉比结构元素更细的亮物。
 */
function grayMorph(src, w, h, r, isMin) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const pick = isMin ? Math.min : Math.max;
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    for (let x = 0; x < w; x += 1) {
      let acc = src[row + x];
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w - 1, x + r);
      for (let k = x0; k <= x1; k += 1) acc = pick(acc, src[row + k]);
      tmp[row + x] = acc;
    }
  }
  for (let x = 0; x < w; x += 1) {
    for (let y = 0; y < h; y += 1) {
      let acc = tmp[y * w + x];
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(h - 1, y + r);
      for (let k = y0; k <= y1; k += 1) acc = pick(acc, tmp[k * w + x]);
      out[y * w + x] = acc;
    }
  }
  return out;
}

/**
 * 擦除一张静态背景图里的文字区域，返回新的 PNG Buffer。
 * 没找到任何可擦的文字像素时返回 null，调用方回退原图。
 */
async function eraseImageText(nativeImage, sourcePath) {
  // webp 走 Chromium 解码，png / jpg 走 nativeImage；解码时已按 2560 宽封顶。
  const decoded = await decodeToRgba(sourcePath, 2560);
  if (!decoded) return null;
  const w = decoded.width;
  const h = decoded.height;
  if (!w || !h) return null;

  const n = w * h;
  const rgba = decoded.rgba;
  if (!rgba || rgba.length < n * 4) return null;

  // 亮度 / 饱和度
  const lum = new Float32Array(n);
  const sat = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p += 1, i += 4) {
    const r = rgba[i] / 255;
    const g = rgba[i + 1] / 255;
    const b = rgba[i + 2] / 255;
    lum[p] = r * 0.299 + g * 0.587 + b * 0.114;
    sat[p] = Math.max(r, g, b) - Math.min(r, g, b);
  }

  // 文字带：左 43% × 上 40%（参数按 2560 基准验证）。原神这类版本图上，
  // 人物发丝也会伸进这条带里，所以「按亮度挑像素」必然把头发一起擦掉。
  const zoneX = Math.round(w * 0.43);
  const zoneY = Math.round(h * 0.4);

  /* 形态学顶帽变换：把「细的亮结构（笔画）」和「大块亮区（头发 / 高光）」分开。
     开运算（先腐蚀后膨胀，半径 R）会整块抹掉比结构元素更细的亮物，于是
     lum - opened 只在笔画上为正；整片白发被开运算原样保留、差值≈0，就不会被擦。
     在 1/4 缩略图上算（640×360 量级），可分离的 O(nR) 滑窗开销可忽略。 */
  const S = 4;
  const sw = Math.max(1, Math.floor(w / S));
  const sh = Math.max(1, Math.floor(h / S));
  const lumSmall = new Float32Array(sw * sh);
  const cntSmall = new Float32Array(sw * sh);
  for (let y = 0; y < h; y += 1) {
    const sy = Math.min(sh - 1, (y / S) | 0);
    const row = y * w;
    for (let x = 0; x < w; x += 1) {
      const si = sy * sw + Math.min(sw - 1, (x / S) | 0);
      lumSmall[si] += lum[row + x];
      cntSmall[si] += 1;
    }
  }
  for (let p = 0; p < sw * sh; p += 1) lumSmall[p] /= cntSmall[p] || 1;

  // 笔画宽约 10~40px（2560 基准），结构元素半径折到缩略图约 7px（≈全分辨率 56px）
  const structR = Math.max(2, Math.round((sw / 640) * 7));
  const eroded = grayMorph(lumSmall, sw, sh, structR, true);
  const opened = grayMorph(eroded, sw, sh, structR, false);
  const tophat = new Float32Array(sw * sh);
  for (let p = 0; p < sw * sh; p += 1) tophat[p] = lumSmall[p] - opened[p];

  let mask = new Uint8Array(n);
  const tzX = Math.min(sw, Math.ceil(zoneX / S));
  const tzY = Math.min(sh, Math.ceil(zoneY / S));
  for (let sy = 0; sy < tzY; sy += 1) {
    for (let sx = 0; sx < tzX; sx += 1) {
      const sp = sy * sw + sx;
      if (tophat[sp] < 0.12) continue; // 不是「比周围细而亮」的结构
      if (lumSmall[sp] < 0.38) continue; // 太暗，不像烧录文字
      const yEnd = Math.min(h, (sy + 1) * S);
      const xEnd = Math.min(w, (sx + 1) * S);
      for (let y = sy * S; y < yEnd; y += 1) {
        const row = y * w;
        for (let x = sx * S; x < xEnd; x += 1) mask[row + x] = 1;
      }
    }
  }
  let masked = 0;
  for (let p = 0; p < n; p += 1) masked += mask[p];
  if (masked < n * 0.0002) return null; // 带里没有成片的亮字，不硬擦
  // 命中面积过大（>16% 像素）说明这张图整体就是亮的、没有可分离的烧录文字
  if (masked > n * 0.16) return null;

  // 膨胀半径 / 羽化半径按分辨率等比换算。只兜住笔画间隙与柔光边，
  // 半径给大了会把笔画外围的好像素一起吞掉，擦完留下色块。
  const dilateR = Math.max(3, Math.round((w / 2560) * 10));
  const featherR = Math.max(3, Math.round((w / 2560) * 11));
  mask = dilate(mask, w, h, dilateR);

  /* 回填：逐行最近干净像素插值。
     旧版是在 1/8 缩略图上填单一底色、再做 2000 次盒式模糊扩散，大片字区会被
     抹成一整块均匀色斑 —— 这就是用户说的「扣完后都模糊化」。官方版本图在文字带
     上基本都是平滑渐变 / 光效，横向插值就足以抹掉字，同时保住渐变与明暗层次。 */
  const leftX = new Int32Array(n).fill(-1);
  const rightX = new Int32Array(n).fill(-1);
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    let last = -1;
    for (let x = 0; x < w; x += 1) {
      const p = row + x;
      if (mask[p]) leftX[p] = last;
      else last = x;
    }
    last = -1;
    for (let x = w - 1; x >= 0; x -= 1) {
      const p = row + x;
      if (mask[p]) rightX[p] = last;
      else last = x;
    }
  }
  // 整行都被字占满时退化用纵向插值
  const upY = new Int32Array(n).fill(-1);
  const downY = new Int32Array(n).fill(-1);
  for (let x = 0; x < w; x += 1) {
    let last = -1;
    for (let y = 0; y < h; y += 1) {
      const p = y * w + x;
      if (mask[p]) upY[p] = last;
      else last = y;
    }
    last = -1;
    for (let y = h - 1; y >= 0; y -= 1) {
      const p = y * w + x;
      if (mask[p]) downY[p] = last;
      else last = y;
    }
  }

  // 全图干净像素均色，极端情况（邻接都找不到）兜底
  let fbR = 0;
  let fbG = 0;
  let fbB = 0;
  let cleanCount = 0;
  for (let p = 0; p < n; p += 1) {
    if (mask[p]) continue;
    const i = p * 4;
    fbR += rgba[i];
    fbG += rgba[i + 1];
    fbB += rgba[i + 2];
    cleanCount += 1;
  }
  if (cleanCount) {
    fbR /= cleanCount;
    fbG /= cleanCount;
    fbB /= cleanCount;
  }

  const up = new Float32Array(n * 3);
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    for (let x = 0; x < w; x += 1) {
      const p = row + x;
      const o = p * 3;
      const i = p * 4;
      if (!mask[p]) {
        up[o] = rgba[i];
        up[o + 1] = rgba[i + 1];
        up[o + 2] = rgba[i + 2];
        continue;
      }
      const L = leftX[p];
      const R = rightX[p];
      const U = upY[p];
      const D = downY[p];
      const hasH = L >= 0 && R >= 0;
      const hasV = U >= 0 && D >= 0;
      if (!hasH && !hasV) {
        up[o] = fbR;
        up[o + 1] = fbG;
        up[o + 2] = fbB;
        continue;
      }
      let hr = 0;
      let hg = 0;
      let hb = 0;
      let vr = 0;
      let vg = 0;
      let vb = 0;
      if (hasH) {
        const t = R === L ? 0.5 : (x - L) / (R - L);
        const li = (row + L) * 4;
        const ri = (row + R) * 4;
        hr = rgba[li] * (1 - t) + rgba[ri] * t;
        hg = rgba[li + 1] * (1 - t) + rgba[ri + 1] * t;
        hb = rgba[li + 2] * (1 - t) + rgba[ri + 2] * t;
      }
      if (hasV) {
        const t = D === U ? 0.5 : (y - U) / (D - U);
        const ui = (U * w + x) * 4;
        const di = (D * w + x) * 4;
        vr = rgba[ui] * (1 - t) + rgba[di] * t;
        vg = rgba[ui + 1] * (1 - t) + rgba[di + 1] * t;
        vb = rgba[ui + 2] * (1 - t) + rgba[di + 2] * t;
      }
      if (hasH && hasV) {
        // 双向平均：只用横向插值，会在成行的大标题里留下一条条横向色带，
        // 在渐变背景上看就是一块椭圆形的雾。纵向再插一次取平均，
        // 两个方向的拉伸互相抵消，过渡才自然。
        up[o] = (hr + vr) * 0.5;
        up[o + 1] = (hg + vg) * 0.5;
        up[o + 2] = (hb + vb) * 0.5;
      } else if (hasH) {
        up[o] = hr;
        up[o + 1] = hg;
        up[o + 2] = hb;
      } else {
        up[o] = vr;
        up[o + 1] = vg;
        up[o + 2] = vb;
      }
    }
    if (y % 300 === 299) await new Promise((resolve) => setImmediate(resolve));
  }

  /* 掩膜内再跑几轮扩散平滑：二维插值仍会在边界留接缝，
     每轮模糊后把掩膜外的像素贴回原图，只让填补场在字区内部收敛，
     这样既抹平接缝，又不会把周围的明暗层次一起拉平。 */
  const smoothR = Math.max(2, Math.round((w / 2560) * 5));
  for (let iter = 0; iter < 14; iter += 1) {
    const blurred = boxBlur(up, w, h, 3, smoothR);
    for (let p = 0; p < n; p += 1) {
      if (!mask[p]) continue;
      up[p * 3] = blurred[p * 3];
      up[p * 3 + 1] = blurred[p * 3 + 1];
      up[p * 3 + 2] = blurred[p * 3 + 2];
    }
    if (iter % 4 === 3) await new Promise((resolve) => setImmediate(resolve));
  }

  // 羽化掩膜
  const maskF = new Float32Array(n);
  for (let p = 0; p < n; p += 1) maskF[p] = mask[p];
  const soft = boxBlur(maskF, w, h, 1, featherR);

  // 合成：rgba 是 RGB 序，outBuf 要按 nativeImage 的 BGRA 序写回
  const outBuf = Buffer.alloc(n * 4);
  for (let p = 0, i = 0; p < n; p += 1, i += 4) {
    const a = Math.min(1, Math.max(0, soft[p]));
    // outBuf: B G R A
    outBuf[i] = Math.round(rgba[i + 2] * (1 - a) + up[p * 3 + 2] * a);
    outBuf[i + 1] = Math.round(rgba[i + 1] * (1 - a) + up[p * 3 + 1] * a);
    outBuf[i + 2] = Math.round(rgba[i] * (1 - a) + up[p * 3] * a);
    outBuf[i + 3] = 255;
  }

  const out = require('electron').nativeImage.createFromBuffer(outBuf, { width: w, height: h });
  if (out.isEmpty()) return null;
  return { buffer: out.toPNG(), cells: masked };
}

/**
 * 处理并缓存：只有源文件比缓存新时才重算。
 */
async function ensureErasedBackground({ nativeImage, sourcePath, cachePath }) {
  try {
    const [sourceStat, cacheStat] = await Promise.all([
      fsp.stat(sourcePath).catch(() => null),
      fsp.stat(cachePath).catch(() => null),
    ]);
    if (!sourceStat) return null;
    if (cacheStat && cacheStat.mtimeMs >= sourceStat.mtimeMs) return cachePath;

    const result = await eraseImageText(nativeImage, sourcePath);
    if (!result) return null;
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    await fsp.writeFile(cachePath, result.buffer);
    return cachePath;
  } catch {
    return null;
  }
}

module.exports = { eraseImageText, ensureErasedBackground };
