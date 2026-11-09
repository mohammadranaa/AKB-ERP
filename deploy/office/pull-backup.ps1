# Weekly copy of the AKB ERP backup from AWS to this office server (Windows).
#
# Schedule it to run every day (see docs/OFFICE_BACKUP_COPY.md). It downloads only when the newest
# copy here is 6 days old or more, so it copies once a week and catches up by itself if this
# machine was switched off on the usual day.
#
# Settings: office-backup.conf next to this script. AWS login: aws-credentials next to this script.
# The copies stay encrypted; only the owners' backup key opens them.
param([switch]$Now)
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$conf = Join-Path $here 'office-backup.conf'
if (-not (Test-Path $conf)) { throw "missing $conf (copy office-backup.conf.example)" }
$cfg = @{}
foreach ($line in Get-Content $conf) {
  if ($line -match '^\s*([A-Z_]+)=(.*)$') { $cfg[$Matches[1]] = $Matches[2].Trim() }
}
foreach ($k in 'BUCKET', 'REGION', 'DEST') { if (-not $cfg[$k]) { throw "set $k in office-backup.conf" } }
$bucket = $cfg.BUCKET; $region = $cfg.REGION; $dest = $cfg.DEST
$keepDays = if ($cfg.KEEP_DAYS) { [int]$cfg.KEEP_DAYS } else { 365 }
$everyDays = if ($cfg.EVERY_DAYS) { [int]$cfg.EVERY_DAYS } else { 6 }

$env:AWS_SHARED_CREDENTIALS_FILE = Join-Path $here 'aws-credentials'
$env:AWS_CONFIG_FILE = Join-Path $here 'aws-config'
if (-not (Test-Path $env:AWS_SHARED_CREDENTIALS_FILE)) { throw "missing $($env:AWS_SHARED_CREDENTIALS_FILE)" }
$awsExe = Get-Command aws -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $awsExe) { throw 'the AWS CLI is not installed' }

New-Item -ItemType Directory -Force -Path $dest | Out-Null
$log = Join-Path $dest 'pull-backup.log'
function Say([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Output $line
  Add-Content -Path $log -Value $line
}
function Invoke-AwsCli([string[]]$a) {
  $out = & $awsExe @a
  if ($LASTEXITCODE -ne 0) { throw "aws $($a -join ' ') failed" }
  return $out
}

$copies = @(Get-ChildItem -Path $dest -Filter 'akb-*.dump.age' -File -ErrorAction SilentlyContinue)
$recent = $copies | Where-Object { $_.LastWriteTime -gt (Get-Date).AddDays(-$everyDays) }
if ($recent -and -not $Now) { exit 0 } # this week's copy is already here

try {
  $listing = Invoke-AwsCli @('s3', 'ls', '--region', $region, "s3://$bucket/daily/")
  $latest = @($listing | ForEach-Object { ($_ -split '\s+')[3] } | Where-Object { $_ -like '*.dump.age' } | Sort-Object) | Select-Object -Last 1
  if (-not $latest) { throw "no nightly backups found in s3://$bucket/daily/" }

  $target = Join-Path $dest $latest
  if (Test-Path $target) {
    throw "the newest backup on AWS ($latest) is the one already copied; AWS has made no new nightly backup for $everyDays days or more"
  }
  Say "copying $latest"
  $partial = "$target.partial"
  Invoke-AwsCli @('s3', 'cp', '--only-show-errors', '--region', $region, "s3://$bucket/daily/$latest", $partial) | Out-Null
  $expected = (Invoke-AwsCli @('s3api', 'head-object', '--region', $region, '--bucket', $bucket, '--key', "daily/$latest", '--query', 'Metadata.sha256', '--output', 'text') | Out-String).Trim()
  $actual = (Get-FileHash -Algorithm SHA256 -Path $partial).Hash.ToLower()
  if ($expected -ne $actual) { Remove-Item $partial -Force; throw "$latest arrived damaged (checksum mismatch); will try again tomorrow" }
  $buf = New-Object byte[] 21
  $fs = [System.IO.File]::OpenRead($partial)
  try { [void]$fs.Read($buf, 0, 21) } finally { $fs.Close() }
  if ([System.Text.Encoding]::ASCII.GetString($buf) -ne 'age-encryption.org/v1') { Remove-Item $partial -Force; throw "$latest is not an encrypted backup" }
  Move-Item $partial $target # keeps the backup's own date, which the 6-day check uses

  # Tell the AWS server this office has its copy (it emails an alert if no copy is collected for 8 days).
  $size = (Get-Item $target).Length
  $receipt = Join-Path $env:TEMP "akb-receipt-$PID.txt"
  @("collected=$((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))", "file=$latest", "bytes=$size", "host=$([Environment]::MachineName)") |
    Set-Content -Path $receipt -Encoding ascii
  Invoke-AwsCli @('s3', 'cp', '--only-show-errors', '--region', $region, $receipt, "s3://$bucket/office-receipts/latest.txt") | Out-Null
  Remove-Item $receipt -Force

  Get-ChildItem -Path $dest -Filter 'akb-*.dump.age' -File |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$keepDays) } |
    ForEach-Object { Remove-Item $_.FullName -Force; Add-Content -Path $log -Value "removed old copy $($_.Name)" }
  $count = @(Get-ChildItem -Path $dest -Filter 'akb-*.dump.age' -File).Count
  Say "ok: $latest ($size bytes); $count weekly copies kept"
} catch {
  Say "ERROR: $($_.Exception.Message)"
  exit 1
}
