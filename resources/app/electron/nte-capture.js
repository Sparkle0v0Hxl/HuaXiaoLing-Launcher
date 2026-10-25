'use strict';

// 异环抽卡自动抓取：调用 Anong0u0/NTE_Gacha_Exporter 的 CLI 组件
// （pktmon 抓包，需要管理员权限），把结果 JSON 写进启动器的自动导入目录。
//
// 参考实现：leck995/NTE-Maid（同为调用该 CLI）。
// CLI 用法：nte-gacha-exporter-cli.exe capture --output-raw --json <out.json> --csv <out.csv> [--auto-page]

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const zlib = require('node:zlib');
const { execFile } = require('node:child_process');

const REQUIRED_VERSION = '1.2.8';
const CAPTURE_TIMEOUT_MS = 30 * 60 * 1000;

let session = null;

function releaseUrl(version) {
  return `https://github.com/Anong0u0/NTE_Gacha_Exporter/releases/download/v${version}/nte-gacha-exporter-${version}.zip`;
}

function exporterDir(userData) {
  return path.join(userData, 'gacha');
}

function exporterPath(userData) {
  return path.join(exporterDir(userData), 'nte-gacha-exporter-cli.exe');
}

function parseVersion(text) {
  const cleaned = String(text || '').trim().split(/[-+\s]/)[0];
  if (!/^\d+(\.\d+)*$/.test(cleaned)) return null;
  return cleaned.split('.').map((part) => Number(part));
}

function isBelow(current, required) {
  const a = parseVersion(current);
  const b = parseVersion(required);
  if (!a) return true;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

function runFile(file, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function runPowerShell(script, timeout = 120000) {
  return runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], timeout);
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function readVersion(userData) {
  const exe = exporterPath(userData);
  if (!fs.existsSync(exe)) return null;
  try {
    const { stdout } = await runFile(exe, ['--version'], 10000);
    const version = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
    if (version) return version;
  } catch {
    /* 读不到就退回本地记录的版本号 */
  }
  try {
    const cached = (await fsp.readFile(path.join(exporterDir(userData), 'version.txt'), 'utf8')).trim();
    return cached || null;
  } catch {
    return null;
  }
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`下载抓取组件失败（HTTP ${response.status}）`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1024 * 1024) throw new Error('下载内容异常（文件过小）');
  return buffer;
}

// 纯 JS 解 ZIP：只取需要的那个文件，避免依赖 PowerShell / 外部解压工具。
function extractZipEntry(buffer, matcher) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66000); i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('下载的压缩包无法解析');
  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let index = 0; index < total; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (matcher.test(name)) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const raw = buffer.subarray(start, start + compressedSize);
      if (method === 0) return { name, data: raw };
      if (method === 8) return { name, data: zlib.inflateRawSync(raw) };
      throw new Error(`压缩包使用了不支持的压缩方式（${method}）`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

async function ensureExporter(userData, onProgress) {
  const exe = exporterPath(userData);
  const current = await readVersion(userData);
  if (current && !isBelow(current, REQUIRED_VERSION)) {
    return { ready: true, version: current, path: exe };
  }
  const reason = current ? `组件版本 ${current} 低于 ${REQUIRED_VERSION}` : '本地没有抓取组件';
  if (onProgress) onProgress(`${reason}，正在下载…`);
  const zip = await download(releaseUrl(REQUIRED_VERSION));
  const entry = extractZipEntry(zip, /(^|[\\/])nte-gacha-exporter-cli\.exe$/i);
  if (!entry) throw new Error('压缩包里没有找到 nte-gacha-exporter-cli.exe');
  if (entry.data.length < 1024 * 1024) throw new Error('解压出来的组件体积异常');
  await fsp.mkdir(path.dirname(exe), { recursive: true });
  const tmp = `${exe}.tmp`;
  await fsp.writeFile(tmp, entry.data);
  await fsp.rename(tmp, exe).catch(async () => {
    await fsp.rm(exe, { force: true });
    await fsp.rename(tmp, exe);
  });
  const version = await readVersion(userData);
  await fsp.writeFile(path.join(exporterDir(userData), 'version.txt'), version || REQUIRED_VERSION, 'utf8').catch(() => {});
  return { ready: true, version: version || REQUIRED_VERSION, path: exe };
}

function stamp() {
  const now = new Date();
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function start({ userData, jsonDir, autoPage, onProgress, onDone, onError }) {
  if (session) {
    const error = new Error('正在抓取中，请先结束当前抓取');
    error.code = 'CAPTURE_RUNNING';
    throw error;
  }
  const exporter = await ensureExporter(userData, onProgress);
  await fsp.mkdir(jsonDir, { recursive: true });
  const base = path.join(jsonDir, `capture-${stamp()}`);
  const jsonPath = `${base}.json`;
  const csvPath = `${base}.csv`;

  const args = ['capture', '--output-raw', '--json', jsonPath, '--csv', csvPath];
  if (autoPage) args.push('--auto-page');

  const argList = args.map(psQuote).join(',');
  const script = [
    `$exe = ${psQuote(exporter.path)}`,
    `$arguments = @(${argList})`,
    'try {',
    '  $p = Start-Process -FilePath $exe -ArgumentList $arguments -Verb RunAs -PassThru',
    '  $p.Id',
    '} catch {',
    '  Write-Error $_.Exception.Message',
    '  exit 1',
    '}',
  ].join('\n');

  let pid = 0;
  try {
    const { stdout } = await runPowerShell(script, 60000);
    pid = Number(String(stdout || '').trim().split(/\r?\n/).pop()) || 0;
  } catch (error) {
    const detail = String(error.stderr || error.message || '');
    if (/拒绝|denied|cancel/i.test(detail)) {
      throw new Error('抓取需要管理员权限，请在系统弹窗里点「是」后重试');
    }
    throw new Error(`无法启动抓取组件：${detail.trim() || '未知错误'}`);
  }

  const state = {
    pid,
    jsonPath,
    csvPath,
    autoPage: !!autoPage,
    startedAt: Date.now(),
    timer: null,
    settled: false,
  };
  session = state;

  const finish = (error, payload) => {
    if (state.settled) return;
    state.settled = true;
    if (state.timer) clearInterval(state.timer);
    session = null;
    if (error) {
      if (onError) onError(error);
    } else if (onDone) {
      onDone(payload);
    }
  };

  state.timer = setInterval(async () => {
    if (Date.now() - state.startedAt > CAPTURE_TIMEOUT_MS) {
      finish(new Error('抓取超时（30 分钟），请重新开始'));
      return;
    }
    let raw = '';
    try {
      raw = await fsp.readFile(jsonPath, 'utf8');
    } catch {
      return;
    }
    if (!raw.trim()) return;
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // 还在写
    }
    const list = parsed && parsed.nte && Array.isArray(parsed.nte.list) ? parsed.nte.list : [];
    if (!list.length) return;
    finish(null, { jsonPath, csvPath, count: list.length });
  }, 2000);

  return { pid, jsonPath, csvPath };
}

async function stop() {
  if (!session) return { stopped: false };
  const pid = session.pid;
  if (session.timer) clearInterval(session.timer);
  session.settled = true;
  session = null;
  if (!pid) return { stopped: false };
  try {
    await runFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], 15000);
    return { stopped: true };
  } catch (error) {
    const detail = String(error.stderr || error.message || '');
    return { stopped: false, message: detail.trim() || '结束失败，请在抓取窗口里按 Esc 或直接关闭窗口' };
  }
}

function info(userData) {
  const exe = exporterPath(userData);
  return {
    required: REQUIRED_VERSION,
    installed: fs.existsSync(exe),
    path: exe,
    running: !!session,
    autoPage: session ? session.autoPage : false,
  };
}

module.exports = {
  REQUIRED_VERSION,
  exporterPath,
  ensureExporter,
  readVersion,
  start,
  stop,
  info,
};
