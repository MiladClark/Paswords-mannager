param([string]$AppPath = (Join-Path $PSScriptRoot '..\Passward.exe'))
$ErrorActionPreference = 'Stop'
$resolvedApp = (Resolve-Path -LiteralPath $AppPath).Path
if ([IO.Path]::GetExtension($resolvedApp) -ne '.exe') { throw 'Choose Passward.exe.' }
$bridgeDirectory = Join-Path $env:APPDATA 'com.parag.nook\browser'
New-Item -ItemType Directory -Path $bridgeDirectory -Force | Out-Null
$manifestPath = Join-Path $bridgeDirectory 'com.passward.bridge.json'
$manifest = @{
    name = 'com.passward.bridge'
    description = 'Passward browser connection'
    path = $resolvedApp
    type = 'stdio'
    allowed_origins = @('chrome-extension://mhofghlpaigblofliecafkfgeklbgfdi/')
}
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
foreach ($browserRegistry in @('Google\Chrome', 'Microsoft\Edge')) {
    $key = "HKCU:\Software\$browserRegistry\NativeMessagingHosts\com.passward.bridge"
    New-Item -Path $key -Force | Out-Null
    Set-Item -LiteralPath $key -Value $manifestPath
}
Write-Output 'Passward native messaging is registered for Chrome and Edge for the current Windows user.'
