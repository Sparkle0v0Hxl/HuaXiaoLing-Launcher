# 把工作区副本的源码+资源复制到 H:\花筱灵启动器（排除缓存）
$ErrorActionPreference = 'Stop'
$source = 'H:\花筱灵启动器-源码'
$target = 'H:\花筱灵启动器'

# 只复制这些顶层项（源码 + 资源 + 文档 + 构建配置），其余缓存/测试残留全部跳过
$items = @(
  'electron',
  'src',
  'scripts',
  'resources',
  'build',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'README.md',
  'HANDOVER.md',
  '交接文档.md',
  '更新说明.md',
  '启动-安全模式.bat',
  'LICENSE',
  '.gitignore'
)

if (-not (Test-Path $target)) { New-Item -ItemType Directory -Path $target -Force | Out-Null }

$copied = 0
$bytes = 0
foreach ($item in $items) {
  $src = Join-Path $source $item
  if (-not (Test-Path $src)) { Write-Host "skip (missing): $item"; continue }
  $dst = Join-Path $target $item
  if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
  Copy-Item $src $dst -Recurse -Force
  $stat = Get-Item $dst
  if ($stat.PSIsContainer) {
    $sum = (Get-ChildItem $dst -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum)
    $bytes += [int64]$sum.Sum
    $copied += [int]$sum.Count
  } else {
    $bytes += [int64]$stat.Length
    $copied += 1
  }
  Write-Host "copied: $item"
}

# 目标目录里不应存在的东西（万一被带上）
foreach ($junk in @('node_modules','dist','.tmp','.cache','.build-tools','shots')) {
  $p = Join-Path $target $junk
  if (Test-Path $p) { Remove-Item $p -Recurse -Force; Write-Host "removed junk: $junk" }
}

Write-Host ""
Write-Host "DONE files=$copied sizeMB=$([math]::Round($bytes/1MB,1))"
Write-Host "TARGET=$target"
