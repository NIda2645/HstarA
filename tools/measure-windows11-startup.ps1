[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [Parameter(Mandatory = $true)][string]$AppDataRoot,
    [Parameter(Mandatory = $true)][string]$ApprovedTempRoot,
    [ValidateRange(1, 20)][int]$ColdRuns = 5,
    [ValidateRange(1, 20)][int]$WarmRuns = 5,
    [ValidateRange(1024, 65535)][int]$PortStart = 55100,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [ValidateRange(10, 180)][int]$StartupTimeoutSeconds = 90
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Get-NormalizedPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\', '/'))
}

function IsSameOrDescendant {
    param(
        [Parameter(Mandatory = $true)][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$Parent
    )
    $normalizedCandidate = Get-NormalizedPath -Path $Candidate
    $normalizedParent = Get-NormalizedPath -Path $Parent
    if ([string]::Equals($normalizedCandidate, $normalizedParent, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    return $normalizedCandidate.StartsWith(
        $normalizedParent + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase)
}

function Assert-ContainedPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ApprovedRoot,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if (-not (IsSameOrDescendant -Candidate $Path -Parent $ApprovedRoot)) {
        throw "$Label must remain inside the approved temporary root: $ApprovedRoot"
    }
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )
    $parent = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $temporary = "$Path.tmp-$([Guid]::NewGuid().ToString('N'))"
    try {
        [IO.File]::WriteAllText($temporary, $Content, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    }
    finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

function Initialize-ValidationProfile {
    param(
        [Parameter(Mandatory = $true)][string]$ProfileAppData,
        [Parameter(Mandatory = $true)][string]$ProfileData
    )
    New-Item -ItemType Directory -Path $ProfileAppData, $ProfileData -Force | Out-Null
    $bootstrap = [ordered]@{
        schemaVersion = 1
        edition = 'windows11'
        dataRoot = $ProfileData
        lastStartedVersion = ''
        migration = [ordered]@{
            id = ''
            status = ''
            previousDataRoot = ''
        }
    }
    $bootstrapPath = Join-Path $ProfileAppData 'Hstar\windows11\bootstrap.json'
    Write-Utf8NoBom -Path $bootstrapPath -Content (($bootstrap | ConvertTo-Json -Depth 5) + "`n")
}

function Get-DescendantProcesses {
    param([Parameter(Mandatory = $true)][int]$RootProcessId)
    $allProcesses = @(Get-CimInstance -ClassName Win32_Process)
    $knownIds = New-Object 'System.Collections.Generic.HashSet[int]'
    [void]$knownIds.Add($RootProcessId)
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($process in $allProcesses) {
            if ($knownIds.Contains([int]$process.ParentProcessId) -and
                $knownIds.Add([int]$process.ProcessId)) {
                $changed = $true
            }
        }
    }
    return @($allProcesses | Where-Object {
        $_.ProcessId -ne $RootProcessId -and $knownIds.Contains([int]$_.ProcessId)
    })
}

function Wait-ForProcessExit {
    param(
        [Parameter(Mandatory = $true)][int[]]$ProcessIds,
        [Parameter(Mandatory = $true)][TimeSpan]$Timeout
    )
    $deadline = [DateTimeOffset]::UtcNow + $Timeout
    do {
        $remaining = @($ProcessIds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
        if ($remaining.Count -eq 0) {
            return $true
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    return $false
}

function Get-Median {
    param([Parameter(Mandatory = $true)][double[]]$Values)
    $ordered = @($Values | Sort-Object)
    if ($ordered.Count -eq 0) {
        return $null
    }
    $middle = [math]::Floor($ordered.Count / 2)
    if ($ordered.Count % 2 -eq 1) {
        return [math]::Round($ordered[$middle], 2)
    }
    return [math]::Round(($ordered[$middle - 1] + $ordered[$middle]) / 2, 2)
}

function Invoke-StartupRun {
    param(
        [Parameter(Mandatory = $true)][string]$Kind,
        [Parameter(Mandatory = $true)][int]$Index,
        [Parameter(Mandatory = $true)][string]$ProfileAppData,
        [Parameter(Mandatory = $true)][string]$ProfileData,
        [Parameter(Mandatory = $true)][int]$Port
    )

    if ($Port -eq 5000) {
        throw 'Validation must never use the production port 5000.'
    }
    Initialize-ValidationProfile -ProfileAppData $ProfileAppData -ProfileData $ProfileData
    $readyFile = Join-Path $ProfileAppData ("markers\{0}-{1:00}.json" -f $Kind, $Index)
    Remove-Item -LiteralPath $readyFile -Force -ErrorAction SilentlyContinue
    $arguments = @(
        ('"--validation-appdata-root={0}"' -f $ProfileAppData),
        ('"--validation-port={0}"' -f $Port),
        ('"--validation-ready-file={0}"' -f $readyFile)
    )

    $startUtc = [DateTimeOffset]::UtcNow
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    $shell = $null
    $descendants = @()
    $backendProcessIds = @()
    $windowMilliseconds = $null
    $backendHealthyMilliseconds = $null
    $interactiveMilliseconds = $null
    $consoleProcesses = @()
    $heavyProcesses = @()
    $peakWorkingSetBytes = 0L
    $forcedCleanup = $false
    $cleanupPassed = $false
    $errorMessage = ''

    try {
        $shell = Start-Process `
            -FilePath $script:HstarExecutable `
            -ArgumentList $arguments `
            -WorkingDirectory $script:InstallRoot `
            -PassThru
        $deadline = [DateTimeOffset]::UtcNow.AddSeconds($StartupTimeoutSeconds)
        while ([DateTimeOffset]::UtcNow -lt $deadline) {
            $shell.Refresh()
            if ($shell.HasExited) {
                throw "Hstar exited before startup completed with code $($shell.ExitCode)."
            }
            if ($null -eq $windowMilliseconds -and $shell.MainWindowHandle -ne [IntPtr]::Zero) {
                $windowMilliseconds = [math]::Round($stopwatch.Elapsed.TotalMilliseconds, 2)
            }
            if (Test-Path -LiteralPath $readyFile -PathType Leaf) {
                try {
                    $marker = Get-Content -LiteralPath $readyFile -Raw -Encoding UTF8 | ConvertFrom-Json
                    if ($null -eq $backendHealthyMilliseconds -and $marker.backendHealthyUtc) {
                        $backendHealthy = [DateTimeOffset]::Parse([string]$marker.backendHealthyUtc)
                        $backendHealthyMilliseconds = [math]::Round(($backendHealthy - $startUtc).TotalMilliseconds, 2)
                    }
                    if ($null -eq $interactiveMilliseconds -and $marker.readyUtc) {
                        $interactive = [DateTimeOffset]::Parse([string]$marker.readyUtc)
                        $interactiveMilliseconds = [math]::Round(($interactive - $startUtc).TotalMilliseconds, 2)
                    }
                }
                catch [System.Management.Automation.RuntimeException] {
                }
            }
            if ($null -ne $windowMilliseconds -and
                $null -ne $backendHealthyMilliseconds -and
                $null -ne $interactiveMilliseconds) {
                break
            }
            Start-Sleep -Milliseconds 50
        }
        if ($null -eq $windowMilliseconds -or
            $null -eq $backendHealthyMilliseconds -or
            $null -eq $interactiveMilliseconds) {
            throw "Hstar did not reach all startup milestones within $StartupTimeoutSeconds seconds."
        }

        $descendants = @(Get-DescendantProcesses -RootProcessId $shell.Id)
        $backendProcessIds = @($descendants | Where-Object {
            $_.Name -ieq 'pythonw.exe'
        } | ForEach-Object { [int]$_.ProcessId })
        $consoleProcesses = @($descendants | Where-Object {
            $_.Name -in @('cmd.exe', 'powershell.exe', 'pwsh.exe', 'python.exe', 'conhost.exe')
        } | ForEach-Object { "{0}:{1}" -f $_.Name, $_.ProcessId })
        $heavyProcesses = @($descendants | Where-Object {
            ("$($_.Name) $($_.CommandLine)") -match '(?i)Fun-ASR|modelscope|voice[_-]assistant|openshop|director'
        } | ForEach-Object { "{0}:{1}" -f $_.Name, $_.ProcessId })
        $processIds = @($shell.Id) + @($descendants | ForEach-Object { [int]$_.ProcessId })
        $peakWorkingSetBytes = [long](($processIds | ForEach-Object {
            $process = Get-Process -Id $_ -ErrorAction SilentlyContinue
            if ($process) { [long]$process.WorkingSet64 } else { 0L }
        } | Measure-Object -Sum).Sum)
    }
    catch {
        $errorMessage = $_.Exception.Message
    }
    finally {
        if ($shell) {
            if (-not $shell.HasExited) {
                try {
                    $maintenance = Start-Process `
                        -FilePath $script:HstarExecutable `
                        -ArgumentList '--maintenance=shutdown' `
                        -WorkingDirectory $script:InstallRoot `
                        -WindowStyle Hidden `
                        -PassThru `
                        -Wait
                    if ($maintenance.ExitCode -ne 0 -and -not $errorMessage) {
                        $errorMessage = "Maintenance shutdown returned $($maintenance.ExitCode)."
                    }
                }
                catch {
                    if (-not $errorMessage) {
                        $errorMessage = $_.Exception.Message
                    }
                }
            }
            if (-not $shell.WaitForExit(15000)) {
                $forcedCleanup = $true
                $shell.Kill()
                $shell.WaitForExit(5000)
            }
            if ($backendProcessIds.Count -eq 0) {
                $descendants = @(Get-DescendantProcesses -RootProcessId $shell.Id)
                $backendProcessIds = @($descendants | Where-Object {
                    $_.Name -ieq 'pythonw.exe'
                } | ForEach-Object { [int]$_.ProcessId })
            }
            $cleanupPassed = Wait-ForProcessExit `
                -ProcessIds $backendProcessIds `
                -Timeout ([TimeSpan]::FromSeconds(10))
            if (-not $cleanupPassed) {
                $forcedCleanup = $true
                foreach ($processId in $backendProcessIds) {
                    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
                    if ($process) {
                        $process.Kill()
                        $process.WaitForExit(5000)
                    }
                }
            }
            $shell.Dispose()
        }
    }

    $stopwatch.Stop()
    $passed = [string]::IsNullOrWhiteSpace($errorMessage) -and `
        $consoleProcesses.Count -eq 0 -and `
        $heavyProcesses.Count -eq 0 -and `
        $cleanupPassed -and `
        -not $forcedCleanup
    return [pscustomobject][ordered]@{
        kind = $Kind
        index = $Index
        port = $Port
        shellWindowMs = $windowMilliseconds
        backendHealthyMs = $backendHealthyMilliseconds
        interactiveMs = $interactiveMilliseconds
        peakWorkingSetBytes = $peakWorkingSetBytes
        backendProcessIds = $backendProcessIds
        consoleProcesses = $consoleProcesses
        heavyweightProcesses = $heavyProcesses
        cleanupPassed = $cleanupPassed
        forcedCleanup = $forcedCleanup
        passed = $passed
        error = $errorMessage
    }
}

$script:ApprovedTempRoot = Get-NormalizedPath -Path $ApprovedTempRoot
$script:InstallRoot = Get-NormalizedPath -Path $InstallRoot
$script:DataRoot = Get-NormalizedPath -Path $DataRoot
$script:AppDataRoot = Get-NormalizedPath -Path $AppDataRoot
$script:OutputPath = [IO.Path]::GetFullPath($OutputPath)
foreach ($entry in @(
    @{ Path = $script:InstallRoot; Label = 'InstallRoot' },
    @{ Path = $script:DataRoot; Label = 'DataRoot' },
    @{ Path = $script:AppDataRoot; Label = 'AppDataRoot' },
    @{ Path = $script:OutputPath; Label = 'OutputPath' }
)) {
    Assert-ContainedPath -Path $entry.Path -ApprovedRoot $script:ApprovedTempRoot -Label $entry.Label
}
if (IsSameOrDescendant -Candidate $script:DataRoot -Parent $script:InstallRoot) {
    throw 'DataRoot must remain outside InstallRoot.'
}
if (($PortStart + $ColdRuns + $WarmRuns - 1) -gt 65535) {
    throw 'The requested validation port range exceeds 65535.'
}
if ($PortStart -le 5000 -and ($PortStart + $ColdRuns + $WarmRuns - 1) -ge 5000) {
    throw 'The requested validation port range includes production port 5000.'
}
$script:HstarExecutable = Join-Path $script:InstallRoot 'Hstar.exe'
if (-not (Test-Path -LiteralPath $script:HstarExecutable -PathType Leaf)) {
    throw "Installed Hstar executable was not found: $script:HstarExecutable"
}

$seriesId = "{0}-{1}" -f ([DateTimeOffset]::UtcNow.ToString('yyyyMMddHHmmss')), ([Guid]::NewGuid().ToString('N'))
$results = @()
for ($index = 1; $index -le $ColdRuns; $index++) {
    $results += Invoke-StartupRun `
        -Kind 'cold' `
        -Index $index `
        -ProfileAppData (Join-Path $script:AppDataRoot "$seriesId\cold-$index") `
        -ProfileData (Join-Path $script:DataRoot "$seriesId\cold-$index") `
        -Port ($PortStart + $index - 1)
}
$warmAppData = Join-Path $script:AppDataRoot "$seriesId\warm"
$warmData = Join-Path $script:DataRoot "$seriesId\warm"
for ($index = 1; $index -le $WarmRuns; $index++) {
    $results += Invoke-StartupRun `
        -Kind 'warm' `
        -Index $index `
        -ProfileAppData $warmAppData `
        -ProfileData $warmData `
        -Port ($PortStart + $ColdRuns + $index - 1)
}

$coldInteractive = @($results | Where-Object { $_.kind -eq 'cold' -and $null -ne $_.interactiveMs } | ForEach-Object { [double]$_.interactiveMs })
$warmInteractive = @($results | Where-Object { $_.kind -eq 'warm' -and $null -ne $_.interactiveMs } | ForEach-Object { [double]$_.interactiveMs })
$coldMedian = Get-Median -Values $coldInteractive
$warmMedian = Get-Median -Values $warmInteractive
$allRunsPassed = @($results | Where-Object { -not $_.passed }).Count -eq 0
$acceptancePassed = $allRunsPassed -and `
    $coldInteractive.Count -eq $ColdRuns -and `
    $warmInteractive.Count -eq $WarmRuns -and `
    $coldMedian -le 5000 -and `
    $warmMedian -le 3000
$report = [ordered]@{
    schemaVersion = 1
    createdUtc = [DateTimeOffset]::UtcNow.ToString('o')
    installRoot = $script:InstallRoot
    dataRoot = $script:DataRoot
    appDataRoot = $script:AppDataRoot
    approvedTempRoot = $script:ApprovedTempRoot
    coldRuns = $ColdRuns
    warmRuns = $WarmRuns
    coldMedianInteractiveMs = $coldMedian
    warmMedianInteractiveMs = $warmMedian
    coldAcceptanceMs = 5000
    warmAcceptanceMs = 3000
    acceptancePassed = $acceptancePassed
    results = $results
}
Write-Utf8NoBom -Path $script:OutputPath -Content (($report | ConvertTo-Json -Depth 8) + "`n")
Write-Host ("Cold median interactive readiness: {0} ms" -f $coldMedian)
Write-Host ("Warm median interactive readiness: {0} ms" -f $warmMedian)
Write-Host ("Startup acceptance passed: {0}" -f $acceptancePassed)
Write-Host "Report: $script:OutputPath"
if (-not $acceptancePassed) {
    exit 1
}
