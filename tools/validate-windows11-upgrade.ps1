[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BaseInstaller,
    [Parameter(Mandatory = $true)][string]$UpgradeInstaller,
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [string]$OutputPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:InstallerAttempt = 0

function Get-NormalizedPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\', '/'))
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )
    $parent = Split-Path -Parent $Path
    if ($parent) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function Get-TreeHashes {
    param([Parameter(Mandatory = $true)][string]$Root)
    $result = [ordered]@{}
    Get-ChildItem -LiteralPath $Root -File -Recurse -Force |
        Sort-Object FullName |
        ForEach-Object {
            $relative = $_.FullName.Substring($Root.Length).TrimStart('\', '/')
            $result[$relative] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    return $result
}

function Assert-HashSetsEqual {
    param(
        [Parameter(Mandatory = $true)]$Expected,
        [Parameter(Mandatory = $true)]$Actual,
        [Parameter(Mandatory = $true)][string]$Message
    )
    $expectedJson = $Expected | ConvertTo-Json -Depth 10 -Compress
    $actualJson = $Actual | ConvertTo-Json -Depth 10 -Compress
    if ($expectedJson -cne $actualJson) {
        throw $Message
    }
}

function Invoke-Installer {
    param([Parameter(Mandatory = $true)][string]$Path)
    $script:InstallerAttempt += 1
    $logPath = Join-Path $script:RunRoot "installer-$($script:InstallerAttempt).log"
    $arguments = @(
        '/VERYSILENT',
        '/SUPPRESSMSGBOXES',
        '/NORESTART',
        '/TASKS=""',
        ('/DIR="' + $script:InstallRoot + '"'),
        ('/LOG="' + $logPath + '"')
    )
    Write-Host "> $Path $($arguments -join ' ')"
    $process = Start-Process `
        -FilePath $Path `
        -ArgumentList $arguments `
        -Wait `
        -PassThru
    if ($process.ExitCode -ne 0) {
        throw "Installer failed with exit code $($process.ExitCode): $Path. Log: $logPath"
    }
}

function Get-UninstallMetadata {
    $metadata = Get-ChildItem -LiteralPath $script:InstallRoot -Filter 'unins*.dat' -File |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    if ($null -eq $metadata) {
        throw 'Inno uninstall metadata is missing after installation.'
    }
    return $metadata
}

$repoRoot = Get-NormalizedPath -Path (Join-Path $PSScriptRoot '..')
$generatedRoot = Get-NormalizedPath -Path (Join-Path $repoRoot 'build\generated\windows11-upgrade-smoke')
$script:InstallRoot = Get-NormalizedPath -Path $InstallRoot
$baseInstallerPath = Get-NormalizedPath -Path $BaseInstaller
$upgradeInstallerPath = Get-NormalizedPath -Path $UpgradeInstaller

if ((Split-Path -Leaf $script:InstallRoot) -ne 'hstar-win11-install-test') {
    throw 'Upgrade validation is restricted to the hstar-win11-install-test directory.'
}
foreach ($installer in @($baseInstallerPath, $upgradeInstallerPath)) {
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
        throw "Installer is missing: $installer"
    }
}

$runId = [Guid]::NewGuid().ToString('N')
$runRoot = Join-Path $generatedRoot "run-$runId"
$script:RunRoot = $runRoot
$dataRoot = Join-Path $runRoot 'data'
$configRoot = Join-Path $dataRoot 'config'
$secretsRoot = Join-Path $dataRoot 'secrets'
$sentinelRoot = Join-Path $dataRoot 'projects'
New-Item -ItemType Directory -Path $configRoot, $secretsRoot, $sentinelRoot -Force | Out-Null

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $runRoot 'upgrade-result.json'
}
$output = Get-NormalizedPath -Path $OutputPath
if (-not ($output.StartsWith($runRoot + '\', [StringComparison]::OrdinalIgnoreCase))) {
    throw "OutputPath must stay under $runRoot"
}

$defaultsPath = Join-Path $repoRoot 'build\installer\stage\windows11\API\defaults\api-providers.json'
if (-not (Test-Path -LiteralPath $defaultsPath -PathType Leaf)) {
    throw "Staged API defaults are missing: $defaultsPath"
}
$defaultDocument = Get-Content -LiteralPath $defaultsPath -Raw -Encoding UTF8 | ConvertFrom-Json
$defaults = @()
foreach ($provider in $defaultDocument) {
    $defaults += $provider
}
if ($defaults.Count -eq 0) {
    throw 'Staged API defaults are empty.'
}

$expectedOfficialName = [string]$defaults[0].name
$currentProviders = @($defaults | ForEach-Object { $_ })
$currentProviders[0].name = 'Outdated official provider name'
$currentProviders[0].enabled = $false
$customProviderId = "codex-upgrade-$($runId.Substring(0, 8))"
$customProvider = [pscustomobject]@{
    id = $customProviderId
    name = 'Upgrade preservation probe'
    base_url = 'https://example.invalid/v1'
    protocol = 'openai'
    enabled = $false
    primary = $false
    image_models = @()
    chat_models = @()
    video_models = @()
    custom_metadata = [pscustomobject]@{ owner = 'isolated-test'; run = $runId }
}
$currentProviders += $customProvider
$providersPath = Join-Path $configRoot 'api-providers.user.json'
Write-Utf8NoBom -Path $providersPath -Content (($currentProviders | ConvertTo-Json -Depth 20) + "`n")

$credentialsPath = Join-Path $secretsRoot 'credentials.dpapi'
[IO.File]::WriteAllBytes(
    $credentialsPath,
    [Text.Encoding]::UTF8.GetBytes("isolated-upgrade-credential-$runId"))
$sentinelPath = Join-Path $sentinelRoot 'preserve-me.json'
Write-Utf8NoBom -Path $sentinelPath -Content (([ordered]@{
    schemaVersion = 1
    runId = $runId
    note = 'User data must survive every program upgrade.'
} | ConvertTo-Json) + "`n")

$beforeInstallHashes = Get-TreeHashes -Root $dataRoot
$credentialHashBefore = (Get-FileHash -LiteralPath $credentialsPath -Algorithm SHA256).Hash.ToLowerInvariant()
$startedUtc = [DateTimeOffset]::UtcNow

Invoke-Installer -Path $baseInstallerPath
Invoke-Installer -Path $baseInstallerPath
$baseUninstallMetadata = Get-UninstallMetadata
$baseUninstallHash = (Get-FileHash -LiteralPath $baseUninstallMetadata.FullName -Algorithm SHA256).Hash.ToLowerInvariant()

$staleAppMarker = Join-Path $script:InstallRoot 'app\stale-upgrade-probe.txt'
$staleRuntimeMarker = Join-Path $script:InstallRoot 'runtime\stale-upgrade-probe.txt'
Write-Utf8NoBom -Path $staleAppMarker -Content 'obsolete app payload'
Write-Utf8NoBom -Path $staleRuntimeMarker -Content 'obsolete runtime payload'

Invoke-Installer -Path $upgradeInstallerPath
if ((Test-Path -LiteralPath $staleAppMarker) -or (Test-Path -LiteralPath $staleRuntimeMarker)) {
    throw 'The version upgrade did not remove stale app and runtime payload files.'
}

$upgradeUninstallMetadata = Get-UninstallMetadata
$upgradeUninstallHash = (Get-FileHash -LiteralPath $upgradeUninstallMetadata.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
if ($baseUninstallHash -eq $upgradeUninstallHash) {
    throw 'Version-bumped installer metadata did not change.'
}

$afterInstallHashes = Get-TreeHashes -Root $dataRoot
Assert-HashSetsEqual `
    -Expected $beforeInstallHashes `
    -Actual $afterInstallHashes `
    -Message 'Install or upgrade modified the isolated user data root.'

$python = Join-Path $script:InstallRoot 'runtime\python\python.exe'
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "Installed Python runtime is missing: $python"
}
$maintenanceStdout = Join-Path $runRoot 'maintenance.stdout.log'
$maintenanceStderr = Join-Path $runRoot 'maintenance.stderr.log'
$savedEnvironment = @{}
foreach ($name in @('PYTHONUTF8', 'PYTHONIOENCODING', 'PYTHONDONTWRITEBYTECODE')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
    $env:PYTHONUTF8 = '1'
    $env:PYTHONIOENCODING = 'utf-8'
    $env:PYTHONDONTWRITEBYTECODE = '1'
    $maintenanceArguments = @(
        '-I',
        '-B',
        '-m',
        'hstar_runtime.maintenance',
        'update-api-config',
        '--program-root',
        ('"' + $script:InstallRoot + '"'),
        '--data-root',
        ('"' + $dataRoot + '"'),
        '--edition',
        'windows11'
    )
    $maintenance = Start-Process `
        -FilePath $python `
        -ArgumentList $maintenanceArguments `
        -WorkingDirectory $script:InstallRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $maintenanceStdout `
        -RedirectStandardError $maintenanceStderr `
        -Wait `
        -PassThru
    if ($maintenance.ExitCode -ne 0) {
        $details = Get-Content -LiteralPath $maintenanceStderr -Raw -Encoding UTF8
        throw "Isolated API maintenance failed with exit code $($maintenance.ExitCode): $details"
    }
}
finally {
    foreach ($name in $savedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
}

$updatedDocument = Get-Content -LiteralPath $providersPath -Raw -Encoding UTF8 | ConvertFrom-Json
$updatedProviders = @()
foreach ($provider in $updatedDocument) {
    $updatedProviders += $provider
}
$updatedCustom = @($updatedProviders | Where-Object { $_.id -eq $customProviderId })
if ($updatedCustom.Count -ne 1 -or
    $updatedCustom[0].name -ne $customProvider.name -or
    $updatedCustom[0].base_url -ne $customProvider.base_url -or
    $updatedCustom[0].custom_metadata.run -ne $runId) {
    throw 'Custom API provider did not survive the isolated API update.'
}
$firstOfficial = @($updatedProviders | Where-Object { $_.id -eq $defaults[0].id })
if ($firstOfficial.Count -ne 1 -or $firstOfficial[0].name -ne $expectedOfficialName) {
    throw 'Official API provider defaults were not updated.'
}
$credentialHashAfter = (Get-FileHash -LiteralPath $credentialsPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($credentialHashAfter -ne $credentialHashBefore) {
    throw 'Credential storage changed during the API defaults update.'
}
$backupCount = @(Get-ChildItem -LiteralPath (Join-Path $dataRoot 'backups\api') -Filter '*.json' -File).Count
if ($backupCount -lt 1) {
    throw 'API defaults update did not create a sanitized provider backup.'
}

$programCacheEntries = @(Get-ChildItem `
    -LiteralPath $script:InstallRoot `
    -Recurse `
    -Force `
    -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -eq '__pycache__' -or $_.Extension -in @('.pyc', '.pyo')
    }).Count
if ($programCacheEntries -ne 0) {
    throw "Upgrade validation created $programCacheEntries Python cache entries in the program directory."
}

$report = [ordered]@{
    schemaVersion = 1
    passed = $true
    startedUtc = $startedUtc.ToString('o')
    completedUtc = [DateTimeOffset]::UtcNow.ToString('o')
    baseInstaller = $baseInstallerPath
    baseInstallerSha256 = (Get-FileHash -LiteralPath $baseInstallerPath -Algorithm SHA256).Hash.ToLowerInvariant()
    upgradeInstaller = $upgradeInstallerPath
    upgradeInstallerSha256 = (Get-FileHash -LiteralPath $upgradeInstallerPath -Algorithm SHA256).Hash.ToLowerInvariant()
    installRoot = $script:InstallRoot
    dataRoot = $dataRoot
    dataFilesPreserved = $beforeInstallHashes.Count
    customProviderId = $customProviderId
    credentialSha256 = $credentialHashAfter
    providerBackupCount = $backupCount
    stalePayloadRemoved = $true
    uninstallMetadataChanged = $true
    programCacheEntries = $programCacheEntries
}
Write-Utf8NoBom -Path $output -Content (($report | ConvertTo-Json -Depth 10) + "`n")
Write-Host "Windows 11 upgrade and data preservation validation passed: $output"
