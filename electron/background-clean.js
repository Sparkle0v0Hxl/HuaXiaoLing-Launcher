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
 * 擦除一张静态背景图里的文字区域，返回新的 PNG Buffer。
 * 没找到任何可擦的文字像素时返回 null，调用方回退原图。
 */
async function eraseImageText(nativeImage, sourcePath) {
  let image;
  try {
    image = nativeImage.createFromPath(sourcePath);
  } catch {
    return null;
  }
  if (!image || image.isEmpty()) return null;

  const size = image.getSize();
  if (!size.width || !size.height) return null;

  // 按 2560 宽的验证基准工作；更大才缩，1280 以下维持原尺寸
  const maxWidth = 2560;
  const scale = Math.min(1, maxWidth / size.width);
  const w = Math.max(1, Math.round(size.width * scale));
  const h = Math.max(1, Math.round(size.height * scale));
  const work = scale < 1 ? image.resize({ width: w, height: h }) : image;
  const bitmap = work.toBitmap();
  if (!bitmap || bitmap.length < w * h * 4) return null;

  const n = w * h;
  // toBitmap 是 BGRA：读的时候换成 RGB，亮度权重才对
  const rgba = new Uint8ClampedArray(n * 4);
  for (let p = 0, i = 0; p < n; p += 1, i += 4) {
    rgba[i] = bitmap[i + 2];
    rgba[i + 1] = bitmap[i + 1];
    rgba[i + 2] = bitmap[i];
    rgba[i + 3] = 255;
  }

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

  // 文字带：左 43% × 上 40%（参数按 2560 基准验证）
  const zoneX = Math.round(w * 0.43);
  const zoneY = Math.round(h * 0.4);
  let mask = new Uint8Array(n);
  for (let y = 0; y < zoneY; y += 1) {
    for (let x = 0; x < zoneX; x += 1) {
      const p = y * w + x;
      if (lum[p] > 0.42 && sat[p] < 0.38) mask[p] = 1;
    }
  }
  let masked = 0;
  for (let p = 0; p < n; p += 1) masked += mask[p];
  if (masked < n * 0.0004) return null; // 带里没有成片的亮字，不硬擦

  // 膨胀半径 / 羽化半径按分辨率等比换算
  const dilateR = Math.max(6, Math.round((w / 2560) * 26));
  const featherR = Math.max(3, Math.round((w / 2560) * 11));
  mask = dilate(mask, w, h, dilateR);

  // 1/8 缩小图上做调和填补
  const S = 8;
  const sw = Math.max(1, Math.floor(w / S));
  const sh = Math.max(1, Math.floor(h / S));
  const small = new Float32Array(sw * sh * 3);
  const counts = new Float32Array(sw * sh);
  const hitCounts = new Float32Array(sw * sh);
  for (let y = 0; y < h; y += 1) {
    const sy = Math.min(sh - 1, (y / S) | 0);
    for (let x = 0; x < w; x += 1) {
      const si = sy * sw + Math.min(sw - 1, (x / S) | 0);
      const i = (y * w + x) * 4;
      small[si * 3] += rgba[i];
      small[si * 3 + 1] += rgba[i + 1];
      small[si * 3 + 2] += rgba[i + 2];
      counts[si] += 1;
      if (mask[y * w + x]) hitCounts[si] += 1;
    }
  }
  for (let p = 0; p < sw * sh; p += 1) {
    const k = counts[p] || 1;
    small[p * 3] /= k;
    small[p * 3 + 1] /= k;
    small[p * 3 + 2] /= k;
  }

  // 掩膜也降到小图：块内覆盖率 > 2.5% 算命中（对应 Python 双线性 >6/255）
  const smallMask = new Uint8Array(sw * sh);
  for (let p = 0; p < sw * sh; p += 1) {
    if (counts[p] > 0 && hitCounts[p] > counts[p] * 0.025) smallMask[p] = 1;
  }
  const smDilated = dilate(smallMask, sw, sh, 1);
  const ring = dilate(smDilated, sw, sh, 3);
  let ringCount = 0;
  const seed = [0, 0, 0];
  for (let p = 0; p < sw * sh; p += 1) {
    if (ring[p] && !smDilated[p]) {
      ringCount += 1;
      seed[0] += small[p * 3];
      seed[1] += small[p * 3 + 1];
      seed[2] += small[p * 3 + 2];
    }
  }
  if (ringCount) {
    seed[0] /= ringCount;
    seed[1] /= ringCount;
    seed[2] /= ringCount;
  } else {
    seed[0] = 10;
    seed[1] = 13;
    seed[2] = 23;
  }

  let fill = small.slice();
  for (let p = 0; p < sw * sh; p += 1) {
    if (smDilated[p]) {
      fill[p * 3] = seed[0];
      fill[p * 3 + 1] = seed[1];
      fill[p * 3 + 2] = seed[2];
    }
  }
  // 迭代扩散：掩膜内反复模糊，掩膜外每轮贴回原图。分片让出主进程，
  // 不至于把一次 2~3 秒的填补整个卡在事件循环上。
  for (let iter = 0; iter < 2000; iter += 1) {
    fill = boxBlur(fill, sw, sh, 3, 2);
    for (let p = 0; p < sw * sh; p += 1) {
      if (!smDilated[p]) {
        fill[p * 3] = small[p * 3];
        fill[p * 3 + 1] = small[p * 3 + 1];
        fill[p * 3 + 2] = small[p * 3 + 2];
      }
    }
    if (iter % 300 === 299) await new Promise((resolve) => setImmediate(resolve));
  }

  // 双线性放大回工作分辨率
  const up = new Float32Array(n * 3);
  const fx = sw / w;
  const fy = sh / h;
  for (let y = 0; y < h; y += 1) {
    const gy = Math.min(sh - 1, Math.max(0, (y + 0.5) * fy - 0.5));
    const y0 = Math.floor(gy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = gy - y0;
    for (let x = 0; x < w; x += 1) {
      const gx = Math.min(sw - 1, Math.max(0, (x + 0.5) * fx - 0.5));
      const x0 = Math.floor(gx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = gx - x0;
      const p = y * w + x;
      for (let c = 0; c < 3; c += 1) {
        // 插值源必须是 fill（填补场）：用 small 等于把原图缩略又放回去
        const top = fill[(y0 * sw + x0) * 3 + c] * (1 - wx) + fill[(y0 * sw + x1) * 3 + c] * wx;
        const bot = fill[(y1 * sw + x0) * 3 + c] * (1 - wx) + fill[(y1 * sw + x1) * 3 + c] * wx;
        up[p * 3 + c] = top * (1 - wy) + bot * wy;
      }
    }
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

  const out = nativeImage.createFromBuffer(outBuf, { width: w, height: h });
  if (out.isEmpty()) return null;
  const restored = scale < 1 ? out.resize({ width: size.width, height: size.height }) : out;
  return { buffer: restored.toPNG(), cells: masked };
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
