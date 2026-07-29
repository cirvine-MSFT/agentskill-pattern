[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path (Split-Path -Parent $PSScriptRoot) 'Acceptance.Support.psm1') -Force

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) "taskforge-acceptance-support-$([guid]::NewGuid())"
$failures = [System.Collections.Generic.List[string]]::new()

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { $failures.Add($Message) }
}

try {
    New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
    $asset = Join-Path $temporaryRoot 'banner.txt'
    [System.IO.File]::WriteAllText($asset, "FULL BANNER LINE 1`nFULL BANNER LINE 2`n", [System.Text.UTF8Encoding]::new($false))

    $tokenOnly = [pscustomobject]@{ ExitCode = 0; TimedOut = $false; StdOut = 'FULL'; StdErr = '' }
    Assert-True (-not (Test-AcceptanceBanner -Result $tokenOnly -AssetPath $asset)) 'A token-only fake banner must be rejected.'
    $exact = [pscustomobject]@{ ExitCode = 0; TimedOut = $false; StdOut = "prefix`nFULL BANNER LINE 1`nFULL BANNER LINE 2`nsuffix"; StdErr = '' }
    Assert-True (Test-AcceptanceBanner -Result $exact -AssetPath $asset) 'The exact consecutive asset lines must be accepted.'

    Assert-True (Test-ExactIntegerArray @(1) @(1)) 'Exact changed ID array should pass.'
    Assert-True (-not (Test-ExactIntegerArray @('1') @(1))) 'Quoted string IDs must fail integer-array validation.'
    Assert-True (-not (Test-ExactIntegerArray @(2) @(1))) 'Wrong changed ID must fail.'
    Assert-True (-not (Test-ExactIntegerArray @(2, 1) @(1, 2))) 'Wrong ID ordering must fail.'

    $pidFile = Join-Path $temporaryRoot 'child.pid'
    $sleepScript = Join-Path $temporaryRoot 'SleepTree.ps1'
    @'
param([string]$PidFile)
$child = Start-Process -FilePath (Get-Command pwsh).Source -ArgumentList '-NoProfile', '-Command', 'Start-Sleep -Seconds 30' -PassThru
[System.IO.File]::WriteAllText($PidFile, [string]$child.Id)
Start-Sleep -Seconds 30
'@ | Set-Content -LiteralPath $sleepScript -Encoding utf8NoBOM
    $timed = Invoke-AcceptanceProcess -FilePath $sleepScript -Arguments @($pidFile) -TimeoutMilliseconds 1000
    Assert-True ($timed.TimedOut -and $timed.ExitCode -eq 124 -and $timed.StdErr.Contains('timed out')) 'Timeout must be recorded as exit 124 failure.'
    if (Test-Path -LiteralPath $pidFile) {
        $childId = [int](Get-Content -LiteralPath $pidFile -Raw)
        Start-Sleep -Milliseconds 200
        Assert-True ($null -eq (Get-Process -Id $childId -ErrorAction SilentlyContinue)) 'Timeout must terminate the descendant process tree.'
    }
    else {
        $failures.Add('Timeout fixture did not record its child PID.')
    }

    if ($failures.Count -gt 0) {
        $failures | ForEach-Object { [Console]::Error.WriteLine("FAIL: $_") }
        exit 1
    }
    'PASS: 8 acceptance support regression assertions'
}
finally {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}
