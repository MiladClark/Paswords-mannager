param([Parameter(Mandatory=$true)][string]$Version)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($Version -notmatch '^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$') { throw 'Invalid version' }
$taskRelease = Join-Path $taskRoot 'release'
$taskStage = Join-Path $taskRelease "staging-$Version"
New-Item -ItemType Directory -Path $taskStage -Force | Out-Null
$taskExe = Join-Path $taskRoot 'src-tauri\target\release\passward.exe'
if (!(Test-Path -LiteralPath $taskExe)) { throw 'Build the standalone Windows executable first' }
$taskFileVersion = (Get-Item -LiteralPath $taskExe).VersionInfo.ProductVersion
if ($taskFileVersion -ne $Version) { throw "EXE version $taskFileVersion does not match $Version" }
$taskBase = "PassWards-$Version-windows-x64"
Copy-Item -LiteralPath $taskExe -Destination (Join-Path $taskStage 'PassWards.exe') -Force
@'
PassWards for Windows (x64)

Open PassWards.exe. No installer, Devtune account, or subscription is needed.
Requires Windows 10/11 and Microsoft Edge WebView2 Runtime.

Create a vault with a strong master passphrase. It cannot be reset or recovered.
Your encrypted vault is stored separately in your Windows user profile:
%APPDATA%\com.parag.nook\vault.sqlite3

For Chrome, Edge, or Brave: open Settings > Browsers in PassWards and follow extension setup.
If moving from another EXE location, use Repair connection in that same app.

This is an unsigned early release and has not had an independent security audit.
Keep an encrypted backup. Start with test data while evaluating the app.

Source and releases: https://github.com/MiladClark/Paswords-mannager
Documentation: https://devtune.app/docs/passwards
'@ | Set-Content -LiteralPath (Join-Path $taskStage 'README.txt') -Encoding utf8
$taskOutputExe = Join-Path $taskRelease "$taskBase.exe"
$taskZip = Join-Path $taskRelease "$taskBase.zip"
Copy-Item -LiteralPath $taskExe -Destination $taskOutputExe -Force
Compress-Archive -LiteralPath @((Join-Path $taskStage 'PassWards.exe'), (Join-Path $taskStage 'README.txt')) -DestinationPath $taskZip -Force
$taskFiles = @($taskOutputExe, $taskZip)
$taskSums = foreach ($taskFile in $taskFiles) {
    $taskHasher = [Security.Cryptography.SHA256]::Create()
    $taskStream = [IO.File]::OpenRead($taskFile)
    try { $taskHash = [BitConverter]::ToString($taskHasher.ComputeHash($taskStream)).Replace('-', '').ToLowerInvariant() }
    finally { $taskStream.Dispose(); $taskHasher.Dispose() }
    '{0}  {1}' -f $taskHash, [IO.Path]::GetFileName($taskFile)
}
$taskSums | Set-Content -LiteralPath (Join-Path $taskRelease 'SHA256SUMS.txt') -Encoding ascii
Write-Output "Prepared $taskBase.exe, $taskBase.zip and SHA256SUMS.txt"
