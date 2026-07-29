Set-StrictMode -Version Latest

function Read-TaskStore {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return @()
    }

    $content = Get-Content -LiteralPath $Path -Raw
    if ([string]::IsNullOrWhiteSpace($content)) {
        return @()
    }

    $parsed = ConvertFrom-Json -InputObject $content
    return @($parsed)
}

function Write-TaskStore {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Tasks
    )

    $parent = Split-Path -Parent $Path
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }

    $temporary = "$Path.$PID.tmp"
    $json = ConvertTo-Json -InputObject @($Tasks) -Depth 8
    [System.IO.File]::WriteAllText($temporary, "$json`n", [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function ConvertFrom-TaskForgeArguments {
    param([AllowEmptyCollection()][string[]]$Arguments)

    $options = [ordered]@{}
    for ($index = 0; $index -lt $Arguments.Count; $index++) {
        $token = $Arguments[$index]
        if (-not $token.StartsWith('--')) {
            throw "Unexpected argument: $token"
        }

        $name = $token.Substring(2)
        if ([string]::IsNullOrWhiteSpace($name)) {
            throw 'Option name cannot be empty.'
        }
        if ($options.Contains($name)) {
            throw "Duplicate option: --$name"
        }

        if (($index + 1) -lt $Arguments.Count -and -not $Arguments[$index + 1].StartsWith('--')) {
            $options[$name] = $Arguments[++$index]
        }
        else {
            $options[$name] = $true
        }
    }

    return $options
}

function Get-RequiredOption {
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Options,
        [Parameter(Mandatory)][string]$Name
    )

    if (-not $Options.Contains($Name) -or $Options[$Name] -is [bool] -or
        [string]::IsNullOrWhiteSpace([string]$Options[$Name])) {
        throw "Missing required option: --$Name"
    }
    return [string]$Options[$Name]
}

function Assert-KnownOptions {
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Options,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Allowed
    )

    foreach ($name in $Options.Keys) {
        if ($name -notin $Allowed) {
            throw "Unknown option: --$name"
        }
    }
}

function Write-TaskForgeOutput {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][bool]$AsJson
    )

    if ($AsJson) {
        ConvertTo-Json -InputObject $Value -Depth 8 -Compress
    }
    else {
        [string]$Value
    }
}

Export-ModuleMember -Function *
