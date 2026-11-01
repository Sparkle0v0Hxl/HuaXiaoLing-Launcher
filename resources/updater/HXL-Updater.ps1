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

# 日志落在 <程序目录>\data\tmp\update-log.txt。脚本是 detached 启动的，
# 控制台输出没人看得到，出问题时让用户把这个文件发回来就能定位。
$script:LogPath = ''
function Write-Step([string]$Message) {
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    $line = "[$stamp] $Message"
    Write-Host $line
    if ($script:LogPath) {
        try {
            Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
        } catch { }
    }
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

# 列出「属于这个程序目录」的启动器进程。
#
# 这里踩过一个坑：Get-Process 拿到提权进程时，读 $_.Path 会抛 Access is denied。
# 老写法把整条管道写在 Where-Object 里，$ErrorActionPreference='Stop' 会把它变成
# 终止性错误，整个脚本当场死掉 —— 用户看到的就是「下载到 100% 之后什么都没有」。
# 所以每个进程的 Path 都单独 try/catch。
function Get-LauncherProcess([string]$Target) {
    $found = New-Object System.Collections.Generic.List[object]
    foreach ($name in @('花筱灵启动器', 'HuaXiaoLing', 'Electron')) {
        $items = @()
        try { $items = @(Get-Process -Name $name -ErrorAction SilentlyContinue) } catch { $items = @() }
        foreach ($item in $items) {
            $processPath = ''
            try { $processPath = [string]$item.Path } catch { $processPath = '' }
            if ($processPath) {
                if (-not $processPath.StartsWith($Target, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
            } elseif ($name -ne '花筱灵启动器') {
                # 读不到路径、名字又不唯一：不敢认，跳过
                continue
            }
            $found.Add($item)
        }
    }
    return $found
}

# 主程序被占用时先好好等；等到超时就强制结束自己人，绝不半途而废。
# 返回 $false 才意味着「文件确实还被占着」，这时上层会放弃并回滚。
function Wait-ForMainProcess([string]$Target) {
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        $alive = @(Get-LauncherProcess $Target)
        if ($alive.Count -eq 0) { return $true }
        Write-Step "等待进程退出：$($alive[0].ProcessName)($($alive[0].Id))"
        Start-Sleep -Seconds 1
    }

    $left = @(Get-LauncherProcess $Target)
    if ($left.Count -eq 0) { return $true }
    Write-Step "30 秒仍未退出，强制结束 $($left.Count) 个进程"
    foreach ($item in $left) {
        try {
            Stop-Process -Id $item.Id -Force -ErrorAction Stop
        } catch {
            Write-Step "[warn] 结束进程失败 $($item.Id)：$($_.Exception.Message)"
        }
    }
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
        if (@(Get-LauncherProcess $Target).Count -eq 0) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return (@(Get-LauncherProcess $Target).Count -eq 0)
}

# 拉起启动器。失败只记日志，不抛异常 —— 这个函数经常在 catch 块里当兜底用。
function Start-Launcher([string]$Target, [string]$Relaunch) {
    $exe = if ($Relaunch) { $Relaunch } else { Join-Path $Target '花筱灵启动器.exe' }
    if (-not (Test-Path -LiteralPath $exe)) {
        Write-Step "[error] 找不到要拉起的程序：$exe"
        return $false
    }
    Write-Step "重新启动启动器：$exe"
    try {
        Start-Process -FilePath $exe -WorkingDirectory $Target | Out-Null
        return $true
    } catch {
        Write-Step "[error] 拉起失败：$($_.Exception.Message)"
        return $false
    }
}

# 升级完成后优先交给 self-heal.ps1 看护（它负责「起来就闪退」时自动回滚），
# 看护脚本本身起不来就退回直接拉起。
function Start-LauncherGuarded([string]$Target, $Meta) {
    $selfHeal = [string]$Meta.selfHeal
    if ($selfHeal -and (Test-Path -LiteralPath $selfHeal)) {
        $shell = Join-Path $PSHOME 'powershell.exe'
        if (-not (Test-Path -LiteralPath $shell)) { $shell = 'powershell.exe' }
        try {
            $arguments = @(
                '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                '-WindowStyle', 'Hidden',
                '-File', $selfHeal,
                '-Target', $Target
            )
            Start-Process -FilePath $shell -ArgumentList $arguments -WindowStyle Hidden | Out-Null
            Write-Step "已交给监护人脚本看护：$selfHeal"
            return $true
        } catch {
            Write-Step "[warn] 监护人脚本没起来，直接拉起启动器：$($_.Exception.Message)"
        }
    }
    return (Start-Launcher $Target ([string]$Meta.relaunch))
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

    # 主程序必须还在，否则拉起就是空欢喜
    $exePath = Join-Path $Target '花筱灵启动器.exe'
    if (-not (Test-Path -LiteralPath $exePath)) {
        throw "覆盖后找不到主程序：$exePath"
    }

    # ---- 2.5 结构切换 ----
    # 新包和旧安装可能是两套形态：asar 包（resources\app.asar）或展开目录（resources\app）。
    # 两套并存时 Electron 只认其中一套，用户看到的版本和磁盘上的文件对不上，
    # 所以覆盖成功后要把另一套旧结构清掉。放在覆盖之后做：万一失败，新结构已经落地，还能起来。
    $newAsar = @($files) -contains 'resources/app.asar'
    $newAppDir = @($files) -contains 'resources/app/package.json'
    $oldAppDir = Join-Path $Target 'resources/app'
    $oldAsar = Join-Path $Target 'resources/app.asar'
    if ($newAsar -and $newAppDir) { $newAppDir = $false }
    if ($newAsar -and (Test-Path -LiteralPath $oldAppDir)) {
        Write-Step "新包是 asar 结构，清理旧的 resources\app 目录"
        Remove-Item -LiteralPath $oldAppDir -Recurse -Force -ErrorAction SilentlyContinue
    } elseif ($newAppDir -and (Test-Path -LiteralPath $oldAsar)) {
        Write-Step "新包是展开目录结构，清理旧的 resources\app.asar"
        Remove-Item -LiteralPath $oldAsar -Force -ErrorAction SilentlyContinue
    }

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
    Start-LauncherGuarded $Target $Meta | Out-Null
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

    Write-Step "回滚完成，重新启动"
    Start-Launcher $Target ([string]$Meta.relaunch) | Out-Null
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

$statusDir = [string]$meta.statusDir
if (-not $statusDir) { $statusDir = Join-Path $target 'data\tmp' }
try {
    if (-not (Test-Path -LiteralPath $statusDir)) {
        New-Item -ItemType Directory -Path $statusDir -Force | Out-Null
    }
    $script:LogPath = Join-Path $statusDir 'update-log.txt'
} catch {
    $script:LogPath = ''
}

$action = [string]$meta.action
if (-not $action) { $action = 'update' }
Write-Step "覆盖脚本启动：action=$action，$([string]$meta.fromVersion) -> $([string]$meta.targetVersion)"
Write-Step "程序目录：$target"

# 握手标记：主进程在退出前会等这个文件。
# 等不到就不退出 —— 否则脚本没起来、窗口却没了，用户只看到启动器消失。
try {
    $started = [ordered]@{
        action    = $action
        startedAt = (Get-Date).ToString('o')
        pid       = $PID
        logPath   = $script:LogPath
    }
    Write-Safe (Join-Path $statusDir 'apply-started.json') ($started | ConvertTo-Json -Depth 4)
} catch { }

try {
    if ($action -eq 'rollback') {
        Invoke-Rollback $target $meta
    } else {
        Invoke-Update $target $meta
    }
    exit 0
} catch {
    $message = $_.Exception.Message
    Write-Step "[error] $message"
    try {
        $payload = [ordered]@{
            action   = $action
            failedAt = (Get-Date).ToString('o')
            message  = $message
            target   = $target
            logPath  = $script:LogPath
        }
        Write-Safe (Join-Path $statusDir 'update-error.json') ($payload | ConvertTo-Json -Depth 4)
    } catch { }
    # 失败了也要把启动器拉回来，不能让用户对着空桌面发呆
    Start-Launcher $target ([string]$meta.relaunch) | Out-Null
    exit 1
}
