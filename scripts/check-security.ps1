param([string]$AuditTool = 'cargo-audit', [string]$AdvisoryDatabase = '')
$ErrorActionPreference = 'Stop'
$taskSource = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location -LiteralPath $taskSource
try {
    # Developer/CI checks only. None of this code is bundled into the desktop app.
    pnpm audit --audit-level low
    if ($LASTEXITCODE -ne 0) { throw 'JavaScript dependency audit failed' }
    $taskAuditArgs = @('audit','--file','src-tauri/Cargo.lock','--json')
    if ($AdvisoryDatabase) { $taskAuditArgs += @('--db',$AdvisoryDatabase,'--no-fetch') }
    $taskRustJson = & $AuditTool @taskAuditArgs
    $taskRustAudit = ($taskRustJson -join "`n") | ConvertFrom-Json
    if (!$taskRustAudit -or $null -eq $taskRustAudit.vulnerabilities) { throw 'Rust dependency audit did not produce a valid report' }
    if ($taskRustAudit.vulnerabilities.found) { throw 'Rust dependency vulnerabilities were found' }
    $taskWindowsTree = cargo tree --manifest-path src-tauri/Cargo.toml --locked --target x86_64-pc-windows-msvc --prefix none --format '{p}'
    if ($LASTEXITCODE -ne 0) { throw 'Could not resolve Windows dependency graph' }
    foreach ($taskGroup in $taskRustAudit.warnings.PSObject.Properties) {
        foreach ($taskWarning in $taskGroup.Value) {
            $taskPattern = '^' + [regex]::Escape($taskWarning.package.name) + ' v' + [regex]::Escape($taskWarning.package.version) + '(\s|$)'
            if ($taskWindowsTree -match $taskPattern) {
                Write-Warning "$($taskWarning.advisory.id): $($taskWarning.package.name) ($($taskGroup.Name))"
                if ($taskGroup.Name -eq 'unsound') { throw 'An unsound Windows dependency requires review' }
            } else {
                Write-Output "$($taskWarning.advisory.id): not in the Windows dependency graph"
            }
        }
    }
    cargo test --release --manifest-path src-tauri/Cargo.toml --lib --locked --no-default-features
    if ($LASTEXITCODE -ne 0) { throw 'Security regression tests failed' }
} finally { Pop-Location }
