$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ws   = 'C:\Users\Administrator\Documents\deepseek-harness\default-workspace'
$inst = 'H:\花筱灵启动器'
$src  = 'H:\花筱灵启动器-源码'
$ver  = '2.1.2'

Write-Host "== 1. 复制 ZIP 到工作区根目录"
$zip = Join-Path $inst "build\HuaXiaoLing-$ver-Portable.zip"
$out = Join-Path $ws "HuaXiaoLing-$ver-Portable.zip"
Copy-Item -LiteralPath $zip -Destination $out -Force
$h = (Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash.ToLower()
$size = (Get-Item -LiteralPath $out).Length
Write-Host "   $out"
Write-Host "   大小 $size 字节"
Write-Host "   sha256 $h"

Write-Host "== 2. 更新工作区 latest.json"
$latestPath = Join-Path $ws 'latest.json'
$latest = $null
if (Test-Path -LiteralPath $latestPath) { $latest = Get-Content -LiteralPath $latestPath -Raw -Encoding UTF8 | ConvertFrom-Json }
$url = "https://github.com/Sparkle0v0Hxl/HuaXiaoLing-Launcher/releases/download/v$ver/HuaXiaoLing-$ver-Portable.zip"
$notes = @(
  '小播放器收起改为原地缩回，关掉后不再自己出现，设置里可彻底关闭',
  'QQ 音乐 / 酷狗账号歌单修复：取歌单前重新读取登录凭据，酷狗自动补用户 ID',
  '报错文案改成中文，能直接看出是没登录、登录过期还是接口改版',
  '设置页与点歌台的开关按钮重新对齐，圆点四边等距',
  '启动页切换游戏后恢复播放动态图'
) -join "`n"
$json = [ordered]@{
  version = $ver
  url     = $url
  sha256  = $h
  size    = $size
  notes   = $notes
  channel = 'stable'
}
$json | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $latestPath -Encoding UTF8
Write-Host "   latest.json 已更新 -> $ver"

Write-Host "== 3. 同步源码目录"
robocopy (Join-Path $ws 'vela-launcher\electron') (Join-Path $src 'electron') /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
robocopy (Join-Path $ws 'vela-launcher\src')      (Join-Path $src 'src')      /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
robocopy (Join-Path $ws 'vela-launcher\scripts')  (Join-Path $src 'scripts')  /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if (Test-Path (Join-Path $ws 'vela-launcher\build')) {
  robocopy (Join-Path $ws 'vela-launcher\build') (Join-Path $src 'build') /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
}
foreach ($f in @('package.json','LICENSE','README.md','启动-安全模式.bat')) {
  $p = Join-Path $ws "vela-launcher\$f"
  if (Test-Path -LiteralPath $p) { Copy-Item -LiteralPath $p -Destination (Join-Path $src $f) -Force }
}

Write-Host "== 4. 校验"
$pairs = @(
  @{ a = Join-Path $ws 'vela-launcher\src\app.js';     b = Join-Path $src 'src\app.js' },
  @{ a = Join-Path $ws 'vela-launcher\src\styles.css'; b = Join-Path $src 'src\styles.css' },
  @{ a = Join-Path $ws 'vela-launcher\electron\main.js'; b = Join-Path $src 'electron\main.js' }
)
foreach ($p in $pairs) {
  $ha = (Get-FileHash -LiteralPath $p.a -Algorithm SHA256).Hash
  $hb = (Get-FileHash -LiteralPath $p.b -Algorithm SHA256).Hash
  Write-Host ("   {0,-14} {1}" -f (Split-Path $p.a -Leaf), $(if ($ha -eq $hb) { 'EQUAL' } else { 'DIFF' }))
}

Write-Host "== 完成"
