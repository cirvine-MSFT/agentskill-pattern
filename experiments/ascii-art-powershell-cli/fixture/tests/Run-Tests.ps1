[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'src/TaskForge.ps1'
$benchmarkRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$temporaryRoot = Join-Path $benchmarkRoot ".scratch/fixture/taskforge-base-$([guid]::NewGuid())"
$dataFile = Join-Path $temporaryRoot 'tasks.json'
$failures = [System.Collections.Generic.List[string]]::new()

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) {
        $failures.Add($Message)
    }
}

function Invoke-TaskForge {
    param([string[]]$Arguments)
    $output = @(& $PSHOME\pwsh -NoProfile -File $scriptPath @Arguments 2>&1)
    [pscustomobject]@{
        ExitCode = $LASTEXITCODE
        Output = ($output -join "`n")
    }
}

try {
    New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null

    $add = Invoke-TaskForge @('add', '--title', 'First task', '--description', 'Fixture test', '--data-file', $dataFile, '--json')
    Assert-True ($add.ExitCode -eq 0) 'add should succeed'
    $added = $add.Output | ConvertFrom-Json
    Assert-True ($added.id -eq 1 -and $added.status -eq 'pending') 'add should return a pending task with ID 1'

    $list = Invoke-TaskForge @('list', '--data-file', $dataFile, '--json')
    Assert-True ($list.ExitCode -eq 0) 'list should succeed'
    Assert-True (@($list.Output | ConvertFrom-Json).Count -eq 1) 'list should return the stored task'

    $complete = Invoke-TaskForge @('complete', '--id', '1', '--data-file', $dataFile, '--json')
    Assert-True ($complete.ExitCode -eq 0) 'complete should succeed'
    Assert-True (($complete.Output | ConvertFrom-Json).status -eq 'completed') 'complete should persist completed status'

    $missing = Invoke-TaskForge @('complete', '--id', '99', '--data-file', $dataFile)
    Assert-True ($missing.ExitCode -ne 0) 'completing an unknown task should fail'

    $remove = Invoke-TaskForge @('remove', '--id', '1', '--data-file', $dataFile, '--json')
    Assert-True ($remove.ExitCode -eq 0) 'remove should succeed'
    Assert-True (($remove.Output | ConvertFrom-Json).removedId -eq 1) 'remove should report the removed ID'

    $empty = Invoke-TaskForge @('list', '--data-file', $dataFile)
    Assert-True ($empty.Output -eq 'No tasks.') 'empty list should have stable text'

    $help = Invoke-TaskForge @('help')
    Assert-True ($help.ExitCode -eq 0 -and $help.Output.Contains('TaskForge')) 'help should succeed'

    if ($failures.Count -gt 0) {
        $failures | ForEach-Object { [Console]::Error.WriteLine("FAIL: $_") }
        exit 1
    }
    "PASS: 8 base fixture assertions"
}
finally {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}
