#!/usr/bin/env node
/**
 * 把 electron/VelaEndfield.cs 预编译成 electron/VelaEndfield.exe。
 *
 * 为什么不在运行时靠 PowerShell 的 Add-Type 编译、而要在打包前预编译？
 * 因为 PowerShell 是原生进程，读不了 Electron 打进 app.asar 的虚拟路径，
 * 下载安装包的新用户直接卡死。预编译后启动器直接调这个 exe，彻底不依赖 PowerShell。
 *
 * 编译用本机自带的 .NET Framework（与运行时 Add-Type 同一套编译器），通过 PowerShell
 * 的 Add-Type 触发，避免直接调用 csc.exe 被安全策略拦截。产物是 .NET Framework 控制台
 * 程序，每台 Win10/11 都自带运行环境，零额外依赖。
 *
 * 用法：node scripts/build-vela-endfield.js   （需无沙箱，会写 electron/VelaEndfield.exe）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'electron', 'VelaEndfield.cs');
const OUT = path.join(__dirname, '..', 'electron', 'VelaEndfield.exe');

function powershellExe() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const candidates = [
    path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.join(root, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'powershell.exe',
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return 'powershell.exe';
}

if (!fs.existsSync(SRC)) {
  console.error('[x] 找不到 VelaEndfield.cs：' + SRC);
  process.exit(1);
}

const ps = powershellExe();
// 用单引号包裹路径，避免路径里的空格/特殊字符把命令撕碎；.NET Framework 的 Add-Type 默认
// 就对着系统 framework，产物是控制台程序。
const cmd = `$ErrorActionPreference='Stop';` +
  `Add-Type -TypeDefinition ([System.IO.File]::ReadAllText('${SRC.replace(/'/g, "''")}')) ` +
  `-OutputAssembly '${OUT.replace(/'/g, "''")}' -OutputType ConsoleApplication;` +
  `if(-not (Test-Path '${OUT.replace(/'/g, "''")}')){exit 5}`;

console.log('==> 编译 VelaEndfield.exe（Add-Type / .NET Framework）');
const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', cmd], { stdio: 'inherit' });
if (r.status !== 0) {
  console.error(`[x] 编译失败，退出码 ${r.status}`);
  process.exit(1);
}
if (!fs.existsSync(OUT)) {
  console.error('[x] 编译后找不到产物：' + OUT);
  process.exit(1);
}
console.log('  ok ' + OUT + ' (' + fs.statSync(OUT).size + ' bytes)');
