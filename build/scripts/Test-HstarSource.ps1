[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$engineeringPython = Join-Path $repoRoot 'python\python.exe'
$openShopRoot = Join-Path $repoRoot 'integrations\openshop'
$directorRoot = Join-Path $repoRoot 'integrations\storyai-3d-director-desk'
$desktopTests = Join-Path $repoRoot 'desktop\Hstar.Desktop.Tests\Hstar.Desktop.Tests.csproj'
$generatedRoot = Join-Path $repoRoot 'tmp\windows11-source-gate'

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    Write-Host "> $Command $($Arguments -join ' ')"
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $Command $($Arguments -join ' ')"
    }
}

function Assert-SafeGeneratedPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedParent
    )

    $resolved = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $parent = [IO.Path]::GetFullPath($ExpectedParent).TrimEnd('\')
    if (-not $resolved.StartsWith($parent + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Generated path escaped its approved parent: $resolved"
    }
}

function Get-FreeLoopbackPort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    }
    finally {
        $listener.Stop()
    }
    if ($port -in 3000, 5000) {
        return Get-FreeLoopbackPort
    }
    return $port
}

function Wait-HstarHealth {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)][TimeSpan]$Timeout
    )

    $deadline = [DateTime]::UtcNow.Add($Timeout)
    $uri = "http://127.0.0.1:$Port/api/health"
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($Process.HasExited) {
            throw "Isolated Hstar source-gate server exited with code $($Process.ExitCode)."
        }
        try {
            $response = Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) {
                return
            }
        }
        catch {
        }
        Start-Sleep -Milliseconds 200
    }
    throw "Isolated Hstar source-gate server did not become healthy on port $Port."
}

Set-Location $repoRoot

Invoke-Native -Command 'node' -Arguments @('tools/audit-text-encoding.mjs')
Invoke-Native -Command $engineeringPython -Arguments @('-X', 'utf8', '-m', 'unittest', 'discover', '-s', 'tests', '-v')

$nodeTests = Get-ChildItem -LiteralPath (Join-Path $repoRoot 'tools\tests') -Filter '*.test.mjs' -File |
    Sort-Object -Property Name
foreach ($test in $nodeTests) {
    Invoke-Native -Command 'node' -Arguments @('--test', $test.FullName)
}

Invoke-Native -Command 'npm.cmd' -Arguments @('test', '--prefix', $openShopRoot)
Invoke-Native -Command 'npm.cmd' -Arguments @('run', 'build:hstar', '--prefix', $openShopRoot)
Invoke-Native -Command 'npm.cmd' -Arguments @('test', '--prefix', $directorRoot)
Invoke-Native -Command 'npm.cmd' -Arguments @('run', 'build', '--prefix', $directorRoot)
Invoke-Native -Command 'dotnet' -Arguments @('test', $desktopTests, '-c', 'Release')

$smokeRoot = Join-Path $generatedRoot ("run-{0}" -f [Guid]::NewGuid().ToString('N'))
Assert-SafeGeneratedPath -Path $smokeRoot -ExpectedParent $generatedRoot
New-Item -ItemType Directory -Path $smokeRoot -Force | Out-Null
$port = Get-FreeLoopbackPort
$server = $null
$savedEnvironment = @{}
$environmentNames = @(
    'HSTAR_PROGRAM_DIR',
    'HSTAR_DATA_DIR',
    'HSTAR_EDITION',
    'HSTAR_HOST',
    'HSTAR_PORT',
    'HSTAR_BASE_URL',
    'HSTAR_DISABLE_AUTO_UPDATE',
    'PYTHONUTF8',
    'PYTHONIOENCODING'
)
foreach ($name in $environmentNames) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

try {
    $env:HSTAR_PROGRAM_DIR = $repoRoot
    $env:HSTAR_DATA_DIR = $smokeRoot
    $env:HSTAR_EDITION = 'development'
    $env:HSTAR_HOST = '127.0.0.1'
    $env:HSTAR_PORT = [string]$port
    $env:HSTAR_BASE_URL = "http://127.0.0.1:$port"
    $env:HSTAR_DISABLE_AUTO_UPDATE = '1'
    $env:PYTHONUTF8 = '1'
    $env:PYTHONIOENCODING = 'utf-8'

    $server = Start-Process `
        -FilePath $engineeringPython `
        -ArgumentList @('-X', 'utf8', 'main.py') `
        -WorkingDirectory $repoRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $smokeRoot 'source-gate.stdout.log') `
        -RedirectStandardError (Join-Path $smokeRoot 'source-gate.stderr.log') `
        -PassThru
    Wait-HstarHealth -Port $port -Process $server -Timeout ([TimeSpan]::FromSeconds(45))
    Invoke-Native -Command 'npm.cmd' -Arguments @(
        'run',
        'test:hstar:canvas-integration',
        '--prefix',
        $openShopRoot
    )
}
catch {
    foreach ($logName in @('source-gate.stdout.log', 'source-gate.stderr.log')) {
        $logPath = Join-Path $smokeRoot $logName
        if (Test-Path -LiteralPath $logPath -PathType Leaf) {
            Write-Host "--- $logName ---"
            Get-Content -LiteralPath $logPath -Encoding UTF8 -Tail 100
        }
    }
    throw
}
finally {
    if ($server -and -not $server.HasExited) {
        Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
        $server.WaitForExit(10000) | Out-Null
    }
    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
    Assert-SafeGeneratedPath -Path $smokeRoot -ExpectedParent $generatedRoot
    if (Test-Path -LiteralPath $smokeRoot) {
        Remove-Item -LiteralPath $smokeRoot -Recurse -Force
    }
}

Invoke-Native -Command $engineeringPython -Arguments @('-X', 'utf8', '-m', 'compileall', '-q', 'main.py', 'hstar_runtime', 'voice_assistant')
Invoke-Native -Command 'git' -Arguments @('diff', '--check')
Write-Host 'Hstar source release gate passed.'
