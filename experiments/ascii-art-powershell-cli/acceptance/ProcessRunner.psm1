Set-StrictMode -Version Latest

if ($IsWindows -and -not ('BenchmarkProcessJob' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

public sealed class BenchmarkProcessJob : IDisposable
{
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private IntPtr handle;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public BenchmarkProcessJob()
    {
        handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error());

        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int length = Marshal.SizeOf(limits);
        IntPtr pointer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(limits, pointer, false);
            if (!SetInformationJobObject(handle, 9, pointer, (uint)length))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    public void Assign(Process process)
    {
        if (!AssignProcessToJobObject(handle, process.Handle))
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    public void Terminate()
    {
        if (handle != IntPtr.Zero && !TerminateJobObject(handle, 1))
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    public void Dispose()
    {
        if (handle == IntPtr.Zero)
            return;
        CloseHandle(handle);
        handle = IntPtr.Zero;
    }
}
'@
}

function Invoke-BoundedProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$FileName,
        [Parameter(Mandatory)][string[]]$ArgumentList,
        [Parameter(Mandatory)][ValidateRange(1, [int]::MaxValue)][int]$TimeoutMilliseconds
    )

    if (-not $IsWindows) {
        throw [System.PlatformNotSupportedException]::new(
            'The normative acceptance runner requires Windows job-object process-tree isolation.'
        )
    }

    $gateDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) '.scratch/process-gates'
    New-Item -ItemType Directory -Path $gateDirectory -Force | Out-Null
    $gatePath = Join-Path $gateDirectory "$([guid]::NewGuid()).gate"
    $payload = [pscustomobject]@{
        file = $FileName
        arguments = @($ArgumentList)
    } | ConvertTo-Json -Depth 4 -Compress
    $payloadBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($payload))
    $wrapper = @'
$payloadJson = [System.Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String($env:BENCHMARK_PROCESS_PAYLOAD)
)
$payload = $payloadJson | ConvertFrom-Json
while (-not (Test-Path -LiteralPath $env:BENCHMARK_PROCESS_GATE)) {
    Start-Sleep -Milliseconds 10
}
& ([string]$payload.file) @($payload.arguments)
exit $LASTEXITCODE
'@

    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = (Get-Command pwsh).Source
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.Environment['BENCHMARK_PROCESS_GATE'] = $gatePath
    $info.Environment['BENCHMARK_PROCESS_PAYLOAD'] = $payloadBase64
    foreach ($argument in @('-NoProfile', '-NonInteractive', '-Command', $wrapper)) {
        $info.ArgumentList.Add($argument)
    }

    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $process = $null
    $job = $null
    try {
        $job = [BenchmarkProcessJob]::new()
        $process = [System.Diagnostics.Process]::Start($info)
        $job.Assign($process)
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        [System.IO.File]::WriteAllText($gatePath, '')
        $remaining = [Math]::Max(0, $TimeoutMilliseconds - [int]$stopwatch.ElapsedMilliseconds)
        $rootExited = $remaining -gt 0 -and $process.WaitForExit($remaining)

        if ($null -ne $job) {
            $job.Terminate()
        }
        elseif (-not $process.HasExited) {
            $process.Kill($true)
        }

        $remaining = [Math]::Max(0, $TimeoutMilliseconds - [int]$stopwatch.ElapsedMilliseconds)
        $streamsCompleted = $remaining -gt 0 -and [System.Threading.Tasks.Task]::WaitAll(
            [System.Threading.Tasks.Task[]]@($stdoutTask, $stderrTask),
            $remaining
        )
        $timedOut = -not $rootExited -or -not $streamsCompleted

        [pscustomobject]@{
            ExitCode = if ($timedOut) { $null } else { $process.ExitCode }
            StdOut = if ($stdoutTask.IsCompletedSuccessfully) { $stdoutTask.Result.TrimEnd("`r", "`n") } else { '' }
            StdErr = if ($stderrTask.IsCompletedSuccessfully) { $stderrTask.Result.TrimEnd("`r", "`n") } else { '' }
            TimedOut = $timedOut
        }
    }
    finally {
        Remove-Item -LiteralPath $gatePath -Force -ErrorAction SilentlyContinue
        if ($null -ne $job) {
            $job.Dispose()
        }
        if ($null -ne $process) {
            if (-not $process.HasExited) {
                $process.Kill($true)
                $process.WaitForExit()
            }
            $process.Dispose()
        }
    }
}

Export-ModuleMember -Function Invoke-BoundedProcess
