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

$NodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $NodeCommand) {
  throw "Node.js >= 20 is required but was not found."
}

$NodeMajor = [int](& $NodeCommand.Source -p "process.versions.node.split('.')[0]")
if ($NodeMajor -lt 20) {
  throw "Node.js >= 20 is required. Found: $(& $NodeCommand.Source --version)"
}

$SupportedCli = Get-Command -Name claude, codex -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $SupportedCli) {
  throw "Install Claude Code CLI or OpenAI Codex CLI before installing clausona."
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
