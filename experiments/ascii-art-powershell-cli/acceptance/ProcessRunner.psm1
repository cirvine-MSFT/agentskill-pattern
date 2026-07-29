Set-StrictMode -Version Latest

function Invoke-BoundedProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$FileName,
        [Parameter(Mandatory)][string[]]$ArgumentList,
        [Parameter(Mandatory)][ValidateRange(1, [int]::MaxValue)][int]$TimeoutMilliseconds
    )

    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $FileName
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($argument in $ArgumentList) {
        $info.ArgumentList.Add($argument)
    }

    $process = [System.Diagnostics.Process]::Start($info)
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $timedOut = -not $process.WaitForExit($TimeoutMilliseconds)
    if ($timedOut) {
        $process.Kill($true)
        $process.WaitForExit()
    }

    [pscustomobject]@{
        ExitCode = if ($timedOut) { $null } else { $process.ExitCode }
        StdOut = $stdoutTask.GetAwaiter().GetResult().TrimEnd("`r", "`n")
        StdErr = $stderrTask.GetAwaiter().GetResult().TrimEnd("`r", "`n")
        TimedOut = $timedOut
    }
}

Export-ModuleMember -Function Invoke-BoundedProcess
