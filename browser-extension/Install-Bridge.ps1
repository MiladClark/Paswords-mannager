param(
    [string]$AppPath = (Join-Path $PSScriptRoot '..\Passward.exe'),
    [ValidateSet('Chrome', 'Edge', 'Both')][string]$Browser = 'Both'
)
$ErrorActionPreference = 'Stop'
$resolvedApp = (Resolve-Path -LiteralPath $AppPath).Path
if ([IO.Path]::GetExtension($resolvedApp) -ne '.exe') { throw 'Choose the PassWards executable.' }
$bridgeDirectory = Join-Path $env:APPDATA 'com.parag.nook\browser'
New-Item -ItemType Directory -Path $bridgeDirectory -Force | Out-Null
$manifestPath = Join-Path $bridgeDirectory 'com.passward.bridge.json'
$manifest = @{
    name = 'com.passward.bridge'
    description = 'PassWards browser connection'
    path = $resolvedApp
    type = 'stdio'
    allowed_origins = @('chrome-extension://mhofghlpaigblofliecafkfgeklbgfdi/')
}
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
$browserRegistries = switch ($Browser) {
    'Chrome' { @('Google\Chrome') }
    'Edge' { @('Microsoft\Edge') }
    'Both' { @('Google\Chrome', 'Microsoft\Edge') }
}
foreach ($browserRegistry in $browserRegistries) {
    $key = "HKCU:\Software\$browserRegistry\NativeMessagingHosts\com.passward.bridge"
    New-Item -Path $key -Force | Out-Null
    Set-Item -LiteralPath $key -Value $manifestPath
}
Write-Output "PassWards native messaging is registered for $Browser for the current Windows user."
