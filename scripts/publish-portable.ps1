<#
.SYNOPSIS
    打一个「便携版」发布包，并顺手写好自更新用的 latest.json。

.DESCRIPTION
    花筱灵启动器是绿色便携版（没有安装程序），所以发布 = 打包 + 提供一个能对版本号的清单。
    这个脚本只做两件事：

      1. 把运行所需的文件打进 build\HuaXiaoLing-<版本>-Portable.zip：
         主程序、Chromium 资源、resources\app、resources\updater、内置服务、渠道包。
         明确排除 data（账号/抽卡/歌单）、downloads（下载缓存）和日志、备份文件。

      2. 在包根目录写一份「指针式」latest.json，跟着 ZIP 一起发出去：
           { "version": "...", "manifest": "<官方清单地址>" }
         装好就有更新源，不用用户自己填。指向的那份真正清单里有下载地址和 sha256。

      3. 算出 sha256，写 build\latest.json（真正的清单，用来上传/分发）：
           { "version": "...", "url": "...", "sha256": "...", "size": ..., "notes": "..." }

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

    [switch]$SkipZip,

    # 打包前自动瘦身（删旧包 / 探针 / 备份 / 日志）。用 -SkipPrune 跳过。
    [switch]$SkipPrune,

    # 瘦身时除当前版本外额外保留几个历史 zip
    [int]$KeepPrev = 1,

    # 包里那份指针清单指向哪里（正式清单的地址）。默认官方 Release。
    [string]$ManifestUrl = 'https://github.com/Sparkle0v0Hxl/HuaXiaoLing-Launcher/releases/latest/download/latest.json'
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

# 发布前瘦身：清掉旧包、探针目录、备份和日志，避免 build 越滚越大
$pruneScript = Join-Path $PSScriptRoot 'prune-before-release.ps1'
if ($SkipPrune) {
    Write-Step "跳过瘦身（-SkipPrune）"
} elseif (Test-Path -LiteralPath $pruneScript) {
    & $pruneScript -Root $repoRoot -CurrentVersion $Version -KeepPrev $KeepPrev
} else {
    Write-Warning "找不到 scripts\prune-before-release.ps1，跳过瘦身"
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
# 只排除「根目录」下的 data / downloads（用户数据与下载缓存）；
# 不能写成 (^|\\)(data|downloads)，那会把 resources\app\src\data\news.json 一起踢掉，
# 装出来的启动器动态页就是空的。
$excludePattern = '^(data|downloads)(\\|$)|\.log$|\.bak(-\S+)?$|^latest(-\d+\.\d+\.\d+)?\.json$|\\node_modules\\|\\\.git\\'

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
        # 顺手写一份「指针式」清单：装好就自带更新源，用户不用再填地址。
        # 只写版本号和指向，不写 url/sha256 —— 打包这一刻还算不出这个包自己的哈希。
        $pointer = [ordered]@{
            version  = $Version
            channel  = $Channel
            date     = (Get-Date).ToString('yyyy-MM-dd')
            title    = "花筱灵启动器 $Version"
            manifest = $ManifestUrl
            portable = $true
        }
        $pointerJson = $pointer | ConvertTo-Json -Depth 5
        [System.IO.File]::WriteAllText(
            (Join-Path $staging 'latest.json'),
            $pointerJson,
            (New-Object System.Text.UTF8Encoding($false))
        )
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
