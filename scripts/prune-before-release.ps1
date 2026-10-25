#Requires -Version 5.1
<#
.SYNOPSIS
    发布前瘦身：清掉启动器目录里不该留的东西。

.DESCRIPTION
    发版前跑一遍，把旧包、探针目录、备份、日志清掉，避免 build 越滚越大。
    publish-portable.ps1 打包前会自动调用本脚本（可用 -SkipPrune 跳过）。

    会删：
      - build\archive\            旧包归档目录
      - build\probe\              调试探针目录
      - build(HuaXiaoLing-*.zip)  只保留当前版本 + 最近 KeepPrev 个历史版本
      - *.bak / *.bak-*           备份残留
      - build 下的旧 latest*.json 只保留当前版本清单
      - 根目录下的 *.log

    不会动：
      - data\          用户数据（账号 / 抽卡 / 歌单）
      - downloads\     下载缓存
      - resources\     程序本体
      - locales\       Electron 运行时
      - 当前版本的 zip 与 latest.json

.PARAMETER Root
    启动器根目录。默认取本脚本上一级。

.PARAMETER KeepPrev
    除当前版本外，额外保留几个历史 zip。默认 1。

.PARAMETER CurrentVersion
    当前要发布/保留的版本号，例如 2.0.3。

.PARAMETER DryRun
    只列出会删什么，不真删。

.EXAMPLE
    .\scripts\prune-before-release.ps1 -CurrentVersion 2.0.3

.EXAMPLE
    .\scripts\prune-before-release.ps1 -CurrentVersion 2.0.3 -DryRun
#>
[CmdletBinding()]
param(
    [string]$Root = '',
    [int]$KeepPrev = 1,
    [string]$CurrentVersion = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
if (-not (Test-Path -LiteralPath $Root)) { throw "找不到根目录 $Root" }
$Root = (Resolve-Path -LiteralPath $Root).Path

function Write-Step([string]$Message) { Write-Host "==> $Message" }

# 所有待处理路径都必须落在根目录内，防止误删
function Assert-InRoot([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝操作根目录之外的路径：$full"
    }
    if ($full -eq $Root) { throw "拒绝操作根目录本身" }
    return $full
}

$freed = 0
$removed = 0
$skipped = New-Object System.Collections.Generic.List[string]

function Remove-Target([string]$Path, [string]$Reason) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $full = Assert-InRoot $Path
    $item = Get-Item -LiteralPath $full -Force
    $size = if ($item.PSIsContainer) {
        (Get-ChildItem -LiteralPath $full -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    } else { $item.Length }
    if (-not $size) { $size = 0 }

    $rel = $full.Substring($Root.Length).TrimStart('\')
    if ($DryRun) {
        Write-Host ("    [dry] {0,-56} {1,9:N1} MB  {2}" -f $rel, ($size / 1MB), $Reason)
    } else {
        try {
            Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction Stop
            Write-Host ("    ✅ {0,-54} {1,9:N1} MB  {2}" -f $rel, ($size / 1MB), $Reason)
        } catch {
            $skipped.Add("$rel  ($($_.Exception.Message))")
            return
        }
    }
    $script:freed += $size
    $script:removed++
}

Write-Step "发布前瘦身（根目录 $Root）"
if ($DryRun) { Write-Host "    （演练模式，不会真删）" }

# 1. 探针与归档目录
Remove-Target (Join-Path $Root 'build\archive') '旧包归档目录'
Remove-Target (Join-Path $Root 'build\probe') '调试探针目录'

# 2. 版本 zip：保留当前版本 + 最近 KeepPrev 个
$zipDirs = @((Join-Path $Root 'build'), (Join-Path $Root 'build\release'))
$zips = @()
foreach ($dir in $zipDirs) {
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    $zips += Get-ChildItem -LiteralPath $dir -File -Filter 'HuaXiaoLing-*-Portable.zip' -ErrorAction SilentlyContinue
}
$zips = $zips | Where-Object { $_.FullName -match 'HuaXiaoLing-(\d+\.\d+\.\d+)-Portable\.zip$' } | ForEach-Object {
    $null = $_.FullName -match 'HuaXiaoLing-(\d+\.\d+\.\d+)-Portable\.zip$'
    [pscustomobject]@{ File = $_; Version = [version]$Matches[1] }
}

$keep = @()
if ($CurrentVersion) { $keep += $CurrentVersion }
$hist = $zips | Where-Object { -not $CurrentVersion -or $_.Version.ToString() -ne $CurrentVersion } |
    Sort-Object Version -Descending | Select-Object -First ([Math]::Max(0, $KeepPrev))
$keep += $hist | ForEach-Object { $_.Version.ToString() }

foreach ($z in $zips) {
    if ($keep -contains $z.Version.ToString()) {
        Write-Host ("    ·  保留 {0}  {1:N1} MB" -f $z.File.Name, ($z.File.Length / 1MB))
        continue
    }
    Remove-Target $z.File.FullName "旧版本包（保留 $($keep -join ', ')）"
}

# 3. 旧清单：只保留 build\latest.json（当前发布用）
foreach ($dir in $zipDirs) {
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    Get-ChildItem -LiteralPath $dir -File -Filter 'latest*.json' -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.FullName -ieq (Join-Path $Root 'build\latest.json')) { return }
        Remove-Target $_.FullName '旧更新清单'
    }
}

# 4. 备份残留
Get-ChildItem -LiteralPath $Root -Recurse -File -Force -Filter '*.bak*' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\node_modules\\' -and $_.FullName -notmatch '\\data\\' } |
    ForEach-Object { Remove-Target $_.FullName '备份残留' }

# 5. 根目录日志
Get-ChildItem -LiteralPath $Root -File -Force -Filter '*.log' -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Target $_.FullName '日志' }

# 汇总
if ($DryRun) {
    Write-Host ("`n[演练] 将释放 {0:N2} GB，涉及 {1} 项" -f ($freed / 1GB), $removed)
} else {
    Write-Host ("`n瘦身完成：释放 {0:N2} GB，删除 {1} 项" -f ($freed / 1GB), $removed)
}
if ($skipped.Count -gt 0) {
    Write-Host "以下文件被占用，已跳过（关掉占用程序后重跑即可）："
    $skipped | ForEach-Object { Write-Host "    ⚠️ $_" }
}
