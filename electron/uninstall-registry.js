'use strict';

/**
 * 卸载入口（注册表）的写入与自愈。
 *
 * ── 为什么需要这个模块 ──────────────────────────────────────────────
 *
 * 老用户不是重新装一次升级过来的，而是走增量更新。增量更新只换 asar 里的
 * 程序文件，**不会重跑安装器**，所以「设置 → 应用 → 卸载」里那条记录还是
 * 上一版安装器写进去的：
 *
 *   UninstallString = "<安装目录>\Uninstall 花筱灵启动器.exe" /currentuser
 *
 * 那是 NSIS（或更早的自绘安装器）生成的独立卸载器。Electron 只认「执行文件
 * 同目录下的 resources\app.asar」，而那个 Uninstall.exe 旁边放的是启动器本体，
 * 双击它跑起来的是启动器主界面 —— 卸载流程根本进不去。所以老用户点「卸载」
 * 看到的一直是旧界面，或者干脆没反应（早期那条 2.8.0 记录甚至指向已经不存在
 * 的目录）。
 *
 * 修法只能是启动器自己认领这件事：升级后跑一次迁移，把注册表里那条记录改成
 * 指向「花筱灵启动器.exe --uninstall」，并把残留的僵尸项清掉。
 *
 * ── 为什么用 PowerShell 而不是 reg.exe ──────────────────────────────
 *
 * ① 中文。DisplayName 是「花筱灵启动器」，reg.exe 的参数走控制台 ANSI 编码，
 *    传中文看运气；PowerShell 内部是 UTF-16，Set-ItemProperty 直接接字符串。
 * ② 次数。扫一遍 + 删几条 + 写一条，用 reg 要好几次 spawn；PowerShell 一次
 *    脚本做完，还顺手把结果算成 JSON 回来。
 * ③ 判定。要读 UninstallString、判断指向的文件还在不在、再决定删还是留，
 *    用脚本写比在 Node 里解析 reg query 的文本输出干净得多。
 *
 * 所以这里全部操作收在**一个** PowerShell 脚本里，Node 只负责传参和读结果。
 * 参数走环境变量（不拼进脚本文本），彻底避开引号转义。
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { powershellExe } = require('./ps-path');

const APP_NAME = '花筱灵启动器';
const APP_ID = 'huaxiaoling-launcher';
const APP_EXE = '花筱灵启动器.exe';
const PUBLISHER = 'HuaXiaoLing Studio';
const COMMENT = '花筱灵启动器 - 一个原创的桌面游戏启动器';
const UNINSTALL_KEY = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_ID}`;

/**
 * 一段 PowerShell：扫 HKCU 下所有「名字像我们」的卸载项，
 * 把非目标键的全部清掉，然后写一条指向主程序 --uninstall 的标准记录。
 *
 * 输出一行 JSON（UTF-8），形如：
 *   { removed: ["e5868757-..."], removedNames: ["花筱灵启动器 2.8.0"], wroteKey: true, dryRun: false }
 */
const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root      = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
$installDir = $env:HXL_UNINSTALL_DIR
$version    = $env:HXL_UNINSTALL_VERSION
$dryRun     = ($env:HXL_UNINSTALL_DRY -eq '1')
$wantedKey  = '${APP_ID}'
$appExe     = Join-Path $installDir '${APP_EXE}'

$removed      = @()
$removedNames = @()

# ── 1. 清掉所有非目标键、但名字像我们的记录 ──
#    可能是僵尸（指向已删除目录）、旧 NSIS 入口、或更早自绘安装器留下的。
#    它们的共同点是「点了也进不到我们的卸载窗口」，留着只会误导用户。
Get-ChildItem -LiteralPath $root | ForEach-Object {
  $childKey = $_.PSChildName
  if ($childKey -eq $wantedKey) { return }
  $props = Get-ItemProperty -LiteralPath $_.PSPath
  $name = [string]$props.DisplayName
  if ($name -notlike '*花筱灵*') { return }

  $removed      += $childKey
  $removedNames += $name
  if (-not $dryRun) {
    Remove-Item -LiteralPath $_.PSPath -Force
  }
}

# ── 2. 写目标键 ──
$keyPath = Join-Path $root $wantedKey
if (-not $dryRun) {
  New-Item -Path $keyPath -Force | Out-Null
  Set-ItemProperty -LiteralPath $keyPath -Name DisplayName          -Value '${APP_NAME}'          -Type String
  Set-ItemProperty -LiteralPath $keyPath -Name DisplayVersion       -Value $version              -Type String
  Set-ItemProperty -LiteralPath $keyPath -Name Publisher            -Value '${PUBLISHER}'        -Type String
  Set-ItemProperty -LiteralPath $keyPath -Name Comments             -Value '${COMMENT}'          -Type String
  Set-ItemProperty -LiteralPath $keyPath -Name DisplayIcon          -Value ($appExe + ',0')      -Type String
  Set-ItemProperty -LiteralPath $keyPath -Name InstallLocation      -Value $installDir           -Type String
  Set-ItemProperty -LiteralPath $keyPath -Name UninstallString      -Value ('"' + $appExe + '" --uninstall')         -Type String
  Set-ItemProperty -LiteralPath $keyPath -Name QuietUninstallString -Value ('"' + $appExe + '" --uninstall --silent') -Type String
  Set-ItemProperty -LiteralPath $keyPath -Name NoModify             -Value 1                     -Type DWord
  Set-ItemProperty -LiteralPath $keyPath -Name NoRepair             -Value 1                     -Type DWord
}

[pscustomobject]@{
  removed      = @($removed)
  removedNames = @($removedNames)
  wroteKey     = (-not $dryRun)
  dryRun       = $dryRun
} | ConvertTo-Json -Compress -Depth 4
`;

/** 把脚本编码成 -EncodedCommand 需要的 base64(UTF-16LE)。 */
function encodeCommand(script) {
  const utf16 = Buffer.from(script, 'utf16le');
  const b64 = utf16.toString('base64');
  // Windows 的 -EncodedCommand 要求 base64 里不能有换行
  return b64.replace(/\r?\n/g, '');
}

/**
 * 修一遍注册表：清掉旧的/僵尸的卸载项，写一条指向主程序的新记录。
 *
 * @param {object} options
 * @param {string} options.installDir  安装目录（主程序 exe 所在目录）
 * @param {string} [options.version]   版本号（写进 DisplayVersion）
 * @param {boolean} [options.dryRun]   只看不改
 * @returns {{ok: boolean, removed: string[], removedNames: string[], wroteKey: boolean, error?: string}}
 */
function repairUninstallRegistry(options = {}) {
  const installDir = options.installDir;
  const version = options.version || '';
  const dryRun = options.dryRun === true;

  const result = { ok: false, removed: [], removedNames: [], wroteKey: false };
  if (!installDir) {
    result.error = '缺少安装目录';
    return result;
  }

  try {
    const stdout = execFileSync(
      powershellExe(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(SCRIPT)],
      {
        encoding: 'utf8',
        timeout: 20000,
        windowsHide: true,
        // 丢掉 stderr：PowerShell 首次运行会往那边写 CLIXML 进度噪音
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
          ...process.env,
          HXL_UNINSTALL_DIR: installDir,
          HXL_UNINSTALL_VERSION: version,
          HXL_UNINSTALL_DRY: dryRun ? '1' : '0',
        },
      }
    );

    const text = String(stdout || '').trim();
    // 脚本可能被别的启动器/杀软塞入杂音，取最后一个 { 开始的对象
    const brace = text.lastIndexOf('{');
    if (brace < 0) {
      result.error = '注册表脚本没有返回结果';
      return result;
    }
    const parsed = JSON.parse(text.slice(brace));
    result.removed = Array.isArray(parsed.removed) ? parsed.removed : [];
    result.removedNames = Array.isArray(parsed.removedNames) ? parsed.removedNames : [];
    result.wroteKey = Boolean(parsed.wroteKey);
    result.ok = true;
    return result;
  } catch (error) {
    result.error = (error && error.message) || String(error);
    return result;
  }
}

/**
 * 只写不清理：安装器装完时用（此时注册表里干干净净，不用扫）。
 *
 * @param {string} installDir
 * @param {string} version
 */
function writeUninstallRegistry(installDir, version) {
  return repairUninstallRegistry({ installDir, version });
}

/**
 * 删掉我们的卸载项（卸载流程最后一步用）。
 * reg.exe 一行就够，这里保留给卸载逻辑复用，避免两处各写一份键名。
 *
 * @returns {{ok: boolean, error?: string}}
 */
function removeUninstallRegistry() {
  try {
    execFileSync('reg', ['delete', `HKCU\\${UNINSTALL_KEY}`, '/f'], {
      stdio: 'ignore',
      timeout: 5000,
      windowsHide: true,
    });
    return { ok: true };
  } catch (error) {
    /*
     * 键本来就不存在时 reg 返回非 0，这算成功（没什么可删的）。
     * 真正失败的场景（权限）也会落到这里，但卸载流程不因为它中断。
     */
    const message = (error && error.message) || String(error);
    if (/unable to find|cannot find|找不到/i.test(message)) return { ok: true };
    return { ok: false, error: message };
  }
}

module.exports = {
  APP_NAME,
  APP_ID,
  APP_EXE,
  UNINSTALL_KEY,
  repairUninstallRegistry,
  writeUninstallRegistry,
  removeUninstallRegistry,
};
