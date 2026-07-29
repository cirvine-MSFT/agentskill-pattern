[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$assertCase = Join-Path $root 'acceptance/Assert-Case.ps1'
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) "ascii-acceptance-regression-$([guid]::NewGuid())"

function Invoke-Case {
    param(
        [Parameter(Mandatory)][string]$Workspace,
        [string]$CaseId = 'P01',
        [int]$ProcessTimeoutMilliseconds = 30000
    )

    $output = & pwsh -NoProfile -File $assertCase -CaseId $CaseId -Workspace $Workspace -ProcessTimeoutMilliseconds $ProcessTimeoutMilliseconds
    $exitCode = $LASTEXITCODE
    [pscustomobject]@{
        ExitCode = $exitCode
        Result = ($output -join "`n") | ConvertFrom-Json
    }
}

try {
    $tokenOnlyWorkspace = Join-Path $temporaryRoot 'token-only'
    New-Item -ItemType Directory -Path (Join-Path $tokenOnlyWorkspace 'src') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $tokenOnlyWorkspace 'assets') -Force | Out-Null
    @'
param([Parameter(ValueFromRemainingArguments)][string[]]$CliArguments)
$isJson = $CliArguments -contains '--json'
$queryIndex = [Array]::IndexOf($CliArguments, '--query')
$query = if ($queryIndex -ge 0) { $CliArguments[$queryIndex + 1] } else { '' }
$statusIndex = [Array]::IndexOf($CliArguments, '--status')
if ($isJson) {
    $count = if ($statusIndex -ge 0) { 1 } else { 2 }
    @(1..$count | ForEach-Object { [pscustomobject]@{ id = $_; title = "match $_" } }) | ConvertTo-Json
}
elseif ($query -eq 'absent') {
    if (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'render-exact')) {
        [System.IO.File]::ReadAllText((Join-Path (Split-Path -Parent $PSScriptRoot) 'assets/search.txt')).TrimEnd("`r", "`n")
        'No matches'
    }
    else {
        "FIND`nNo matches"
    }
}
else {
    'FIND'
}
'@ | Set-Content -LiteralPath (Join-Path $tokenOnlyWorkspace 'src/TaskForge.ps1') -Encoding utf8NoBOM
    (1..12 | ForEach-Object { '++++++++++++++++++++' }) -join "`n" |
        ForEach-Object { [System.IO.File]::WriteAllText((Join-Path $tokenOnlyWorkspace 'assets/search.txt'), "$_`n", [System.Text.UTF8Encoding]::new($false)) }
    $tokenOnly = Invoke-Case $tokenOnlyWorkspace
    if ($tokenOnly.ExitCode -eq 0 -or $tokenOnly.Result.status -ne 'fail') {
        throw 'Token-only banner output unexpectedly passed acceptance.'
    }
    $bannerAssertion = @($tokenOnly.Result.assertions | Where-Object id -eq 'search-banner')
    if ($bannerAssertion.Count -ne 1 -or $bannerAssertion[0].status -ne 'fail') {
        throw 'Token-only banner output was not rejected by exact asset rendering assertion.'
    }

    $exactWorkspace = Join-Path $temporaryRoot 'exact-banner'
    Copy-Item -LiteralPath $tokenOnlyWorkspace -Destination $exactWorkspace -Recurse
    New-Item -ItemType File -Path (Join-Path $exactWorkspace 'render-exact') | Out-Null
    $exact = Invoke-Case $exactWorkspace
    if ($exact.ExitCode -ne 0 -or $exact.Result.status -ne 'pass') {
        throw "Exact banner asset output unexpectedly failed acceptance: $($exact.Result | ConvertTo-Json -Depth 8 -Compress)"
    }

    $p05Workspace = Join-Path $temporaryRoot 'p05'
    New-Item -ItemType Directory -Path (Join-Path $p05Workspace 'src') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $p05Workspace 'assets') -Force | Out-Null
    @'
param([Parameter(ValueFromRemainingArguments)][string[]]$CliArguments)
$idsIndex = [Array]::IndexOf($CliArguments, '--ids')
$dataIndex = [Array]::IndexOf($CliArguments, '--data-file')
$idsText = $CliArguments[$idsIndex + 1]
$dataFile = $CliArguments[$dataIndex + 1]
if ($idsText -in @('1,99', '1,1')) {
    [Console]::Error.WriteLine('invalid IDs')
    exit 1
}
$tasks = @((Get-Content -LiteralPath $dataFile -Raw) | ConvertFrom-Json)
$ids = @($idsText.Split(',') | ForEach-Object { [int]$_ })
$changed = @()
$already = @()
foreach ($id in $ids) {
    $task = $tasks | Where-Object id -eq $id
    if ($task.status -eq 'completed') {
        $already += $id
    }
    else {
        $task.status = 'completed'
        $changed += $id
    }
}
$json = ConvertTo-Json -InputObject @($tasks) -Depth 8
[System.IO.File]::WriteAllText($dataFile, "$json`n", [System.Text.UTF8Encoding]::new($false))
if ($CliArguments -contains '--json') {
    if ((Test-Path -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'wrong-summary')) -and $changed.Count -gt 0) {
        [pscustomobject]@{ changedIds = @($changed); alreadyCompletedIds = @() } | ConvertTo-Json
    }
    else {
        [pscustomobject]@{ changedIds = @($changed); alreadyCompletedIds = @($already) } | ConvertTo-Json
    }
}
else {
    [System.IO.File]::ReadAllText((Join-Path (Split-Path -Parent $PSScriptRoot) 'assets/bulk.txt')).TrimEnd("`r", "`n")
    'Completed.'
}
'@ | Set-Content -LiteralPath (Join-Path $p05Workspace 'src/TaskForge.ps1') -Encoding utf8NoBOM
    (1..12 | ForEach-Object { '++++++++++BULK+++++++' }) -join "`n" |
        ForEach-Object { [System.IO.File]::WriteAllText((Join-Path $p05Workspace 'assets/bulk.txt'), "$_`n", [System.Text.UTF8Encoding]::new($false)) }
    $p05Positive = Invoke-Case $p05Workspace -CaseId P05
    if ($p05Positive.ExitCode -ne 0 -or $p05Positive.Result.status -ne 'pass') {
        throw "Exact P05 changed/already-completed ID summaries unexpectedly failed acceptance: $($p05Positive.Result | ConvertTo-Json -Depth 8 -Compress)"
    }
    New-Item -ItemType File -Path (Join-Path $p05Workspace 'wrong-summary') | Out-Null
    $p05Negative = Invoke-Case $p05Workspace -CaseId P05
    $p05Assertion = @($p05Negative.Result.assertions | Where-Object id -eq 'bulk-complete')
    if ($p05Negative.ExitCode -eq 0 -or $p05Assertion.Count -ne 1 -or $p05Assertion[0].status -ne 'fail') {
        throw 'Incorrect P05 already-completed ID summary unexpectedly passed acceptance.'
    }

    $timeoutWorkspace = Join-Path $temporaryRoot 'timeout'
    New-Item -ItemType Directory -Path (Join-Path $timeoutWorkspace 'src') -Force | Out-Null
    @'
$child = Start-Process pwsh -ArgumentList '-NoProfile', '-Command', 'Start-Sleep -Seconds 60' -PassThru
[System.IO.File]::WriteAllText((Join-Path (Split-Path -Parent $PSScriptRoot) 'child.pid'), [string]$child.Id)
Start-Sleep -Seconds 60
'@ | Set-Content -LiteralPath (Join-Path $timeoutWorkspace 'src/TaskForge.ps1') -Encoding utf8NoBOM
    $timeout = Invoke-Case $timeoutWorkspace -ProcessTimeoutMilliseconds 2000
    if ($timeout.ExitCode -eq 0 -or $timeout.Result.status -ne 'fail') {
        throw 'Timed-out CLI process unexpectedly passed acceptance.'
    }
    $timeoutAssertions = @($timeout.Result.assertions | Where-Object id -like 'process-timeout-*')
    if ($timeoutAssertions.Count -ne 1 -or $timeoutAssertions[0].status -ne 'fail') {
        throw 'Timed-out CLI process did not record a deterministic timeout failure.'
    }
    $childPid = [int][System.IO.File]::ReadAllText((Join-Path $timeoutWorkspace 'child.pid'))
    if ($null -ne (Get-Process -Id $childPid -ErrorAction SilentlyContinue)) {
        throw 'Timed-out CLI process left its child process running.'
    }

    'PASS: acceptance validates exact banners/P05 IDs and records timeout process-tree termination'
}
finally {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}
