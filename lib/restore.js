/**
 * 复原脚本生成。
 *
 * 场景定死：DSH 起不来了，插件面板点不动，人在别的终端前面。
 * 所以交付物必须是「一个能双击的东西」，不依赖 DSH 活着，也不依赖 node：
 *   覆盖复原.cmd -> restore.ps1
 * 步骤：确认 DSH 没在跑 -> 把现有 .dsh 改名叫 .dsh-broken-<时间>（同盘改名，瞬时）
 *      -> robocopy 把快照镜像回去 -> 还原外置链接内容与 junction -> 校验文件数
 * 失败（robocopy 退出码 > 7）就把它改回来，不留下半死不活的状态。
 */

export const RESTORE_PS1 = 'restore.ps1'
export const RESTORE_CMD = '覆盖复原.cmd'

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

export function buildRestoreScript({ dshHome, targetDir }) {
  const home = psQuote(dshHome)
  const target = psQuote(targetDir)

  const ps1 = String.raw`[CmdletBinding()]
param(
  [string]$Snapshot = ''
)

$ErrorActionPreference = 'Stop'
$Home2      = __HOME__
$BackupRoot = __TARGET__

function Say($msg) { Write-Host $msg }
function Bad($msg) { Write-Host $msg -ForegroundColor Red }

# 1) DSH 还在跑就别动，Windows 会把正在写的东西锁住，镜像到一半会毁掉两边
#    真实进程名是「DeepSeek Harness」（带空格），不能只按 DSH 找
$running = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $item = $_
  if ($item.ProcessName -match '^(deepseek|dsh)') { return $true }
  try { return ($item.Path -and ($item.Path -like '*\DSH\*.exe')) } catch { return $false }
}
if ($running) {
  Bad ('检测到 DSH 还在运行（' + (($running | ForEach-Object { $_.ProcessName + '#' + $_.Id }) -join ',') + '），先把它彻底退出再跑这个脚本。')
  exit 1
}

if (-not (Test-Path -LiteralPath $BackupRoot)) {
  Bad ('备份目录不存在: ' + $BackupRoot)
  exit 1
}

function Read-Manifest([string]$dir) {
  $file = Join-Path $dir 'manifest.json'
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  try { return Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}

# 2) 选快照：指定了就用指定的，没指定就挑最新的「完整」快照
if ($Snapshot) {
  $dir = Join-Path $BackupRoot $Snapshot
  if (-not (Test-Path -LiteralPath $dir)) { Bad ('没有这个快照: ' + $dir); exit 1 }
} else {
  $candidates = Get-ChildItem -LiteralPath $BackupRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\.dsh-\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?$' } |
    Sort-Object Name -Descending
  $dir = $null
  foreach ($item in $candidates) {
    $m = Read-Manifest $item.FullName
    if ($m -and $m.complete -eq $true) { $dir = $item.FullName; break }
  }
  if (-not $dir) {
    Bad '没有找到带完整清单的快照。2.x 时代的老快照没有 manifest，可以手动指定名字，但脚本无法替你确认它完整。'
    exit 1
  }
}

$manifest = Read-Manifest $dir
if (-not $manifest) {
  Bad ('这个快照没有 manifest.json，无法确认完整性，拒绝自动覆盖: ' + $dir)
  exit 1
}
if ($manifest.complete -ne $true) {
  Bad ('这个快照自己记录着不完整（失败 ' + $manifest.failureCount + ' 项），拒绝用它覆盖。')
  exit 1
}

Say ('使用快照: ' + (Split-Path $dir -Leaf))
Say ('  录制时间: ' + $manifest.startedAt + ' -> ' + $manifest.finishedAt)
Say ('  文件数: ' + $manifest.fileCount + '，大小: ' + [math]::Round($manifest.bytes / 1GB, 2) + ' GB')

# 2.5) 覆盖前先数一遍快照自己的文件：清单说有、盘上没有，就别拿去盖
$extFileCount = 0
foreach ($item in @($manifest.externals)) {
  if ($item -and $item.fileCount) { $extFileCount += [int]$item.fileCount }
}
$expectFiles = [int]$manifest.fileCount + $extFileCount
$snapshotFiles = (Get-ChildItem -LiteralPath $dir -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object).Count
if ($snapshotFiles -lt $expectFiles) {
  Bad ('快照自身文件不全：清单 ' + $expectFiles + '，盘上 ' + $snapshotFiles + '。拒绝用它覆盖。')
  exit 1
}

# 3) 现有 .dsh 改名留档（同盘 rename，几乎是瞬时的，可随时改回来）
$stamp = Get-Date -Format 'yyyy-MM-dd-HHmm'
$aside = ($Home2.TrimEnd('\')) + '.broken-' + $stamp
$n = 2
while (Test-Path -LiteralPath $aside) { $aside = ($Home2.TrimEnd('\')) + '.broken-' + $stamp + '-' + $n; $n++ }

$moved = $false
if (Test-Path -LiteralPath $Home2) {
  Say ('把现在的 .dsh 改名留档: ' + $aside)
  Move-Item -LiteralPath $Home2 -Destination $aside
  $moved = $true
}
New-Item -ItemType Directory -Path $Home2 -Force | Out-Null

# 4) 镜像回去
Say '开始覆盖（robocopy 镜像）……'
$log = Join-Path $BackupRoot ('restore-' + $stamp + '.log')
$roboArgs = @($dir, $Home2, '/MIR', '/COPY:DAT', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/MT:16')
& robocopy @roboArgs | Out-File -LiteralPath $log -Encoding UTF8
$code = $LASTEXITCODE
Say ('robocopy 退出码: ' + $code + '（0-7 正常，>=8 有文件没复制上）')

if ($code -ge 8) {
  Bad '覆盖失败，正在把原来的 .dsh 改回来……'
  if (Test-Path -LiteralPath $Home2) { Remove-Item -LiteralPath $Home2 -Recurse -Force -ErrorAction SilentlyContinue }
  if ($moved) { Move-Item -LiteralPath $aside -Destination $Home2 }
  Bad '已回滚。日志: ' + $log
  exit 1
}

# 5) 外置链接：内容写回原路径，node_modules 里的 junction 重建
foreach ($ext in @($manifest.externals)) {
  if (-not $ext) { continue }
  $stored = Join-Path $dir $ext.to
  if (-not (Test-Path -LiteralPath $stored)) {
    Bad ('外置内容缺: ' + $ext.rel)
    continue
  }
  $dest = $ext.from
  Say ('外置插件源写回: ' + $dest)
  New-Item -ItemType Directory -Path $dest -Force | Out-Null
  & robocopy $stored $dest '/E' '/COPY:DAT' '/R:1' '/W:1' '/NFL' '/NDL' '/NJH' '/NJS' | Out-Null

  if ($ext.rel -match '^(.*)/node_modules/(.+)$') {
    $profileRel = $Matches[1]
    $pkgPath = Join-Path (Join-Path $Home2 $profileRel.Replace('/', '\')) ('node_modules\' + $Matches[2].Replace('/', '\'))
    if (-not (Test-Path -LiteralPath $pkgPath)) {
      try {
        New-Item -ItemType Junction -Path $pkgPath -Target $dest | Out-Null
        Say ('  重建 junction: ' + $pkgPath)
      } catch {
        Bad ('  重建 junction 失败: ' + $pkgPath + ' -> ' + $($_.Exception.Message))
      }
    }
  }
}

# 6) 核对文件数：manifest 记的和盘上的一致才算完
$count = (Get-ChildItem -LiteralPath $Home2 -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object).Count
Say ('文件数: 盘上 ' + $count + ' / 清单 ' + $manifest.fileCount)
if ($count -lt [int]$manifest.fileCount) {
  Bad ('比清单少了 ' + ([int]$manifest.fileCount - $count) + ' 个文件，可能被占用或权限不足。原始 .dsh 留在 ' + $aside + '，需要时可以整个改回来。')
}
Say ''
Say '覆盖完成。现在启动 DSH。'
Say ('原 .dsh 留在: ' + $aside)
Say ('robocopy 日志: ' + $log)
`

  const cmd = `@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0${RESTORE_PS1}" %*
echo.
pause
`

  return {
    ps1: ps1.replace('__HOME__', home).replace('__TARGET__', target),
    cmd,
  }
}
