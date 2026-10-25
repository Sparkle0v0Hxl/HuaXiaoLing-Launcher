<#
.SYNOPSIS
    花筱灵启动器覆盖脚本 / 自检脚本。

.DESCRIPTION
    由 electron/updater.js 在「已经下载、校验、解压完成」之后拉起，脱离主进程运行。
    两种用法共用一个脚本，靠 meta.json 里的 action 区分：

      update   等旧进程退出 → 逐项备份 → 逐项覆盖 → 写升级标记 → 重新拉起
      rollback 等旧进程退出 → 把备份还原回去 → 恢复旧版自检脚本 → 重新拉起

    覆盖粒度是「文件」，不是「目录镜像」。原因：
      · robocopy /MIR 会删掉目标里源没有的文件，data、下载缓存、渠道包全在里面；
      · 旧版本残留的 .bak / .tmp 也不该被当成「多余文件」删掉；
      · 万一中途失败，已经备份的文件可以逐个还原，不会留下半新半旧的程序目录。

.NOTES
    这个脚本在 <程序目录>\resources\updater\ 下，是包的一部分。
    另一个 self-heal.ps1 是它的「监护人」：升级完成后 45 秒内启动器如果连续起不来，
    就把整个覆盖动作反向执行一遍。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$MetaPath,

    # 每个文件最多等多久（秒）拿到「别人没在占用」的写锁
    [int]$LockTimeoutSec = 60,

    # 覆盖完成后等启动器多久才算「起来了」
    [int]$SettleSeconds = 45
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Step([string]$Message) {
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$stamp] $Message"
}

function Write-Safe([string]$Path, [string]$Content) {
    try {
        $parent = Split-Path -Parent $Path
        if ($parent -and -not (Test-Path -LiteralPath $parent)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
        [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
    } catch {
        Write-Host "[warn] 写文件失败 $Path : $($_.Exception.Message)"
    }
}

# 目标文件是否被别的进程占用（游戏正在跑主程序 exe 时就是这种情况）
function Test-FileLocked([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    try {
        $stream = [System.IO.File]::Open($Path, 'Open', 'ReadWrite', 'None')
        $stream.Close()
        $stream.Dispose()
        return $false
    } catch {
        return $true
    }
}

# 等到某个文件的写锁可用为止；等不到就不动它，等下次启动再补
function Wait-FileWritable([string]$Path, [int]$TimeoutSec) {
    if (-not (Test-Path -LiteralPath $Path)) { return $true }
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-FileLocked $Path)) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return -not (Test-FileLocked $Path)
}

function Copy-FileReplacing([string]$Source, [string]$Destination) {
    $parent = Split-Path -Parent $Destination
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    if (Test-Path -LiteralPath $Destination) {
        # 去掉只读属性，否则 Copy-Item -Force 也会失败
        try { (Get-Item -LiteralPath $Destination).Attributes = 'Normal' } catch { }
    }
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Resolve-Joined([string]$Root, [string]$Relative) {
    return Join-Path $Root ($Relative -replace '/', '\')
}

# 主程序被占用时，等一段时间；还占用就放弃这次更新，避免把半截文件写进去
function Wait-ForMainProcess([string]$Target) {
    $names = @('花筱灵启动器', 'HuaXiaoLing', 'Electron')
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        $alive = Get-Process -ErrorAction SilentlyContinue | Where-Object {
            $names -contains $_.ProcessName -and $_.Path -and
            ($_.Path.StartsWith($Target, [System.StringComparison]::OrdinalIgnoreCase))
        }
        if (-not $alive) { return $true }
        Write-Step "等待进程退出：$($alive[0].ProcessName)($($alive[0].Id))"
        Start-Sleep -Seconds 1
    }
    return $false
}

function Format-VersionFromMeta($Meta) {
    if ($Meta.targetVersion) { return [string]$Meta.targetVersion }
    return 'unknown'
}

function Get-BackupDirName($Meta, [string]$Kind) {
    $from = if ($Meta.fromVersion) { [string]$Meta.fromVersion } else { 'unknown' }
    $to = [string]$Meta.targetVersion
    if ($Kind -eq 'rollback') { return "backup-rollback-$to" }
    return "backup-$from"
}

function Write-BackupMeta([string]$BackupRoot, $Meta) {
    $payload = [ordered]@{
        backupRoot    = $BackupRoot
        createdAt     = (Get-Date).ToString('o')
        fromVersion   = [string]$Meta.fromVersion
        targetVersion = [string]$Meta.targetVersion
        files         = @($Meta.files)
        protectedFiles = @($Meta.protectedExisting)
    }
    Write-Safe (Join-Path $BackupRoot 'meta.json') ($payload | ConvertTo-Json -Depth 5)
}

function Invoke-Update([string]$Target, $Meta) {
    $source = [string]$Meta.source
    $version = Format-VersionFromMeta $Meta
    $statusDir = [string]$Meta.statusDir
    $files = @($Meta.files)

    if (-not (Test-Path -LiteralPath $source)) { throw "更新包解压目录不见了：$source" }
    if (-not $files -or $files.Count -eq 0) { throw "meta.json 里没有要覆盖的文件清单" }

    if (-not (Wait-ForMainProcess $Target)) {
        throw "启动器还在运行，没能退出，本次更新已放弃（可以重试）"
    }

    # ---- 1. 备份 ----
    $backupRoot = Join-Path $statusDir (Get-BackupDirName $Meta 'update')
    if (Test-Path -LiteralPath $backupRoot) {
        Remove-Item -LiteralPath $backupRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    Write-Step "备份到 $backupRoot"

    $index = 0
    foreach ($relative in $files) {
        $index += 1
        if ($index % 50 -eq 0 -or $index -eq $files.Count) {
            Write-Step "备份中 $index/$($files.Count)"
        }
        $destination = Resolve-Joined $Target $relative
        if (-not (Test-Path -LiteralPath $destination)) { continue }
        if (-not (Wait-FileWritable $destination 5)) {
            Write-Step "[skip] 文件被占用，跳过备份：$relative"
            continue
        }
        $backupTarget = Resolve-Joined $backupRoot $relative
        $parent = Split-Path -Parent $backupTarget
        if (-not (Test-Path -LiteralPath $parent)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
        Copy-Item -LiteralPath $destination -Destination $backupTarget -Force
    }
    Write-BackupMeta $backupRoot $Meta

    # ---- 2. 覆盖 ----
    $skipped = New-Object System.Collections.Generic.List[string]
    $written = 0
    $index = 0
    foreach ($relative in $files) {
        $index += 1
        if ($index % 50 -eq 0 -or $index -eq $files.Count) {
            Write-Step "覆盖中 $index/$($files.Count)"
        }
        $sourceFile = Resolve-Joined $source $relative
        if (-not (Test-Path -LiteralPath $sourceFile)) { continue }
        $destination = Resolve-Joined $Target $relative

        $timeout = 3
        if (-not $relative.Contains('/')) { $timeout = $LockTimeoutSec }
        if (-not (Wait-FileWritable $destination $timeout)) {
            Write-Step "[skip] 文件被占用，暂不覆盖：$relative"
            $skipped.Add($relative)
            continue
        }
        try {
            Copy-FileReplacing $sourceFile $destination
            $written += 1
        } catch {
            Write-Step "[skip] 覆盖失败 $relative : $($_.Exception.Message)"
            $skipped.Add($relative)
        }
    }
    Write-Step "覆盖完成：$written 个文件，跳过 $(@($skipped).Count) 个"

    # ---- 3. 标记 ----
    $markerPath = Join-Path $statusDir 'last-update.json'
    $marker = [ordered]@{
        action        = 'update'
        fromVersion   = [string]$Meta.fromVersion
        targetVersion = $version
        appliedAt     = (Get-Date).ToString('o')
        filesWritten  = $written
        skippedFiles  = @($skipped)
        backupRoot    = $backupRoot
    }
    Write-Safe $markerPath ($marker | ConvertTo-Json -Depth 5)

    # ---- 4. 拉起 ----
    Write-Step "重新启动启动器：$([string]$Meta.relaunch)"
    if ($Meta.relaunch -and (Test-Path -LiteralPath ([string]$Meta.relaunch))) {
        Start-Process -FilePath ([string]$Meta.relaunch) -WorkingDirectory $Target | Out-Null
    }
}

function Invoke-Rollback([string]$Target, $Meta) {
    $source = [string]$Meta.source
    $files = @($Meta.files)
    $statusDir = [string]$Meta.statusDir
    if (-not (Test-Path -LiteralPath $source)) { throw "备份目录不存在：$source" }

    if (-not (Wait-ForMainProcess $Target)) {
        throw "启动器还在运行，没能退出，回滚已放弃"
    }

    Write-Step "开始回滚，共 $(@($files).Count) 个文件"
    $index = 0
    foreach ($relative in $files) {
        $index += 1
        if ($index % 50 -eq 0 -or $index -eq $files.Count) {
            Write-Step "回滚中 $index/$(@($files).Count)"
        }
        $backupFile = Resolve-Joined $source $relative
        if (-not (Test-Path -LiteralPath $backupFile)) { continue }
        $destination = Resolve-Joined $Target $relative
        $timeout = 3
        if (-not $relative.Contains('/')) { $timeout = $LockTimeoutSec }
        if (-not (Wait-FileWritable $destination $timeout)) {
            Write-Step "[skip] 被占用，暂不还原：$relative"
            continue
        }
        try {
            Copy-FileReplacing $backupFile $destination
        } catch {
            Write-Step "[skip] 还原失败 $relative : $($_.Exception.Message)"
        }
    }

    # 自检脚本本身也被覆盖过，一起还原，否则旧版启动器会带着新版自检脚本
    $restoredUpdater = Join-Path $source 'resources\updater'
    if (Test-Path -LiteralPath $restoredUpdater) {
        $destUpdater = Join-Path $Target 'resources\updater'
        if (-not (Test-Path -LiteralPath $destUpdater)) {
            New-Item -ItemType Directory -Path $destUpdater -Force | Out-Null
        }
        foreach ($file in @(Get-ChildItem -LiteralPath $restoredUpdater -File -ErrorAction SilentlyContinue)) {
            try { Copy-FileReplacing $file.FullName (Join-Path $destUpdater $file.Name) } catch { }
        }
    }

    $markerPath = Join-Path $statusDir 'last-update.json'
    $marker = [ordered]@{
        action        = 'rollback'
        returnedTo    = [string]$Meta.targetVersion
        revertedFrom  = [string]$Meta.fromVersion
        appliedAt     = (Get-Date).ToString('o')
        backupRoot    = $source
    }
    Write-Safe $markerPath ($marker | ConvertTo-Json -Depth 5)

    Write-Step "回滚完成，重新启动：$([string]$Meta.relaunch)"
    if ($Meta.relaunch -and (Test-Path -LiteralPath ([string]$Meta.relaunch))) {
        Start-Process -FilePath ([string]$Meta.relaunch) -WorkingDirectory $Target | Out-Null
    }
}

$meta = $null
try {
    if (-not (Test-Path -LiteralPath $MetaPath)) { throw "找不到 $MetaPath" }
    $meta = Get-Content -LiteralPath $MetaPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    Write-Host "[error] 读取 meta.json 失败：$($_.Exception.Message)"
    exit 1
}

$target = [string]$meta.target
if (-not $target -or -not (Test-Path -LiteralPath $target)) {
    Write-Host "[error] 程序目录不存在：$target"
    exit 1
}

try {
    if ([string]$meta.action -eq 'rollback') {
        Invoke-Rollback $target $meta
    } else {
        Invoke-Update $target $meta
    }
    exit 0
} catch {
    Write-Host "[error] $($_.Exception.Message)"
    # 失败也要把窗口留一会儿，用户能看到原因（detached 启动看不到输出，所以落一份日志）
    exit 1
}
