[CmdletBinding()]
param(
  [string]$Version = "latest"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$AppName = "clausona"
$Repository = "larcane97/clausona"
$LocalAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME "AppData\Local" }
$AppDir = Join-Path $LocalAppData $AppName
$BinDir = Join-Path $HOME ".local\bin"
$EntryPoint = Join-Path $AppDir "index.js"

Write-Host ""
Write-Host "  clausona installer" -ForegroundColor Cyan
Write-Host ""

# Every node on PATH is considered, not just the first one. With an older node earlier
# in PATH the installer used to reject the machine even though a supported version was
# installed further along; install.sh walks all candidates the same way.
$NodeBin = $null
$NodeFound = $null
foreach ($candidate in @(Get-Command node -CommandType Application -All -ErrorAction SilentlyContinue)) {
  $major = 0
  try { $major = [int](& $candidate.Source -p "process.versions.node.split('.')[0]") } catch { $major = 0 }
  if ($major -ge 20) {
    $NodeBin = $candidate.Source
    break
  }
  # Remember the first too-old install so the failure can name what it found.
  if ((-not $NodeFound) -and ($major -gt 0)) {
    $NodeFound = "$(& $candidate.Source --version) at $($candidate.Source)"
  }
}

if (-not $NodeBin) {
  $reported = if ($NodeFound) { $NodeFound } else { "no node on PATH" }
  throw @"
Node.js >= 20 is required but not found.
Found: $reported

Install Node 20 or newer, then re-run this installer:
  winget install OpenJS.NodeJS.LTS
  https://nodejs.org/en/download
"@
}

Write-Host "  Using node: $NodeBin ($(& $NodeBin --version))"

$SupportedCli = Get-Command -Name claude, codex -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $SupportedCli) {
  throw @"
Claude Code CLI or OpenAI Codex CLI is required but neither was found.

Install one of them, then re-run this installer:
  Claude Code  https://docs.anthropic.com/en/docs/claude-code
  Codex CLI    https://github.com/openai/codex
"@
}

$DownloadUrl = if ($Version -eq "latest") {
  "https://github.com/$Repository/releases/latest/download/clausona.js"
} else {
  "https://github.com/$Repository/releases/download/$Version/clausona.js"
}

New-Item -ItemType Directory -Path $AppDir -Force | Out-Null
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null

Write-Host "  Downloading clausona ($Version)..."
Invoke-WebRequest -Uri $DownloadUrl -OutFile $EntryPoint -UseBasicParsing

$Launcher = '@echo off' + "`r`n" + 'node "%LOCALAPPDATA%\clausona\index.js" %*' + "`r`n"
Set-Content -LiteralPath (Join-Path $BinDir "clausona.cmd") -Value $Launcher -Encoding Ascii -NoNewline
Set-Content -LiteralPath (Join-Path $BinDir "csn.cmd") -Value $Launcher -Encoding Ascii -NoNewline

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$PathEntries = if ($UserPath) { $UserPath.Split(";") } else { @() }
if ($PathEntries -notcontains $BinDir) {
  $UpdatedPath = if ($UserPath) { "$UserPath;$BinDir" } else { $BinDir }
  [Environment]::SetEnvironmentVariable("Path", $UpdatedPath, "User")
}
if (($env:Path.Split(";")) -notcontains $BinDir) {
  $env:Path = "$env:Path;$BinDir"
}

$ProfilePath = $PROFILE.CurrentUserAllHosts
$ProfileDir = Split-Path -Parent $ProfilePath
New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
$ShellInitLine = 'Invoke-Expression (& clausona shell-init | Out-String) # clausona shell-init'
$ProfileContent = if (Test-Path -LiteralPath $ProfilePath) {
  Get-Content -LiteralPath $ProfilePath -Raw
} else {
  ""
}
if ($ProfileContent -notmatch "clausona shell-init") {
  Add-Content -LiteralPath $ProfilePath -Value "`r`n$ShellInitLine"
}

Write-Host "  Installed: $(Join-Path $BinDir 'clausona.cmd')" -ForegroundColor Green
Write-Host "  Shell integration: $ProfilePath" -ForegroundColor Green
Write-Host ""
Write-Host "  Open a new PowerShell window, then run:" -ForegroundColor Cyan
Write-Host "    clausona init"
Write-Host ""
