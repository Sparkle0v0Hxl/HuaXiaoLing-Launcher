const fs = require('fs');
const path = require('path');

const target = 'H:/花筱灵启动器-源码/scripts/build-portable.ps1';
let t = fs.readFileSync(target, 'utf8');

if (!t.includes("$top\\latest.json")) {
  const anchor = '# ---- 3) zip ----';
  const block = [
    '# ---- 2.5) 清单模板放进启动器文件夹 ----',
    '# 和 exe 同级放一份，别人拿到文件夹就知道去哪找更新。',
    '# 这份在 ZIP 内部，算不出自己所在 ZIP 的哈希，所以 sha256/size 留空。',
    "$notes = ''",
    "$title = ''",
    "$newsPath = 'src\\data\\news.json'",
    'if (Test-Path $newsPath) {',
    '  $news = Get-Content $newsPath -Raw -Encoding UTF8 | ConvertFrom-Json',
    '  $entry = $news | Where-Object { $_.version -eq $Version } | Select-Object -First 1',
    '  if ($entry) {',
    '    $title = [string]$entry.title',
    '    $lines = @()',
    '    foreach ($line in $entry.body) { $lines += "- $line" }',
    '    $notes = ($lines -join "`n")',
    '  }',
    '}',
    'if (-not $notes) { $notes = "花筱灵启动器 v$Version" }',
    '',
    '$inFolder = [ordered]@{',
    '  version   = $Version',
    "  date      = (Get-Date -Format 'yyyy-MM-dd')",
    '  title     = $title',
    '  notes     = $notes',
    '  url       = "HuaXiaoLing-$Version-Portable.zip"',
    "  sha256    = ''",
    '  size      = 0',
    '  mandatory = $false',
    '}',
    '$inFolderJson = $inFolder | ConvertTo-Json -Depth 4',
    '$utf8NoBom = New-Object System.Text.UTF8Encoding($false)',
    "[System.IO.File]::WriteAllText((Join-Path $top 'latest.json'), $inFolderJson, $utf8NoBom)",
    '[System.IO.File]::WriteAllText((Join-Path $top "latest-$Version.json"), $inFolderJson, $utf8NoBom)',
    'Write-Host "  in-folder manifest written"',
    '',
    '',
  ].join('\n');
  t = t.replace(anchor, block + anchor);
  console.log('in-folder manifest block added');
} else {
  console.log('in-folder block already present');
}

// 第 5 步：复用 $notes/$title，产出带哈希的外部分发清单
const marker = '# ---- 5) 自更新清单 latest.json ----';
const idx = t.indexOf(marker);
if (idx !== -1) {
  const tail = [
    '# ---- 5) 外部分发清单（带哈希，和 ZIP 放同一个目录）----',
    '$manifest = [ordered]@{',
    '  version   = $Version',
    "  date      = (Get-Date -Format 'yyyy-MM-dd')",
    '  title     = $title',
    '  notes     = $notes',
    '  url       = "HuaXiaoLing-$Version-Portable.zip"',
    '  sha256    = $hash',
    '  size      = $size',
    '  mandatory = $false',
    '}',
    '$manifestJson = $manifest | ConvertTo-Json -Depth 4',
    '$utf8 = New-Object System.Text.UTF8Encoding($false)',
    "[System.IO.File]::WriteAllText((Join-Path $outDir 'latest.json'), $manifestJson, $utf8)",
    '[System.IO.File]::WriteAllText((Join-Path $outDir "latest-$Version.json"), $manifestJson, $utf8)',
    'Write-Host "  latest: $(Join-Path $outDir \'latest.json\')"',
    '',
    'Remove-Item $Stage -Recurse -Force -ErrorAction SilentlyContinue',
    '',
    'Write-Host ""',
    'Write-Host "Done"',
    'Write-Host "  file  : $zip"',
    'Write-Host "  bytes : $size"',
    'Write-Host "  sha256: $hash"',
    '',
  ].join('\n');
  t = t.slice(0, idx) + tail;
  console.log('step 5 rewritten');
}

fs.writeFileSync(target, t, 'utf8');
console.log('done, len', t.length);
