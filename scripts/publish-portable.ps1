<#
.SYNOPSIS
    打一个「便携版」发布包，并顺手写好自更新用的 latest.json。

.DESCRIPTION
    花筱灵启动器是绿色便携版（没有安装程序），所以发布 = 打包 + 提供一个能对版本号的清单。
    这个脚本只做两件事：

      1. 把运行所需的文件打进 build\HuaXiaoLing-<版本>-Portable.zip：
         主程序、Chromium 资源、resources\app、resources\updater、内置服务、渠道包。
         明确排除 data（账号/抽卡/歌单）、downloads（下载缓存）和日志、备份文件。

      2. 算出 sha256，写 build\latest.json：
           { "version": "...", "url": "...", "sha256": "...", "size": ..., "notes": "..." }
         把 latest.json 和 ZIP 一起丢到任意静态位置（CDN、对象存储、局域网共享、
         D 盘目录都行），在启动器「设置 → 启动器更新 → 更新源」里填 latest.json
         的地址（或其所在目录）即可。

.PARAMETER Version
    版本号，必须和 resources\app\package.json 里的一致，否则启动器会认为更新无效。

.PARAMETER OutDir
    产物目录，默认 build。

.PARAMETER Notes
    更新说明（支持 \n 换行），会原样写进 latest.json，更新弹窗里显示。

.PARAMETER Force
    package.json 版本与 -Version 不一致时也继续（不推荐）。

.EXAMPLE
    .\scripts\publish-portable.ps1 -Version 2.0.1 -Notes "修复抽卡记录合并`n优化启动速度"

.EXAMPLE
    .\scripts\publish-portable.ps1 -Version 2.0.1 -OutDir D:\release
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+')]
    [string]$Version,

    [string]$OutDir = 'build',

    [string]$Notes = '',

    [string]$Channel = 'stable',

    [switch]$Force,

    [switch]$SkipZip
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $repoRoot 'resources\app'
$pkgPath = Join-Path $appDir 'package.json'
$updaterDir = Join-Path $repoRoot 'resources\updater'

function Write-Step([string]$Message) {
    Write-Host "==> $Message"
}

if (-not (Test-Path -LiteralPath $pkgPath)) {
    throw "找不到 $pkgPath，请在启动器仓库根目录下运行"
}

$pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($pkg.version -ne $Version) {
    $message = "package.json 里的版本是 $($pkg.version)，和 -Version $Version 对不上"
    if (-not $Force) { throw "$message。改 package.json 或者加 -Force" }
    Write-Warning $message
}

# 覆盖脚本必须存在，否则打出来的包装不上
foreach ($script in @('HXL-Updater.ps1', 'self-heal.ps1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $updaterDir $script))) {
        throw "缺少 resources\updater\$script，自更新会失败"
    }
}

if (-not (Test-Path -LiteralPath $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path
$zipName = "HuaXiaoLing-$Version-Portable.zip"
$zipPath = Join-Path $OutDir $zipName

# 打包内容：程序本体 + 运行时资源 + 内置服务 + 渠道包
$include = @()
$rootLevelPatterns = @('*.exe', '*.dll', '*.pak', '*.dat', '*.bin', '*.json', '*.html', '*.txt', '*.bat')
foreach ($pattern in $rootLevelPatterns) {
    $include += @(Get-ChildItem -LiteralPath $repoRoot -File -Filter $pattern -ErrorAction SilentlyContinue)
}
foreach ($name in @('resources\app', 'resources\updater', 'resources\netease-api', 'resources\endfield-packs')) {
    $dir = Join-Path $repoRoot $name
    if (Test-Path -LiteralPath $dir) { $include += Get-Item -LiteralPath $dir }
}

# 排除清单：用户数据、缓存、日志、备份、本地清单、node_modules
$excludePattern = '(^|\\)(data|downloads)(\\|$)|\.log$|\.bak(-\S+)?$|^latest(-\d+\.\d+\.\d+)?\.json$|\\node_modules\\|\\\.git\\'

$files = New-Object System.Collections.Generic.List[object]
foreach ($item in $include) {
    if ($item.PSIsContainer) {
        Get-ChildItem -LiteralPath $item.FullName -Recurse -File -Force | ForEach-Object { $files.Add($_) }
    } else {
        $files.Add($item)
    }
}

$relative = New-Object System.Collections.Generic.List[string]
foreach ($file in $files) {
    $rel = $file.FullName.Substring($repoRoot.Length).TrimStart('\')
    if ($rel -match $excludePattern) { continue }
    $relative.Add($rel)
}
$relative = $relative | Sort-Object -Unique

$totalBytes = 0
foreach ($rel in $relative) { $totalBytes += (Get-Item -LiteralPath (Join-Path $repoRoot $rel)).Length }
Write-Step ("待打包 {0} 个文件，原始大小 {1:N1} MB" -f $relative.Count, ($totalBytes / 1MB))

if (-not $SkipZip) {
    # 先拷到临时目录再压：Compress-Archive 只能整目录压，这样能精确控制进包的东西
    $staging = Join-Path ([System.IO.Path]::GetTempPath()) ("vela-release-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    try {
        foreach ($rel in $relative) {
            $dest = Join-Path $staging $rel
            $parent = Split-Path -Parent $dest
            if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
            Copy-Item -LiteralPath (Join-Path $repoRoot $rel) -Destination $dest -Force
        }
        # 包根目录放一个空标记文件，保证 zip 里是「文件夹内容」而不是「文件夹本身」——
        # 启动器解压后直接找 resources\app，多一层目录会找不到。
        if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
        Write-Step "压缩到 $zipPath"
        Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipPath -CompressionLevel Optimal -Force
    } finally {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if (-not (Test-Path -LiteralPath $zipPath)) {
    throw "没有可用的 ZIP：$zipPath"
}

$zipItem = Get-Item -LiteralPath $zipPath
Write-Step "计算 sha256"
$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()

$manifest = [ordered]@{
    version  = $Version
    channel  = $Channel
    date     = (Get-Date).ToString('yyyy-MM-dd')
    title    = "花筱灵启动器 $Version"
    notes    = if ($Notes) { $Notes -replace '\\n', "`n" } else { "" }
    url      = $zipName
    sha256   = $hash
    size     = $zipItem.Length
    portable = $true
}
$manifestPath = Join-Path $OutDir 'latest.json'
$json = $manifest | ConvertTo-Json -Depth 5
# utf8 无 BOM：Electron 的 JSON.parse 吃不下 BOM
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))

Write-Step "完成"
Write-Host ("  ZIP        : {0} ({1:N1} MB)" -f $zipPath, ($zipItem.Length / 1MB))
Write-Host ("  清单       : {0}" -f $manifestPath)
Write-Host ("  sha256     : {0}" -f $hash)
Write-Host ""
Write-Host "把这两个文件放到同一个目录（或直接用相对路径），在启动器的更新源里填 latest.json 的地址。"
