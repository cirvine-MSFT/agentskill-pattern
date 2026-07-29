[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^P(0[1-9]|10)$')][string]$CaseId,
    [Parameter(Mandatory)][string]$Workspace,
    [ValidateRange(1, 30000)][int]$ProcessTimeoutMilliseconds = 30000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'ProcessRunner.psm1') -Force

$cli = Join-Path $Workspace 'src/TaskForge.ps1'
$benchmarkRoot = Split-Path -Parent $PSScriptRoot
$temporaryRoot = Join-Path $benchmarkRoot ".scratch/acceptance/taskforge-$CaseId-$([guid]::NewGuid())"
$dataFile = Join-Path $temporaryRoot 'data/tasks.json'
$assertions = [System.Collections.Generic.List[object]]::new()
$invocationSequence = 0

function Add-Assertion {
    param([string]$Id, [bool]$Passed, [string]$Message)
    $assertions.Add([pscustomobject]@{
        id = $Id
        status = if ($Passed) { 'pass' } else { 'fail' }
        message = $Message
    })
}

function Invoke-Cli {
    param([Parameter(ValueFromRemainingArguments)][string[]]$Arguments)

    $script:invocationSequence += 1
    $result = Invoke-BoundedProcess `
        -FileName (Get-Command pwsh).Source `
        -ArgumentList (@('-NoProfile', '-File', $cli) + $Arguments) `
        -TimeoutMilliseconds $ProcessTimeoutMilliseconds
    if ($result.TimedOut) {
        Add-Assertion "process-timeout-$invocationSequence" $false "CLI process exceeded the fixed $ProcessTimeoutMilliseconds ms timeout and its process tree was terminated."
        throw [System.TimeoutException]::new("CLI process timed out after $ProcessTimeoutMilliseconds ms.")
    }
    return $result
}

function Test-BannerRendered {
    param(
        [Parameter(Mandatory)][object]$Result,
        [Parameter(Mandatory)][string]$RelativePath,
        [Parameter(Mandatory)][string]$ExpectedResultPattern
    )

    $bannerPath = Join-Path $Workspace $RelativePath
    if (-not (Test-Path -LiteralPath $bannerPath)) {
        return $false
    }
    $banner = [System.IO.File]::ReadAllText($bannerPath).Replace("`r`n", "`n").Replace("`r", "`n").TrimEnd("`n")
    $stdout = $Result.StdOut.Replace("`r`n", "`n").Replace("`r", "`n")
    if ($Result.ExitCode -ne 0 -or $banner.Length -eq 0) {
        return $false
    }
    $firstIndex = $stdout.IndexOf($banner, [System.StringComparison]::Ordinal)
    if ($firstIndex -ne 0) {
        return $false
    }
    $secondIndex = $stdout.IndexOf(
        $banner,
        $firstIndex + 1,
        [System.StringComparison]::Ordinal
    )
    if ($secondIndex -ne -1) {
        return $false
    }
    $resultText = $stdout.Substring($banner.Length).Trim()
    return $resultText.Length -gt 0 -and $resultText -match $ExpectedResultPattern
}

function Test-ExactIntegerArray {
    param(
        [AllowNull()][object]$Actual,
        [Parameter(Mandatory)][AllowEmptyCollection()][int[]]$Expected
    )

    if ($Actual -isnot [System.Array]) {
        return $false
    }
    $actualValues = @($Actual)
    if ($actualValues.Count -ne $Expected.Count) {
        return $false
    }
    $integerTypeCodes = @(
        [System.TypeCode]::SByte,
        [System.TypeCode]::Byte,
        [System.TypeCode]::Int16,
        [System.TypeCode]::UInt16,
        [System.TypeCode]::Int32,
        [System.TypeCode]::UInt32,
        [System.TypeCode]::Int64,
        [System.TypeCode]::UInt64
    )
    for ($index = 0; $index -lt $Expected.Count; $index++) {
        if ($null -eq $actualValues[$index] -or
            [System.Type]::GetTypeCode($actualValues[$index].GetType()) -notin $integerTypeCodes -or
            [decimal]$actualValues[$index] -ne [decimal]$Expected[$index]) {
            return $false
        }
    }
    return $true
}

function Write-Tasks {
    param([object[]]$Tasks)
    $parent = Split-Path -Parent $dataFile
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $json = ConvertTo-Json -InputObject @($Tasks) -Depth 8
    [System.IO.File]::WriteAllText($dataFile, "$json`n", [System.Text.UTF8Encoding]::new($false))
}

function Read-Tasks {
    @((Get-Content -LiteralPath $dataFile -Raw) | ConvertFrom-Json)
}

function Get-HashOrMissing {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path) {
        return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    }
    return '<missing>'
}

$seedTasks = @(
    [pscustomobject]@{ id = 1; title = 'Alpha release'; description = 'Ship core'; status = 'pending'; createdAt = '2026-01-01T10:00:00.0000000+00:00' },
    [pscustomobject]@{ id = 2; title = 'Beta review'; description = 'Review alpha notes'; status = 'completed'; createdAt = '2026-01-02T10:00:00.0000000+00:00' },
    [pscustomobject]@{ id = 3; title = 'Gamma docs'; description = 'Write guide'; status = 'pending'; createdAt = '2026-01-02T11:00:00.0000000+00:00' }
)

$acceptanceStarted = $false
try {
    $acceptanceStarted = $true
    if (-not (Test-Path -LiteralPath $cli)) {
        Add-Assertion 'cli-present' $false "Candidate CLI not found: $cli"
        throw [System.IO.FileNotFoundException]::new("Candidate CLI not found: $cli", $cli)
    }
    New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null

    switch ($CaseId) {
        'P01' {
            Write-Tasks $seedTasks
            $jsonResult = Invoke-Cli 'search' '--query' 'ALPHA' '--data-file' $dataFile '--json'
            $matches = @($jsonResult.StdOut | ConvertFrom-Json)
            Add-Assertion 'search-json' ($jsonResult.ExitCode -eq 0 -and $matches.Count -eq 2) 'JSON search finds title and description matches case-insensitively.'
            Add-Assertion 'search-json-clean' (-not $jsonResult.StdOut.Contains('FIND')) 'JSON search output is banner-free.'
            $filtered = Invoke-Cli 'search' '--query' 'alpha' '--status' 'pending' '--data-file' $dataFile '--json'
            Add-Assertion 'search-status' ($filtered.ExitCode -eq 0 -and @($filtered.StdOut | ConvertFrom-Json).Count -eq 1) 'Status filter narrows matches.'
            $empty = Invoke-Cli 'search' '--query' 'absent' '--data-file' $dataFile
            Add-Assertion 'search-empty' ($empty.ExitCode -eq 0 -and $empty.StdOut -match 'No .*match') 'Text search has stable empty output.'
            Add-Assertion 'search-banner' (Test-BannerRendered $empty 'assets/search.txt' '(?i)No .*match') 'Text search renders the exact registered banner once before its expected result.'
        }
        'P02' {
            Write-Tasks @($seedTasks[0])
            $csv = Join-Path $temporaryRoot 'valid.csv'
            "Title,Description,Status`nImported one,From CSV,pending`nImported two,,completed`n" | Set-Content -LiteralPath $csv -Encoding utf8NoBOM
            $result = Invoke-Cli 'import-csv' '--path' $csv '--data-file' $dataFile '--json'
            $summary = $result.StdOut | ConvertFrom-Json
            $tasks = Read-Tasks
            Add-Assertion 'import-valid' ($result.ExitCode -eq 0 -and $summary.importedCount -eq 2 -and $tasks.Count -eq 3) 'Valid rows import with a stable count.'
            Add-Assertion 'import-ids' (($tasks[1].id -eq 2) -and ($tasks[2].id -eq 3)) 'Imported IDs are sequential.'
            $textCsv = Join-Path $temporaryRoot 'text.csv'
            "Title,Description,Status`nText import,,pending`n" | Set-Content -LiteralPath $textCsv -Encoding utf8NoBOM
            $textImport = Invoke-Cli 'import-csv' '--path' $textCsv '--data-file' $dataFile
            Add-Assertion 'import-banner' (Test-BannerRendered $textImport 'assets/import.txt' '(?i)\b(import|row|task)\w*\b.*\b1\b|\b1\b.*\b(import|row|task)\w*\b') 'Text import renders the exact registered banner once before its expected count result.'
            $badCsv = Join-Path $temporaryRoot 'invalid.csv'
            "Title,Description,Status`nGood,row,pending`n,missing,completed`n" | Set-Content -LiteralPath $badCsv -Encoding utf8NoBOM
            $before = Get-HashOrMissing $dataFile
            $bad = Invoke-Cli 'import-csv' '--path' $badCsv '--data-file' $dataFile
            Add-Assertion 'import-atomic' ($bad.ExitCode -ne 0 -and (Get-HashOrMissing $dataFile) -eq $before) 'Invalid CSV leaves storage byte-identical.'
        }
        'P03' {
            Write-Tasks $seedTasks
            $destination = Join-Path $temporaryRoot 'nested/export.json'
            $result = Invoke-Cli 'export-json' '--path' $destination '--status' 'pending' '--data-file' $dataFile '--json'
            $summary = $result.StdOut | ConvertFrom-Json
            $exported = @((Get-Content -LiteralPath $destination -Raw) | ConvertFrom-Json)
            Add-Assertion 'export-filtered' ($result.ExitCode -eq 0 -and $summary.exportedCount -eq 2 -and $exported.Count -eq 2) 'Filtered export writes the expected tasks and count.'
            Add-Assertion 'export-order' ($exported[0].id -eq 1 -and $exported[1].id -eq 3) 'Export is ordered by numeric ID.'
            $textExport = Invoke-Cli 'export-json' '--path' (Join-Path $temporaryRoot 'text-export.json') '--data-file' $dataFile
            Add-Assertion 'export-banner' (Test-BannerRendered $textExport 'assets/export.txt' '(?i)\b(export|destination|task)\w*\b') 'Text export renders the exact registered banner once before its expected summary.'
            [System.IO.File]::WriteAllText($destination, "sentinel`n")
            $bad = Invoke-Cli 'export-json' '--path' $destination '--status' 'invalid' '--data-file' $dataFile
            Add-Assertion 'export-invalid-atomic' ($bad.ExitCode -ne 0 -and (Get-Content -LiteralPath $destination -Raw) -eq "sentinel`n") 'Invalid status does not replace destination.'
        }
        'P04' {
            $config = Join-Path $temporaryRoot 'settings/taskforge.json'
            $setData = Invoke-Cli 'config' 'set' '--key' 'dataFile' '--value' '../custom/tasks.json' '--config-file' $config '--json'
            $setJson = Invoke-Cli 'config' 'set' '--key' 'defaultJson' '--value' 'true' '--config-file' $config '--json'
            Add-Assertion 'config-set' ($setData.ExitCode -eq 0 -and $setJson.ExitCode -eq 0) 'Supported configuration keys can be set.'
            $add = Invoke-Cli 'add' '--title' 'Configured task' '--config-file' $config
            $configuredData = [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $config) '../custom/tasks.json'))
            Add-Assertion 'config-defaults' ($add.ExitCode -eq 0 -and (Test-Path -LiteralPath $configuredData) -and $add.StdOut.StartsWith('{')) 'Relative dataFile and defaultJson are applied.'
            $list = Invoke-Cli 'config' 'list' '--config-file' $config '--json'
            Add-Assertion 'config-list-json' ($list.ExitCode -eq 0 -and -not $list.StdOut.Contains('CONFIG')) 'JSON config list is valid and banner-free.'
            $get = Invoke-Cli 'config' 'get' '--key' 'dataFile' '--config-file' $config '--json'
            Add-Assertion 'config-get' ($get.ExitCode -eq 0 -and $get.StdOut.Contains('../custom/tasks.json')) 'Config get returns a stored value.'
            $explicitData = Join-Path $temporaryRoot 'explicit/tasks.json'
            $explicit = Invoke-Cli 'add' '--title' 'Explicit path' '--config-file' $config '--data-file' $explicitData '--json'
            $explicitTasks = if (Test-Path -LiteralPath $explicitData) { @((Get-Content -LiteralPath $explicitData -Raw) | ConvertFrom-Json) } else { @() }
            Add-Assertion 'config-override' ($explicit.ExitCode -eq 0 -and $explicitTasks.Count -eq 1) 'Explicit data-file overrides configured dataFile.'
            $textList = Invoke-Cli 'config' 'list' '--config-file' $config
            Add-Assertion 'config-banner' (Test-BannerRendered $textList 'assets/config.txt' '(?i)\b(dataFile|defaultJson)\b') 'Text config list renders the exact registered banner once before expected settings.'
            $before = Get-HashOrMissing $config
            $bad = Invoke-Cli 'config' 'set' '--key' 'unknown' '--value' 'x' '--config-file' $config
            Add-Assertion 'config-invalid-atomic' ($bad.ExitCode -ne 0 -and (Get-HashOrMissing $config) -eq $before) 'Unknown key leaves config unchanged.'
        }
        'P05' {
            Write-Tasks $seedTasks
            $result = Invoke-Cli 'complete-many' '--ids' '1,2' '--data-file' $dataFile '--json'
            $summary = $result.StdOut | ConvertFrom-Json
            $tasks = Read-Tasks
            Add-Assertion 'bulk-complete' (
                $result.ExitCode -eq 0 -and
                (Test-ExactIntegerArray $summary.changedIds @(1)) -and
                (Test-ExactIntegerArray $summary.alreadyCompletedIds @(2)) -and
                ($tasks | Where-Object status -eq 'completed').Count -eq 2
            ) 'Bulk completion reports exact integer changed and already-completed ID sets.'
            $before = Get-HashOrMissing $dataFile
            $bad = Invoke-Cli 'complete-many' '--ids' '1,99' '--data-file' $dataFile
            Add-Assertion 'bulk-unknown-atomic' ($bad.ExitCode -ne 0 -and (Get-HashOrMissing $dataFile) -eq $before) 'Unknown ID leaves storage byte-identical.'
            $duplicate = Invoke-Cli 'complete-many' '--ids' '1,1' '--data-file' $dataFile
            Add-Assertion 'bulk-duplicate' ($duplicate.ExitCode -ne 0) 'Duplicate IDs are rejected.'
            $again = Invoke-Cli 'complete-many' '--ids' '1,2' '--data-file' $dataFile '--json'
            $againSummary = $again.StdOut | ConvertFrom-Json
            Add-Assertion 'bulk-idempotent' (
                $again.ExitCode -eq 0 -and
                (Test-ExactIntegerArray $againSummary.changedIds @()) -and
                (Test-ExactIntegerArray $againSummary.alreadyCompletedIds @(1, 2))
            ) 'Repeated completion reports no changes and the exact integer already-completed IDs.'
            $textBulk = Invoke-Cli 'complete-many' '--ids' '1,2' '--data-file' $dataFile
            Add-Assertion 'bulk-banner' (Test-BannerRendered $textBulk 'assets/bulk.txt' '(?i)\b(complet|already|changed|task)\w*\b') 'Text bulk completion renders the exact registered banner once before its expected summary.'
        }
        'P06' {
            $legacy = [pscustomobject]@{ id = 1; title = 'Legacy'; description = ''; status = 'pending'; createdAt = '2026-01-01T00:00:00Z' }
            Write-Tasks @($legacy)
            $first = Invoke-Cli 'add' '--title' 'Later' '--due' '2026-04-02' '--data-file' $dataFile '--json'
            $second = Invoke-Cli 'add' '--title' 'Sooner' '--due' '2026-04-01' '--data-file' $dataFile '--json'
            Add-Assertion 'due-add' ($first.ExitCode -eq 0 -and $second.ExitCode -eq 0) 'Add accepts strict due dates while retaining legacy data.'
            $report = Invoke-Cli 'due' '--on-or-before' '2026-04-02' '--data-file' $dataFile '--json'
            $items = @($report.StdOut | ConvertFrom-Json)
            Add-Assertion 'due-order' ($items.Count -eq 2 -and $items[0].title -eq 'Sooner' -and $items[0].overdue -eq $true) 'Due report filters, sorts, and derives overdue from supplied date.'
            $completed = Invoke-Cli 'complete' '--id' '2' '--data-file' $dataFile
            $pendingOnly = @((Invoke-Cli 'due' '--on-or-before' '2026-04-02' '--data-file' $dataFile '--json').StdOut | ConvertFrom-Json)
            $includingCompleted = @((Invoke-Cli 'due' '--on-or-before' '2026-04-02' '--include-completed' '--data-file' $dataFile '--json').StdOut | ConvertFrom-Json)
            Add-Assertion 'due-completed-filter' ($completed.ExitCode -eq 0 -and $pendingOnly.Count -eq 1 -and $includingCompleted.Count -eq 2) 'Due reports exclude completed tasks by default and include them on request.'
            $textDue = Invoke-Cli 'due' '--on-or-before' '2026-04-02' '--data-file' $dataFile
            Add-Assertion 'due-banner' (Test-BannerRendered $textDue 'assets/due.txt' '(?i)\b(Sooner|2026-04-01)\b') 'Text due report renders the exact registered banner once before expected results.'
            $before = Get-HashOrMissing $dataFile
            $bad = Invoke-Cli 'add' '--title' 'Bad date' '--due' '04/03/2026' '--data-file' $dataFile
            Add-Assertion 'due-invalid' ($bad.ExitCode -ne 0 -and (Get-HashOrMissing $dataFile) -eq $before) 'Invalid date leaves storage unchanged.'
        }
        'P07' {
            Write-Tasks @($seedTasks[0])
            $add = Invoke-Cli 'add' '--title' 'Tagged' '--tags' ' Work,URGENT,work ' '--data-file' $dataFile '--json'
            $added = $add.StdOut | ConvertFrom-Json
            Add-Assertion 'tags-normalize' ($add.ExitCode -eq 0 -and (@($added.tags) -join ',') -eq 'urgent,work') 'Add normalizes, sorts, and de-duplicates tags.'
            $change = Invoke-Cli 'tag' '--id' '1' '--add' 'work,home' '--data-file' $dataFile '--json'
            Add-Assertion 'tags-change' ($change.ExitCode -eq 0) 'Tag command updates a legacy task.'
            $textChange = Invoke-Cli 'tag' '--id' '1' '--remove' 'home' '--data-file' $dataFile
            Add-Assertion 'tags-banner' (Test-BannerRendered $textChange 'assets/tags.txt' '(?i)\b(tag|work|alpha)\w*\b') 'Text tag changes render the exact registered banner once before the expected result.'
            $filtered = Invoke-Cli 'list' '--tag' 'work,urgent' '--data-file' $dataFile '--json'
            $matches = @($filtered.StdOut | ConvertFrom-Json)
            Add-Assertion 'tags-and-filter' ($matches.Count -eq 1 -and $matches[0].title -eq 'Tagged') 'List tag filtering uses AND semantics.'
            $before = Get-HashOrMissing $dataFile
            $bad = Invoke-Cli 'tag' '--id' '1' '--add' 'bad tag!' '--data-file' $dataFile
            Add-Assertion 'tags-invalid' ($bad.ExitCode -ne 0 -and (Get-HashOrMissing $dataFile) -eq $before) 'Invalid tag leaves storage unchanged.'
        }
        'P08' {
            Write-Tasks $seedTasks
            $before = Get-HashOrMissing $dataFile
            $result = Invoke-Cli 'stats' '--data-file' $dataFile '--json'
            $stats = $result.StdOut | ConvertFrom-Json
            Add-Assertion 'stats-counts' ($result.ExitCode -eq 0 -and $stats.total -eq 3 -and $stats.pending -eq 2 -and $stats.completed -eq 1) 'Stats reports correct totals.'
            Add-Assertion 'stats-percentage' ([string]$stats.completionPercentage -eq '33.3') 'Completion percentage is one-decimal invariant.'
            Add-Assertion 'stats-dates' (@($stats.createdByDate).Count -eq 2 -and $stats.createdByDate[0].date -eq '2026-01-01') 'UTC date groups are ordered.'
            Add-Assertion 'stats-readonly' ((Get-HashOrMissing $dataFile) -eq $before) 'Stats does not rewrite storage.'
            $textStats = Invoke-Cli 'stats' '--data-file' $dataFile
            Add-Assertion 'stats-banner' (Test-BannerRendered $textStats 'assets/stats.txt' '(?i)\b(total|pending|completed|completion)\b') 'Text stats renders the exact registered banner once before its expected dashboard.'
            Write-Tasks @()
            $empty = (Invoke-Cli 'stats' '--data-file' $dataFile '--json').StdOut | ConvertFrom-Json
            Add-Assertion 'stats-empty' ($empty.total -eq 0 -and @($empty.createdByDate).Count -eq 0) 'Empty stats uses zeros and an empty date list.'
        }
        'P09' {
            Write-Tasks @($seedTasks[0])
            $original = Get-Content -LiteralPath $dataFile -Raw
            $add = Invoke-Cli 'add' '--title' 'Undo me' '--data-file' $dataFile '--json'
            $undoAdd = Invoke-Cli 'undo' '--data-file' $dataFile '--json'
            Add-Assertion 'undo-add' ($add.ExitCode -eq 0 -and $undoAdd.ExitCode -eq 0 -and (Get-Content -LiteralPath $dataFile -Raw) -eq $original) 'Undo restores exact pre-add storage across processes.'
            $consumed = Invoke-Cli 'undo' '--data-file' $dataFile
            Add-Assertion 'undo-consumed' ($consumed.ExitCode -ne 0) 'Successful undo consumes the record.'
            $complete = Invoke-Cli 'complete' '--id' '1' '--data-file' $dataFile
            $failed = Invoke-Cli 'remove' '--id' '99' '--data-file' $dataFile
            $undoComplete = Invoke-Cli 'undo' '--data-file' $dataFile '--json'
            Add-Assertion 'undo-failed-preserves' ($complete.ExitCode -eq 0 -and $failed.ExitCode -ne 0 -and $undoComplete.ExitCode -eq 0 -and (Read-Tasks)[0].status -eq 'pending') 'Failed mutation does not replace a valid undo record.'
            $remove = Invoke-Cli 'remove' '--id' '1' '--data-file' $dataFile
            $undoRemove = Invoke-Cli 'undo' '--data-file' $dataFile
            Add-Assertion 'undo-remove' ($remove.ExitCode -eq 0 -and $undoRemove.ExitCode -eq 0 -and (Read-Tasks).Count -eq 1) 'Undo restores a removed task.'
            Add-Assertion 'undo-banner' (Test-BannerRendered $undoRemove 'assets/undo.txt' '(?i)\b(undo|restore|task)\w*\b') 'Text undo renders the exact registered banner once before its expected result.'
        }
        'P10' {
            Write-Tasks @()
            $saveB = Invoke-Cli 'template' 'save' '--name' 'Weekly' '--title' 'Weekly review' '--description' 'Review work' '--data-file' $dataFile '--json'
            $saveA = Invoke-Cli 'template' 'save' '--name' 'alert' '--title' 'Alert' '--data-file' $dataFile '--json'
            Add-Assertion 'template-save' ($saveB.ExitCode -eq 0 -and $saveA.ExitCode -eq 0) 'Templates persist successfully.'
            $list = Invoke-Cli 'template' 'list' '--data-file' $dataFile '--json'
            $templates = @($list.StdOut | ConvertFrom-Json)
            Add-Assertion 'template-order' ($templates.Count -eq 2 -and $templates[0].name.ToLowerInvariant() -eq 'alert') 'Templates list alphabetically.'
            $textList = Invoke-Cli 'template' 'list' '--data-file' $dataFile
            Add-Assertion 'template-banner' (Test-BannerRendered $textList 'assets/template.txt' '(?i)\b(Weekly|alert)\b') 'Text template actions render the exact registered banner once before expected templates.'
            $add = Invoke-Cli 'add' '--template' 'WEEKLY' '--title' 'Override' '--data-file' $dataFile '--json'
            $task = $add.StdOut | ConvertFrom-Json
            Add-Assertion 'template-add' ($add.ExitCode -eq 0 -and $task.title -eq 'Override' -and $task.description -eq 'Review work') 'Template lookup is case-insensitive and explicit values override.'
            $taskHash = Get-HashOrMissing $dataFile
            $bad = Invoke-Cli 'add' '--template' 'missing' '--data-file' $dataFile
            Add-Assertion 'template-missing' ($bad.ExitCode -ne 0 -and (Get-HashOrMissing $dataFile) -eq $taskHash) 'Missing template leaves tasks unchanged.'
            $remove = Invoke-Cli 'template' 'remove' '--name' 'weekly' '--data-file' $dataFile '--json'
            Add-Assertion 'template-remove' ($remove.ExitCode -eq 0) 'Template removal is case-insensitive.'
        }
    }

    $result = [pscustomobject]@{
        protocolId = 'ascii-art-powershell-cli-v1'
        promptId = $CaseId
        status = if (@($assertions | Where-Object status -eq 'fail').Count -eq 0) { 'pass' } else { 'fail' }
        assertions = @($assertions)
    }
    $result | ConvertTo-Json -Depth 8
    if ($result.status -eq 'fail') {
        exit 1
    }
}
catch {
    $status = if ($acceptanceStarted -or
        $_.Exception -is [System.TimeoutException] -or
        $_.Exception -is [System.IO.FileNotFoundException]) { 'fail' } else { 'unavailable' }
    if ($status -eq 'fail' -and $_.Exception -isnot [System.TimeoutException]) {
        Add-Assertion 'acceptance-exception' $false $_.Exception.Message
    }
    [pscustomobject]@{
        protocolId = 'ascii-art-powershell-cli-v1'
        promptId = $CaseId
        status = $status
        error = $_.Exception.Message
        assertions = @($assertions)
    } | ConvertTo-Json -Depth 8
    exit 2
}
finally {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}
