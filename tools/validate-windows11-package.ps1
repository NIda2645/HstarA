[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [ValidateRange(1024, 65535)][int]$Port = 55500,
    [string]$OutputPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Get-NormalizedPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\', '/'))
}

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    Write-Host "> $Command $($Arguments -join ' ')"
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $Command"
    }
}

function Invoke-Utf8JsonGet {
    param([Parameter(Mandatory = $true)][string]$Uri)

    $client = [Net.WebClient]::new()
    try {
        $bytes = $client.DownloadData($Uri)
        $json = [Text.Encoding]::UTF8.GetString($bytes)
        return $json | ConvertFrom-Json
    }
    finally {
        $client.Dispose()
    }
}

function Invoke-Utf8JsonPost {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][hashtable]$Data
    )

    $client = [Net.WebClient]::new()
    try {
        $client.Headers.Add('Content-Type', 'application/json; charset=utf-8')
        $requestJson = $Data | ConvertTo-Json -Depth 5 -Compress
        $requestBytes = [Text.Encoding]::UTF8.GetBytes($requestJson)
        $responseBytes = $client.UploadData($Uri, 'POST', $requestBytes)
        $responseJson = [Text.Encoding]::UTF8.GetString($responseBytes)
        return $responseJson | ConvertFrom-Json
    }
    finally {
        $client.Dispose()
    }
}

function Request-StorageRootSwitch {
    param(
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [Parameter(Mandatory = $true)][string]$StorageRoot
    )

    $started = Invoke-Utf8JsonPost -Uri "$BaseUrl/api/storage-migrations" -Data @{
        storage_root = $StorageRoot
    }
    $taskId = [string]$started.task.id
    if ([string]::IsNullOrWhiteSpace($taskId)) {
        throw 'Storage-root switch did not return a task identifier.'
    }

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
    do {
        $status = Invoke-Utf8JsonGet -Uri "$BaseUrl/api/storage-migrations/$([Uri]::EscapeDataString($taskId))"
        if ($status.task.status -eq 'completed') {
            if (-not $status.task.restart_required) {
                throw 'Completed storage-root switch did not request a restart.'
            }
            return
        }
        if ($status.task.status -eq 'failed') {
            throw "Storage-root switch failed: $($status.task.error)"
        }
        Start-Sleep -Milliseconds 200
    } while ([DateTimeOffset]::UtcNow -lt $deadline)

    throw 'Timed out waiting for storage-root switch completion.'
}

function Wait-ForBackend {
    param(
        [Parameter(Mandatory = $true)][Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)][string]$BaseUrl
    )
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(60)
    do {
        $Process.Refresh()
        if ($Process.HasExited) {
            throw "Packaged backend exited before health readiness with code $($Process.ExitCode)."
        }
        try {
            $health = Invoke-RestMethod -Uri "$BaseUrl/api/health" -TimeoutSec 2
            if ($health.ok) {
                return
            }
        }
        catch [System.Net.WebException] {
        }
        Start-Sleep -Milliseconds 200
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    throw 'Timed out waiting for packaged backend health.'
}

function Start-PackagedBackend {
    param(
        [Parameter(Mandatory = $true)][string]$DataRoot,
        [Parameter(Mandatory = $true)][string]$StandardOutput,
        [Parameter(Mandatory = $true)][string]$StandardError,
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [Parameter(Mandatory = $true)][string]$Pythonw,
        [Parameter(Mandatory = $true)][string]$ProgramRoot
    )
    $env:HSTAR_DATA_DIR = $DataRoot
    Write-Host "Starting packaged backend with data root: $DataRoot"
    $process = Start-Process `
        -FilePath $Pythonw `
        -ArgumentList @('-I', '-B', 'app/main.py') `
        -WorkingDirectory $ProgramRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $StandardOutput `
        -RedirectStandardError $StandardError `
        -PassThru
    Wait-ForBackend -Process $process -BaseUrl $BaseUrl
    return $process
}

function Stop-OwnedProcess {
    param([Diagnostics.Process]$Process)
    if ($null -eq $Process) {
        return
    }
    $Process.Refresh()
    if (-not $Process.HasExited) {
        Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
        $Process.WaitForExit(10000) | Out-Null
    }
    $Process.Dispose()
}

$repoRoot = Get-NormalizedPath -Path (Join-Path $PSScriptRoot '..')
$generatedRoot = Get-NormalizedPath -Path (Join-Path $repoRoot 'build\generated\windows11-package-smoke')
$script:InstallRoot = Get-NormalizedPath -Path $InstallRoot
if ($Port -eq 5000) {
    throw 'Packaged validation must never use production port 5000.'
}
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
    throw "Packaged validation port is already in use: $Port"
}

$pythonw = Join-Path $script:InstallRoot 'runtime\python\pythonw.exe'
$main = Join-Path $script:InstallRoot 'app\main.py'
foreach ($required in @($pythonw, $main)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Installed package file is missing: $required"
    }
}

$runId = [Guid]::NewGuid().ToString('N')
$dataRoot = Join-Path $generatedRoot "run-$runId"
$migrationTarget = Join-Path $generatedRoot "migrated-$runId"
$appDataRoot = Join-Path $dataRoot 'appdata'
New-Item -ItemType Directory -Path $dataRoot, $appDataRoot -Force | Out-Null

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $dataRoot 'package-smoke-result.json'
}
$output = Get-NormalizedPath -Path $OutputPath
if (-not ($output.StartsWith($generatedRoot + '\', [StringComparison]::OrdinalIgnoreCase))) {
    throw "OutputPath must stay under $generatedRoot"
}

$baseUrl = "http://127.0.0.1:$Port"
$providerId = "codex-package-smoke-$($runId.Substring(0, 8))"
$stdout = Join-Path $dataRoot 'backend.stdout.log'
$stderr = Join-Path $dataRoot 'backend.stderr.log'
$restartStdout = Join-Path $dataRoot 'restart.stdout.log'
$restartStderr = Join-Path $dataRoot 'restart.stderr.log'
$returnStdout = Join-Path $dataRoot 'return.stdout.log'
$returnStderr = Join-Path $dataRoot 'return.stderr.log'
$openShopRoot = Join-Path $repoRoot 'integrations\openshop'
$playwright = Join-Path $openShopRoot 'node_modules\.bin\playwright.cmd'
$playwrightConfig = Join-Path $openShopRoot 'playwright.config.js'
if (-not (Test-Path -LiteralPath $playwright -PathType Leaf)) {
    throw "Playwright command is missing: $playwright"
}

$environmentNames = @(
    'HSTAR_PROGRAM_DIR',
    'HSTAR_DATA_DIR',
    'HSTAR_EDITION',
    'HSTAR_HOST',
    'HSTAR_PORT',
    'HSTAR_BASE_URL',
    'HSTAR_EXPECTED_DATA_ROOT',
    'HSTAR_MIGRATION_TARGET',
    'HSTAR_EXPECTED_PROVIDER_ID',
    'HSTAR_DISABLE_AUTO_UPDATE',
    'HSTAR_SHELL_TOKEN',
    'APPDATA',
    'PYTHONUTF8',
    'PYTHONIOENCODING',
    'PYTHONDONTWRITEBYTECODE'
)
$savedEnvironment = @{}
foreach ($name in $environmentNames) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

$server = $null
$startedUtc = [DateTimeOffset]::UtcNow
try {
    $env:HSTAR_PROGRAM_DIR = $script:InstallRoot
    $env:HSTAR_DATA_DIR = $dataRoot
    $env:HSTAR_EDITION = 'windows11'
    $env:HSTAR_HOST = '127.0.0.1'
    $env:HSTAR_PORT = [string]$Port
    $env:HSTAR_BASE_URL = $baseUrl
    $env:HSTAR_EXPECTED_DATA_ROOT = $dataRoot
    $env:HSTAR_MIGRATION_TARGET = $migrationTarget
    $env:HSTAR_EXPECTED_PROVIDER_ID = $providerId
    $env:HSTAR_DISABLE_AUTO_UPDATE = '1'
    $env:HSTAR_SHELL_TOKEN = ''
    $env:APPDATA = $appDataRoot
    $env:PYTHONUTF8 = '1'
    $env:PYTHONIOENCODING = 'utf-8'
    $env:PYTHONDONTWRITEBYTECODE = '1'

    $server = Start-PackagedBackend `
        -DataRoot $dataRoot `
        -StandardOutput $stdout `
        -StandardError $stderr `
        -BaseUrl $baseUrl `
        -Pythonw $pythonw `
        -ProgramRoot $script:InstallRoot

    Invoke-Native -Command 'npm.cmd' -Arguments @(
        'run',
        'test:hstar:canvas-integration',
        '--prefix',
        $openShopRoot
    )
    Invoke-Native -Command $playwright -Arguments @(
        'test',
        'tests/hstar-shell-health.e2e.spec.js',
        'tests/hstar-windows11-package.e2e.spec.js',
        '--config',
        $playwrightConfig
    )

    Stop-OwnedProcess -Process $server
    $server = $null
    $env:HSTAR_EXPECTED_DATA_ROOT = $migrationTarget
    $server = Start-PackagedBackend `
        -DataRoot $migrationTarget `
        -StandardOutput $restartStdout `
        -StandardError $restartStderr `
        -BaseUrl $baseUrl `
        -Pythonw $pythonw `
        -ProgramRoot $script:InstallRoot

    $settings = Invoke-Utf8JsonGet -Uri "$baseUrl/api/software-settings"
    $expectedStorageRoot = Get-NormalizedPath -Path $migrationTarget
    $activeStorageRoot = Get-NormalizedPath -Path ([string]$settings.settings.active_storage_root)
    if (-not [string]::Equals(
        $activeStorageRoot,
        $expectedStorageRoot,
        [StringComparison]::OrdinalIgnoreCase)) {
        throw "Migrated data root was not active after restart. Expected: $expectedStorageRoot; actual: $activeStorageRoot"
    }
    $providersInSwitchTarget = Invoke-Utf8JsonGet -Uri "$baseUrl/api/providers"
    if (@($providersInSwitchTarget.providers | Where-Object { $_.id -eq $providerId })) {
        throw 'Custom API provider unexpectedly appeared in isolated storage root.'
    }

    Request-StorageRootSwitch -BaseUrl $baseUrl -StorageRoot $dataRoot
    Stop-OwnedProcess -Process $server
    $server = $null
    $env:HSTAR_EXPECTED_DATA_ROOT = $dataRoot
    $server = Start-PackagedBackend `
        -DataRoot $dataRoot `
        -StandardOutput $returnStdout `
        -StandardError $returnStderr `
        -BaseUrl $baseUrl `
        -Pythonw $pythonw `
        -ProgramRoot $script:InstallRoot

    $returnedSettings = Invoke-Utf8JsonGet -Uri "$baseUrl/api/software-settings"
    $expectedOriginalRoot = Get-NormalizedPath -Path $dataRoot
    $returnedStorageRoot = Get-NormalizedPath -Path ([string]$returnedSettings.settings.active_storage_root)
    if (-not [string]::Equals(
        $returnedStorageRoot,
        $expectedOriginalRoot,
        [StringComparison]::OrdinalIgnoreCase)) {
        throw "Original data root was not active after switching back. Expected: $expectedOriginalRoot; actual: $returnedStorageRoot"
    }
    $providersInOriginalRoot = Invoke-Utf8JsonGet -Uri "$baseUrl/api/providers"
    if (-not @($providersInOriginalRoot.providers | Where-Object { $_.id -eq $providerId })) {
        throw 'Switching back to original storage root did not restore custom API provider.'
    }

    $programCacheEntries = @(Get-ChildItem `
        -LiteralPath $script:InstallRoot `
        -Recurse `
        -Force `
        -ErrorAction SilentlyContinue | Where-Object {
            $_.Name -eq '__pycache__' -or $_.Extension -in @('.pyc', '.pyo')
        }).Count
    if ($programCacheEntries -ne 0) {
        throw "Packaged smoke created $programCacheEntries Python cache entries in the program directory."
    }

    $report = [ordered]@{
        schemaVersion = 1
        passed = $true
        startedUtc = $startedUtc.ToString('o')
        completedUtc = [DateTimeOffset]::UtcNow.ToString('o')
        installRoot = $script:InstallRoot
        dataRoot = $dataRoot
        migrationTarget = $migrationTarget
        appDataRoot = $appDataRoot
        port = $Port
        providerId = $providerId
        switchTargetInheritedProvider = $false
        originalRootRestoredProvider = $true
        programCacheEntries = $programCacheEntries
        backendLog = $stdout
        restartLog = $restartStdout
        returnLog = $returnStdout
    }
    $parent = Split-Path -Parent $output
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    [IO.File]::WriteAllText(
        $output,
        (($report | ConvertTo-Json -Depth 5) + "`n"),
        [Text.UTF8Encoding]::new($false))
    Write-Host "Windows 11 packaged feature smoke passed: $output"
}
catch {
    foreach ($logPath in @(
        $stdout,
        $stderr,
        $restartStdout,
        $restartStderr,
        $returnStdout,
        $returnStderr
    )) {
        if (Test-Path -LiteralPath $logPath -PathType Leaf) {
            Write-Host "--- $(Split-Path -Leaf $logPath) ---"
            Get-Content -LiteralPath $logPath -Encoding UTF8 -Tail 100
        }
    }
    throw
}
finally {
    Stop-OwnedProcess -Process $server
    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
}
