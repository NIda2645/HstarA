[CmdletBinding()]
param(
    [string]$InnoCompiler = '',
    [switch]$AllowTestStage
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$stageRoot = Join-Path $repoRoot 'build\installer\stage\windows11'
$stageValidator = Join-Path $repoRoot 'build\scripts\Test-HstarWindows11Stage.ps1'
$installerDefinition = Join-Path $repoRoot 'build\installer\Hstar.Windows11.iss'
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'build\release\windows11')).TrimEnd('\')
$approvedReleaseParent = [IO.Path]::GetFullPath((Join-Path $repoRoot 'build\release')).TrimEnd('\')
if ((Split-Path -Parent $releaseRoot) -ne $approvedReleaseParent -or
    (Split-Path -Leaf $releaseRoot) -ne 'windows11') {
    throw "Unsafe Windows 11 release path: $releaseRoot"
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

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

Set-Location $repoRoot
Invoke-Native -Command 'powershell.exe' -Arguments @(
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $stageValidator
)

$stageReleasePath = Join-Path $stageRoot 'manifests\release.json'
$stageRelease = Get-Content -LiteralPath $stageReleasePath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $AllowTestStage -and
    ($stageRelease.sourceTreeClean -ne $true -or $stageRelease.qualification -ne 'release')) {
    throw 'Official installer builds require a clean, release-qualified Windows 11 stage.'
}

if ([string]::IsNullOrWhiteSpace($InnoCompiler)) {
    $InnoCompiler = @(
        'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
        'C:\Program Files\Inno Setup 6\ISCC.exe',
        (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if ([string]::IsNullOrWhiteSpace($InnoCompiler) -or
    -not (Test-Path -LiteralPath $InnoCompiler -PathType Leaf)) {
    throw 'Inno Setup 6 compiler ISCC.exe was not found.'
}

$version = (Get-Content -LiteralPath (Join-Path $repoRoot 'VERSION') -Raw -Encoding UTF8).Trim()
if ($version -notmatch '^[0-9]+(?:\.[0-9]+){2,3}$') {
    throw "VERSION cannot be used in the installer file name: $version"
}

New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
$installerName = "Hstar_Windows11_Setup_$version.exe"
$installerPath = [IO.Path]::GetFullPath((Join-Path $releaseRoot $installerName))
if ((Split-Path -Parent $installerPath) -ne $releaseRoot) {
    throw "Unsafe installer output path: $installerPath"
}
if (Test-Path -LiteralPath $installerPath -PathType Leaf) {
    Remove-Item -LiteralPath $installerPath -Force
}

$innoArguments = @(
    "/DMyAppVersion=$version",
    $installerDefinition
)
$innoVersion = ''
Write-Host "> $InnoCompiler $($innoArguments -join ' ')"
& $InnoCompiler @innoArguments 2>&1 | ForEach-Object {
    $line = [string]$_
    Write-Host $line
    if ($line -match '^Compiler engine version:\s*Inno Setup\s+([0-9]+(?:\.[0-9]+)+)') {
        $innoVersion = $Matches[1]
    }
}
if ($LASTEXITCODE -ne 0) {
    throw "Inno Setup failed with exit code ${LASTEXITCODE}: $InnoCompiler $($innoArguments -join ' ')"
}
if ([string]::IsNullOrWhiteSpace($innoVersion)) {
    throw 'Inno Setup compiler version was not present in the compiler output.'
}
if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
    throw "Installer was not created: $installerPath"
}

$installerFile = Get-Item -LiteralPath $installerPath
$releaseManifest = [ordered]@{
    schemaVersion = 1
    product = 'Hstar'
    edition = 'windows11'
    architecture = 'x64'
    version = $version
    sourceCommit = [string]$stageRelease.sourceCommit
    stageQualification = [string]$stageRelease.qualification
    runtimeLockSha256 = [string]$stageRelease.runtimeLockSha256
    sbomSha256 = [string]$stageRelease.sbomSha256
    stageFileCount = [long]$stageRelease.fileCount
    stageBytes = [long]$stageRelease.stageBytes
    installer = [ordered]@{
        fileName = $installerName
        bytes = [long]$installerFile.Length
        sha256 = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
        innoVersion = [string]$innoVersion
        signing = 'unsigned'
    }
    createdUtc = [DateTimeOffset]::UtcNow.ToString('o')
}
$releaseManifestPath = Join-Path $releaseRoot 'release-manifest.json'
Write-Utf8NoBom -Path $releaseManifestPath -Content (($releaseManifest | ConvertTo-Json -Depth 10) + "`n")
Write-Host "Windows 11 installer created: $installerPath"
Write-Host "SHA-256: $($releaseManifest.installer.sha256)"
