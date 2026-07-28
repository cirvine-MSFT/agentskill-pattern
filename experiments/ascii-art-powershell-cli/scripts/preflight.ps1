[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$failures = [System.Collections.Generic.List[string]]::new()

function Get-CanonicalTextSha256 {
    param([Parameter(Mandatory)][string]$Path)
    $text = [System.IO.File]::ReadAllText($Path).Replace("`r`n", "`n")
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($text)
    return [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}

if ($PSVersionTable.PSVersion.Major -lt 7) {
    $failures.Add("PowerShell 7+ is required; found $($PSVersionTable.PSVersion)")
}

$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
    $failures.Add('Node.js 20+ is required but node was not found.')
}
else {
    $nodeVersion = (& node --version).TrimStart('v').Split('.')[0]
    if ([int]$nodeVersion -lt 20) {
        $failures.Add("Node.js 20+ is required; found $(& node --version)")
    }
}

$pester = Get-Module -ListAvailable Pester |
    Where-Object Version -eq ([version]'5.7.1') |
    Select-Object -First 1
$pesterStatus = if ($null -eq $pester) {
    'unavailable; repository-owned fallback is normative'
}
else {
    'available at pinned version 5.7.1'
}

& node (Join-Path $PSScriptRoot 'create-locks.js') --check
if ($LASTEXITCODE -ne 0) { $failures.Add('Fixture or acceptance lock is stale.') }
& node (Join-Path $PSScriptRoot 'randomize.js') --check
if ($LASTEXITCODE -ne 0) { $failures.Add('Randomization output is stale.') }
& node (Join-Path $PSScriptRoot 'create-judge-assignments.js') --check
if ($LASTEXITCODE -ne 0) { $failures.Add('Judge assignments are stale.') }
& node (Join-Path $PSScriptRoot 'validate-dataset.js')
if ($LASTEXITCODE -ne 0) { $failures.Add('Dataset validation failed.') }
& pwsh -NoProfile -File (Join-Path $root 'fixture/tests/Run-Tests.ps1')
if ($LASTEXITCODE -ne 0) { $failures.Add('Base fixture tests failed.') }

$promptsHash = Get-CanonicalTextSha256 (Join-Path $root 'prompts.json')
$fixtureLockHash = Get-CanonicalTextSha256 (Join-Path $root 'fixture/fixture-lock.json')

if ($failures.Count -gt 0) {
    $failures | ForEach-Object { [Console]::Error.WriteLine("FAIL: $_") }
    exit 1
}

[pscustomobject]@{
    status = 'pass'
    powershell = $PSVersionTable.PSVersion.ToString()
    node = (& node --version)
    pester = $pesterStatus
    promptsSha256 = $promptsHash
    fixtureLockSha256 = $fixtureLockHash
} | ConvertTo-Json
