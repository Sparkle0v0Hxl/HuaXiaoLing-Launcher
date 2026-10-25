<#
.SYNOPSIS
    花筱灵启动器「监护人」脚本（self-heal）。

.DESCRIPTION
    HXL-Updater.ps1 覆盖完程序文件之后，会顺带把本脚本启动起来。它做的事很简单：

      1. 读 data\tmp\last-update.json，确认刚才确实是升级（不是回滚）；
      2. 拉起启动器，最多观察 45 秒；
      3. 如果进程还在、并且活着超过 8 秒 → 判定升级成功，记一条 ok，退出；
      4. 如果连续 3 次都是「刚起来就挂」→ 判定升级失败，
         调 HXL-Updater.ps1 以 rollback 模式把备份还原回去，再把旧版拉起来。

    为什么要这么绕：Electron 主进程崩溃、白屏、resources/app 里漏了文件，
    这些都表现为「能启动但立刻退出」。没有监护人时，用户只能看到程序闪一下就没了，
    还得自己去找备份。有了它，最坏情况是「升级失败，已自动还原」。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Target,

    [string]$UpdaterScript = '',
    [int]$SettleSeconds = 45,
    [int]$MissLimit = 3
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$stamp] $Message"
}

$statusDir = Join-Path $Target 'data\tmp'
if (-not (Test-Path -LiteralPath $statusDir)) {
    New-Item -ItemType Directory -Path $statusDir -Force | Out-Null
}
$logPath = Join-Path $statusDir 'self-heal.log'
function Write-Log([string]$Message) {
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    $line = "[$stamp] $Message"
    Write-Host $line
    try {
        Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch { }
}

$responsePath = Join-Path $statusDir 'self-heal.json'
$markerPath = Join-Path $statusDir 'last-update.json'
$exePath = Join-Path $Target '花筱灵启动器.exe'
if (-not (Test-Path -LiteralPath $exePath)) {
    Write-Log "[error] 主程序不存在：$exePath"
    exit 1
}
if (-not $UpdaterScript) {
    $UpdaterScript = Join-Path $Target 'resources\updater\HXL-Updater.ps1'
}

# 读上一次的监护记录，决定这次的判断口径
$previous = $null
if (Test-Path -LiteralPath $responsePath) {
    try { $previous = Get-Content -LiteralPath $responsePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
}
$failures = 0
if ($previous -and $previous.status -eq 'failed' -and [int]$previous.failures) {
    $failures = [int]$previous.failures
}
if ($failures -gt 0) { Write-Log "上一次监护失败记录：$failures 次" }

$aliveMs = 0
$misses = 0
$ok = $false

for ($attempt = 1; $attempt -le $MissLimit; $attempt++) {
    Write-Log "第 $attempt 次拉起启动器，观察 ${SettleSeconds}s"
    $started = Get-Date
    try {
        $proc = Start-Process -FilePath $exePath -WorkingDirectory $Target -PassThru
    } catch {
        Write-Log "[error] 启动失败：$($_.Exception.Message)"
        $misses += 1
        continue
    }

    $deadline = (Get-Date).AddSeconds($SettleSeconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        $proc.Refresh()
        if ($proc.HasExited) { break }
        $alive = ((Get-Date) - $started).TotalMilliseconds
        if ($alive -gt $aliveMs) { $aliveMs = [int]$alive }
        # 活过 8 秒基本就进了主窗口，没必要一直盯到 45 秒
        if ($alive -ge 8000) { break }
    }

    if (-not $proc.HasExited) {
        $ok = $true
        break
    }
    $misses += 1
    Write-Log "启动器在第 $attempt 次观察中退出（存活 $([int]((Get-Date) - $started).TotalMilliseconds)ms）"
}

if ($ok) {
    Write-Log "监护通过，启动器已正常运行"
    $payload = [ordered]@{
        status        = 'ok'
        failures      = 0
        attempts      = $misses + 1
        alivePreviewMs = $aliveMs
        checkedAt     = (Get-Date).ToString('o')
    }
    try { [System.IO.File]::WriteAllText($responsePath, ($payload | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($true))) } catch { }
    exit 0
}

$failures += 1
Write-Log "连续失败 $failures 次 / 上限 $MissLimit"

$isUpdate = $false
if (Test-Path -LiteralPath $markerPath) {
    try {
        $marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $isUpdate = ($marker.action -eq 'update')
    } catch { }
}

if (-not $isUpdate) {
    Write-Log "没有可回滚的升级记录，只上报失败，不还原"
    $payload = [ordered]@{
        status            = 'failed'
        failures          = $failures
        alivePreviewMs    = $aliveMs
        action            = 'none'
        reason            = 'no-update-marker'
        checkedAt         = (Get-Date).ToString('o')
    }
    try { [System.IO.File]::WriteAllText($responsePath, ($payload | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false))) } catch { }
    exit 2
}

if ($failures -lt $MissLimit) {
    Write-Log "还没到回滚阈值，只记录。下次启动会继续观察"
    $payload = [ordered]@{
        status         = 'failed'
        failures       = $failures
        alivePreviewMs = $aliveMs
        action         = 'pending'
        reason         = 'below-threshold'
        checkedAt      = (Get-Date).ToString('o')
    }
    try { [System.IO.File]::WriteAllText($responsePath, ($payload | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false))) } catch { }
    exit 2
}

Write-Log "达到回滚阈值，准备还原：$UpdaterScript"
$rollbackMeta = Join-Path $statusDir 'rollback-meta.json'
$backupRoot = ''
try {
    $marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $backupRoot = [string]$marker.backupRoot
    $backupList = @(Get-ChildItem -LiteralPath $backupRoot -Recurse -File -ErrorAction Stop | Where-Object { $_.Name -ne 'meta.json' } | ForEach-Object {
        $_.FullName.Substring($backupRoot.Length).TrimStart('\') -replace '\\', '/'
    })
    $payload = [ordered]@{
        action            = 'rollback'
        fromVersion       = [string]$marker.targetVersion
        targetVersion     = [string]$marker.fromVersion
        target            = $Target
        source            = $backupRoot
        files             = $backupList
        protectedExisting = @()
        relaunch          = $exePath
        statusDir         = $statusDir
    }
    [System.IO.File]::WriteAllText($rollbackMeta, ($payload | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($true)))
} catch {
    Write-Log "[error] 准备回滚清单失败：$($_.Exception.Message)"
    exit 3
}

# 交给覆盖脚本执行反向覆盖：它会先等所有进程退出，再还原、再拉起
$arguments = @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', $UpdaterScript,
    '-MetaPath', $rollbackMeta
)
Write-Log "执行回滚：$UpdaterScript"
try {
    Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden | Out-Null
} catch {
    Write-Log "[error] 回滚脚本启动失败：$($_.Exception.Message)"
    exit 3
}

$payload = [ordered]@{
    status            = 'rolled-back'
    failures          = $failures
    alivePreviewMs    = $aliveMs
    action            = 'rollback'
    backupRoot        = $backupRoot
    checkedAt         = (Get-Date).ToString('o')
}
try { [System.IO.File]::WriteAllText($responsePath, ($payload | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false))) } catch { }
Write-Log "已触发回滚"
exit 3
