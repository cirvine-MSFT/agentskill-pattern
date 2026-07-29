Set-StrictMode -Version Latest

function Stop-ProcessTreeById {
    param([Parameter(Mandatory)][int]$ProcessId)

    try {
        $target = [System.Diagnostics.Process]::GetProcessById($ProcessId)
    }
    catch [System.ArgumentException] {
        return
    }

    try {
        $target.Kill($true)
        if (-not $target.WaitForExit(5000)) {
            throw "Process tree rooted at PID $ProcessId did not exit after termination."
        }
    }
    catch [System.InvalidOperationException] {
        if (-not $target.HasExited) {
            throw
        }
    }
    finally {
        $target.Dispose()
    }
}

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
        Stop-ProcessTreeById -ProcessId $process.Id
    }

    [pscustomobject]@{
        ExitCode = if ($timedOut) { $null } else { $process.ExitCode }
        StdOut = $stdoutTask.GetAwaiter().GetResult().TrimEnd("`r", "`n")
        StdErr = $stderrTask.GetAwaiter().GetResult().TrimEnd("`r", "`n")
        TimedOut = $timedOut
    }
}

Export-ModuleMember -Function Invoke-BoundedProcess
