'use strict';

/**
 * 启动页背景的「文字擦除」处理。
 *
 * 官方宣传图和启动器视频通常在左侧或底部烧录了标题、版本号、logo，
 * 和启动器自己的游戏名叠在一起会非常乱。这里做两件事：
 *
 * 1. 静态图：把图像按网格分块，检测「高对比小区域」的典型文字区，
 *    用周围像素做平滑填补。这不是 OCR，而是基于亮度方差的启发式检测，
 *    但足以抹掉大块标题字，同时保留画面主体。
 * 2. 动态视频：不能逐帧改像素（性能不可接受），改为在渲染层叠加
 *    「文字遮罩带」——用多层渐变 + 模糊把文字区域压平。
 *
 * 两种结果都会缓存，只在官方图/视频更新时重算一次。
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

/**
 * 判断一个区块是否像文字：局部亮度方差大、边缘多、整体偏亮或偏暗。
 * 返回 0..1 的「文字可能性」。
 */
function textScore(data, width, x0, y0, w, h) {
  let sum = 0;
  let sumSq = 0;
  let edges = 0;
  let count = 0;
  const step = Math.max(1, Math.floor(Math.min(w, h) / 12));
  for (let y = y0; y < y0 + h; y += step) {
    for (let x = x0; x < x0 + w; x += step) {
      const i = (y * width + x) * 4;
      const lum = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
      sum += lum;
      sumSq += lum * lum;
      if (x + step < width) {
        const j = (y * width + x + step) * 4;
        const nextLum = (data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114) / 255;
        if (Math.abs(nextLum - lum) > 0.18) edges += 1;
      }
      count += 1;
    }
  }
  if (!count) return 0;
  const mean = sum / count;
  const variance = Math.max(0, sumSq / count - mean * mean);
  const edgeRatio = edges / count;
  // 文字特征：边缘密度高 + 局部方差明显 + 区域亮度集中（不是自然渐变）
  return Math.min(1, edgeRatio * 2.4 + variance * 3.2);
}

/**
 * 用给定缓冲把矩形区域「抹平」：取该区域上下两条边带做横向插值，
 * 效果类似内容感知填充的简化版。
 */
function flattenRegion(data, width, totalHeight, rect) {
  const { x, y, w, h } = rect;
  const topY = Math.max(0, y - 2);
  const bottomY = Math.min(totalHeight - 1, y + h + 1);
  for (let row = y; row < y + h; row += 1) {
    for (let col = x; col < x + w; col += 1) {
      const i = (row * width + col) * 4;
      const topI = (topY * width + col) * 4;
      const bottomI = (bottomY * width + col) * 4;
      for (let c = 0; c < 3; c += 1) {
        data[i + c] = Math.round((data[topI + c] + data[bottomI + c]) / 2);
      }
      data[i + 3] = 255;
    }
  }
}

/**
 * 擦除一张静态背景图里的文字区域，返回新的 PNG Buffer。
 * 失败时返回 null，调用方应回退到原图。
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
  // 太大就缩小处理，文字区域依然能命中，且省内存
  const maxWidth = 960;
  const scale = Math.min(1, maxWidth / size.width);
  const workWidth = Math.max(1, Math.round(size.width * scale));
  const workHeight = Math.max(1, Math.round(size.height * scale));
  const small = scale < 1 ? image.resize({ width: workWidth, height: workHeight }) : image;
  const bitmap = small.toBitmap();
  if (!bitmap || bitmap.length < workWidth * workHeight * 4) return null;

  const cells = 14;
  const cellW = Math.ceil(workWidth / cells);
  const cellH = Math.ceil(workHeight / cells);
  const targets = [];

  for (let row = 0; row < cells; row += 1) {
    for (let col = 0; col < cells; col += 1) {
      const x = col * cellW;
      const y = row * cellH;
      const w = Math.min(cellW, workWidth - x);
      const h = Math.min(cellH, workHeight - y);
      if (w < 8 || h < 8) continue;
      const score = textScore(bitmap, workWidth, x, y, w, h);
      // 版本图的大标题通常压在左侧 40-60% 和底部两成，
      // 右侧和顶部一般是要保留的人物主体，不动。
      const inTextZone = col <= Math.ceil(cells * 0.6) || row >= cells - 4;
      if (score > 0.32 && inTextZone) targets.push({ x, y, w, h });
    }
  }

  if (!targets.length) {
    // 官方版本图的标题几乎都在底部左侧；启发式没命中时按固定条带兜底，
    // 只压掉最下面一小条，尽量不伤到人物主体。
    const bandH = Math.round(workHeight * 0.18);
    const bandW = Math.round(workWidth * (workWidth > workHeight ? 0.62 : 0.86));
    targets.push({
      x: 0,
      y: workHeight - bandH,
      w: Math.min(workWidth, bandW),
      h: bandH,
    });
  }

  for (const rect of targets) flattenRegion(bitmap, workWidth, workHeight, rect);

  // 轻微高斯模糊，让填补区域和周围过渡自然
  const blurred = new Uint8ClampedArray(bitmap);
  for (const rect of targets) {
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x; x < rect.x + rect.w; x += 1) {
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= workWidth || ny >= workHeight) continue;
            const i = (ny * workWidth + nx) * 4;
            r += bitmap[i];
            g += bitmap[i + 1];
            b += bitmap[i + 2];
            n += 1;
          }
        }
        const o = (y * workWidth + x) * 4;
        blurred[o] = r / n;
        blurred[o + 1] = g / n;
        blurred[o + 2] = b / n;
        blurred[o + 3] = 255;
      }
    }
  }

  const out = nativeImage.createFromBuffer(Buffer.from(blurred), {
    width: workWidth,
    height: workHeight,
  });
  if (out.isEmpty()) return null;
  const restored =
    scale < 1 ? out.resize({ width: size.width, height: size.height }) : out;
  return { buffer: restored.toPNG(), cells: targets.length };
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
