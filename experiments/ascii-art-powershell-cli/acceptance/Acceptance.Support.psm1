Set-StrictMode -Version Latest

function Invoke-AcceptanceProcess {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Arguments,
        [Parameter(Mandatory)][int]$TimeoutMilliseconds
    )

    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = (Get-Command pwsh).Source
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.ArgumentList.Add('-NoProfile')
    $info.ArgumentList.Add('-File')
    $info.ArgumentList.Add($FilePath)
    foreach ($argument in $Arguments) {
        $info.ArgumentList.Add($argument)
    }

    $process = [System.Diagnostics.Process]::Start($info)
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $timedOut = -not $process.WaitForExit($TimeoutMilliseconds)
    if ($timedOut) {
        if (-not $process.HasExited) {
            $process.Kill($true)
        }
        $process.WaitForExit()
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult().TrimEnd("`r", "`n")
    $stderr = $stderrTask.GetAwaiter().GetResult().TrimEnd("`r", "`n")
    if ($timedOut) {
        $stderr = @($stderr, "Acceptance process timed out after $TimeoutMilliseconds ms.") |
            Where-Object { $_ } |
            Join-String -Separator "`n"
    }
    [pscustomobject]@{
        ExitCode = if ($timedOut) { 124 } else { $process.ExitCode }
        StdOut = $stdout
        StdErr = $stderr
        TimedOut = $timedOut
    }
}

function Test-AcceptanceBanner {
    param(
        [Parameter(Mandatory)]$Result,
        [Parameter(Mandatory)][string]$AssetPath
    )

    if ($Result.ExitCode -ne 0 -or $Result.TimedOut -or -not (Test-Path -LiteralPath $AssetPath)) {
        return $false
    }
    $bannerLines = @((Get-Content -LiteralPath $AssetPath))
    $outputLines = @($Result.StdOut -split "`r?`n")
    if ($bannerLines.Count -eq 0 -or $outputLines.Count -lt $bannerLines.Count) {
        return $false
    }
    for ($start = 0; $start -le $outputLines.Count - $bannerLines.Count; $start++) {
        $matches = $true
        for ($offset = 0; $offset -lt $bannerLines.Count; $offset++) {
            if ($outputLines[$start + $offset] -cne $bannerLines[$offset]) {
                $matches = $false
                break
            }
        }
        if ($matches) {
            return $true
        }
    }
    return $false
}

function Test-ExactIntegerArray {
    param(
        [AllowNull()][object]$Actual,
        [Parameter(Mandatory)][AllowEmptyCollection()][int[]]$Expected
    )
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

Export-ModuleMember -Function Invoke-AcceptanceProcess, Test-AcceptanceBanner, Test-ExactIntegerArray
