'use strict';

/**
 * 异环抽卡导出工具（NTE_Gacha_Exporter）一键获取。
 *
 * 流程：GitHub API 查最新 release 的 zip 资产 → 直连下载，失败自动换国内加速镜像
 * （ghfast.top / github.moeyy.xyz，直接前缀拼原始 URL 的通用加速格式）→
 * PowerShell Expand-Archive 解压到系统下载目录 → 由调用方打开文件夹。
 *
 * 安全边界：只下载 release 里名字匹配 nte-gacha-exporter-*.zip 的官方资产，
 * 解压目标是下载目录下的独立文件夹；不代跑第三方 exe，运行（含管理员权限）由用户自己做。
 */

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const RELEASE_API = 'https://api.github.com/repos/Anong0u0/NTE_Gacha_Exporter/releases/latest';
const ASSET_PATTERN = /^nte-gacha-exporter-\d[\w.-]*\.zip$/i;
// 空串 = 直连；后面是镜像前缀（镜像规则：前缀 + 完整原始 URL）
const MIRRORS = ['', 'https://ghfast.top/', 'https://github.moeyy.xyz/'];

async function fetchJson(url, signal) {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/vnd.github+json' },
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** 查最新 release 里工具压缩包的下载信息。 */
async function resolveAsset(signal) {
  const release = await fetchJson(RELEASE_API, signal);
  const asset = (release.assets || []).find((item) => ASSET_PATTERN.test(String(item.name || '')));
  if (!asset) throw new Error('发布页里没有找到工具压缩包');
  return {
    version: String(release.tag_name || '').replace(/^v/i, ''),
    name: String(asset.name),
    size: Number(asset.size) || 0,
    url: String(asset.browser_download_url || ''),
  };
}

async function downloadTo(url, target, onProgress, signal) {
  let lastError = null;
  for (const mirror of MIRRORS) {
    // 每个镜像独立开写流，失败时先关句柄再删半截文件（Windows 上句柄没关 rm 会 EBUSY）
    const stream = fs.createWriteStream(target);
    try {
      const response = await fetch(mirror + url, {
        headers: { 'user-agent': USER_AGENT },
        redirect: 'follow',
        signal,
      });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const total = Number(response.headers.get('content-length')) || 0;
      let received = 0;
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        received += buffer.length;
        if (!stream.write(buffer)) {
          await new Promise((resolve) => stream.once('drain', resolve));
        }
        if (total) onProgress?.({ received, total });
      }
      await new Promise((resolve, reject) => stream.end((error) => (error ? reject(error) : resolve())));
      if (received <= 0) throw new Error('下载内容为空');
      return received;
    } catch (error) {
      lastError = error;
      stream.destroy();
      await fsp.rm(target, { force: true }).catch(() => {});
      if (signal?.aborted) break;
      // 换下一个镜像接着试
    }
  }
  throw lastError || new Error('下载失败');
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Windows 自带 Expand-Archive，不引第三方解压依赖。 */
function unzipArchive(zipPath, destDir) {
  const script = `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destDir)} -Force`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 120000 },
      (error, _stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message).trim() || '解压失败'));
        else resolve();
      }
    );
  });
}

/**
 * 下载并解压工具。返回 { version, dir, zip, size }。
 * onProgress 依次收到 { phase:'meta', version, size } / { phase:'download', received, total } / { phase:'unzip' }。
 */
async function run({ downloadsDir, onProgress, signal } = {}) {
  if (!downloadsDir) throw new Error('找不到下载目录');
  const asset = await resolveAsset(signal);
  onProgress?.({ phase: 'meta', version: asset.version, size: asset.size });

  const target = path.join(downloadsDir, asset.name);
  const dir = path.join(downloadsDir, asset.name.replace(/\.zip$/i, ''));
  const size = await downloadTo(asset.url, target, (part) => onProgress?.({ phase: 'download', ...part }), signal);

  onProgress?.({ phase: 'unzip' });
  await fsp.mkdir(dir, { recursive: true });
  await unzipArchive(target, dir);
  return { version: asset.version, dir, zip: target, size };
}

module.exports = { run };
