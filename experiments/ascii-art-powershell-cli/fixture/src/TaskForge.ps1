[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Command = 'help',

    [Parameter(Position = 1, ValueFromRemainingArguments)]
    [string[]]$CliArguments = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'TaskForge.Core.psm1') -Force -WarningAction SilentlyContinue

try {
    $options = ConvertFrom-TaskForgeArguments -Arguments $CliArguments
    $defaultDataFile = Join-Path (Split-Path -Parent $PSScriptRoot) 'data/tasks.json'
    $dataFile = if ($options.Contains('data-file')) {
        Get-RequiredOption -Options $options -Name 'data-file'
    }
    else {
        $defaultDataFile
    }
    $asJson = $options.Contains('json')

    switch ($Command.ToLowerInvariant()) {
        'add' {
            Assert-KnownOptions -Options $options -Allowed @('title', 'description', 'data-file', 'json')
            $title = Get-RequiredOption -Options $options -Name 'title'
            $tasks = @(Read-TaskStore -Path $dataFile)
            $nextId = if ($tasks.Count -eq 0) { 1 } else { 1 + [int](($tasks | Measure-Object -Property id -Maximum).Maximum) }
            $task = [ordered]@{
                id = $nextId
                title = $title.Trim()
                description = if ($options.Contains('description')) { [string]$options['description'] } else { '' }
                status = 'pending'
                createdAt = [DateTimeOffset]::UtcNow.ToString('o')
            }
            Write-TaskStore -Path $dataFile -Tasks @($tasks + [pscustomobject]$task)
            if ($asJson) {
                Write-TaskForgeOutput -Value ([pscustomobject]$task) -AsJson $true
            }
            else {
                "Added task ${nextId}: $($task.title)"
            }
        }
        'list' {
            Assert-KnownOptions -Options $options -Allowed @('data-file', 'json')
            $tasks = @(Read-TaskStore -Path $dataFile | Sort-Object { [int]$_.id })
            if ($asJson) {
                Write-TaskForgeOutput -Value $tasks -AsJson $true
            }
            elseif ($tasks.Count -eq 0) {
                'No tasks.'
            }
            else {
                $tasks | ForEach-Object { "[{0}] #{1} {2}" -f $_.status, $_.id, $_.title }
            }
        }
        'complete' {
            Assert-KnownOptions -Options $options -Allowed @('id', 'data-file', 'json')
            $idText = Get-RequiredOption -Options $options -Name 'id'
            $id = 0
            if (-not [int]::TryParse($idText, [ref]$id) -or $id -le 0) {
                throw '--id must be a positive integer.'
            }
            $tasks = @(Read-TaskStore -Path $dataFile)
            $task = $tasks | Where-Object { [int]$_.id -eq $id } | Select-Object -First 1
            if ($null -eq $task) {
                throw "Task $id was not found."
            }
            $task.status = 'completed'
            Write-TaskStore -Path $dataFile -Tasks $tasks
            if ($asJson) {
                Write-TaskForgeOutput -Value $task -AsJson $true
            }
            else {
                "Completed task $id."
            }
        }
        'remove' {
            Assert-KnownOptions -Options $options -Allowed @('id', 'data-file', 'json')
            $idText = Get-RequiredOption -Options $options -Name 'id'
            $id = 0
            if (-not [int]::TryParse($idText, [ref]$id) -or $id -le 0) {
                throw '--id must be a positive integer.'
            }
            $tasks = @(Read-TaskStore -Path $dataFile)
            $remaining = @($tasks | Where-Object { [int]$_.id -ne $id })
            if ($remaining.Count -eq $tasks.Count) {
                throw "Task $id was not found."
            }
            Write-TaskStore -Path $dataFile -Tasks $remaining
            $summary = [pscustomobject]@{ removedId = $id }
            if ($asJson) {
                Write-TaskForgeOutput -Value $summary -AsJson $true
            }
            else {
                "Removed task $id."
            }
        }
        'help' {
            Assert-KnownOptions -Options $options -Allowed @()
            @'
TaskForge
  add --title TEXT [--description TEXT] [--data-file PATH] [--json]
  list [--data-file PATH] [--json]
  complete --id ID [--data-file PATH] [--json]
  remove --id ID [--data-file PATH] [--json]
'@
        }
        default {
            throw "Unknown command: $Command"
        }
    }
}
catch {
    [Console]::Error.WriteLine("TaskForge: $($_.Exception.Message)")
    exit 1
}
