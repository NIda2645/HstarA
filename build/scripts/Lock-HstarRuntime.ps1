[CmdletBinding()]
param(
    [ValidateSet('windows11')]
    [string]$Edition = 'windows11',
    [switch]$Refresh
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$lockDirectory = Join-Path $repoRoot 'build\runtime-locks'
$requirementsPath = Join-Path $lockDirectory 'windows11-requirements.txt'
$lockPath = Join-Path $lockDirectory 'windows11-runtime.json'
$cacheRoot = Join-Path $repoRoot 'build\runtime-cache\windows11'
$reportPath = Join-Path $cacheRoot 'pip-resolution-report.json'

if ((Test-Path -LiteralPath $lockPath) -and -not $Refresh) {
    throw "Runtime lock already exists. Use -Refresh only for an intentional dependency refresh: $lockPath"
}
if (-not (Test-Path -LiteralPath $requirementsPath -PathType Leaf)) {
    throw "Windows 11 direct requirements file is missing: $requirementsPath"
}

New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-DownloadName {
    param([Parameter(Mandatory = $true)][string]$Url)
    $uri = [Uri]$Url
    if ($uri.Scheme -ne 'https') {
        throw "Runtime artifacts must use HTTPS: $Url"
    }
    $name = [Uri]::UnescapeDataString([IO.Path]::GetFileName($uri.AbsolutePath))
    if ([string]::IsNullOrWhiteSpace($name) -or $name.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0) {
        throw "Runtime artifact URL does not contain a safe filename: $Url"
    }
    return $name
}

function Receive-Artifact {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [string]$ExpectedSha256 = ''
    )

    $name = Get-DownloadName -Url $Url
    $destination = Join-Path $cacheRoot $name
    if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
        $partial = "$destination.partial"
        Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
        try {
            Invoke-WebRequest -Uri $Url -OutFile $partial -UseBasicParsing
            Move-Item -LiteralPath $partial -Destination $destination -Force
        }
        finally {
            Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
        }
    }

    $file = Get-Item -LiteralPath $destination
    if ($file.Length -le 0) {
        throw "Downloaded artifact is empty: $destination"
    }
    $sha256 = Get-Sha256 -Path $destination
    if ($ExpectedSha256 -and $sha256 -ne $ExpectedSha256.ToLowerInvariant()) {
        throw "Downloaded artifact SHA-256 does not match the package index: $name"
    }
    return [ordered]@{
        name = $name
        url = $Url
        sha256 = $sha256
        size = [long]$file.Length
    }
}

$pythonUrl = 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip'
$voicePythonUrl = 'https://www.python.org/ftp/python/3.10.11/python-3.10.11-embed-amd64.zip'
$webViewUrl = 'https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/1c394b0d-2689-4d8b-af57-2f2018abccf6/Microsoft.WebView2.FixedVersionRuntime.150.0.4078.99.x64.cab'
$pythonArtifact = Receive-Artifact -Url $pythonUrl
$voicePythonArtifact = Receive-Artifact -Url $voicePythonUrl
$webViewArtifact = Receive-Artifact -Url $webViewUrl

$resolverPython = if ($env:HSTAR_LOCK_PYTHON) {
    $env:HSTAR_LOCK_PYTHON
} else {
    Join-Path $repoRoot 'python\python.exe'
}
if (-not (Test-Path -LiteralPath $resolverPython -PathType Leaf)) {
    throw "Engineering Python used to resolve wheel metadata is missing: $resolverPython"
}

Remove-Item -LiteralPath $reportPath -Force -ErrorAction SilentlyContinue
$pipArguments = @(
    '-m', 'pip', 'install',
    '--dry-run',
    '--ignore-installed',
    '--disable-pip-version-check',
    '--only-binary=:all:',
    '--platform', 'win_amd64',
    '--implementation', 'cp',
    '--python-version', '3.11',
    '--abi', 'cp311',
    '--report', $reportPath,
    '-r', $requirementsPath,
    'pip==26.1.2',
    'setuptools==83.0.0',
    'wheel==0.47.0'
)
& $resolverPython @pipArguments
if ($LASTEXITCODE -ne 0) {
    throw "pip failed to resolve Windows 11 cp311/win_amd64 wheels. Exit code: $LASTEXITCODE"
}
if (-not (Test-Path -LiteralPath $reportPath -PathType Leaf)) {
    throw "pip did not create a dependency resolution report: $reportPath"
}

$report = Get-Content -LiteralPath $reportPath -Raw -Encoding UTF8 | ConvertFrom-Json
$packages = @()
foreach ($item in $report.install) {
    $url = [string]$item.download_info.url
    $filename = Get-DownloadName -Url $url
    if (-not $filename.EndsWith('.whl', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Runtime dependency is not a wheel: $filename"
    }
    if ($filename -notmatch '(?i)-(?:py2\.py3|py3)-none-any\.whl$' -and $filename -notmatch '(?i)-(?:cp311|cp3\d|abi3)-[^-]*-win_amd64\.whl$') {
        throw "Wheel is not compatible with Python 3.11 x64: $filename"
    }
    $expectedHash = [string]$item.download_info.archive_info.hashes.sha256
    if ($expectedHash -notmatch '^[a-fA-F0-9]{64}$') {
        throw "Package index did not provide SHA-256: $filename"
    }
    $artifact = Receive-Artifact -Url $url -ExpectedSha256 $expectedHash
    $packages += [pscustomobject][ordered]@{
        kind = 'python-wheel'
        name = ([string]$item.metadata.name).ToLowerInvariant().Replace('_', '-')
        version = [string]$item.metadata.version
        filename = $artifact.name
        url = $artifact.url
        sha256 = $artifact.sha256
        size = [long]$artifact.size
        requested = [bool]$item.requested
        requiresPython = [string]$item.metadata.requires_python
    }
}
$packages = @($packages | Sort-Object -Property name)
if ($packages.Count -eq 0) {
    throw 'pip dependency resolution report did not contain wheels.'
}

$requirementsHash = Get-Sha256 -Path $requirementsPath
$totalDownloadBytes = [long]$pythonArtifact.size + [long]$voicePythonArtifact.size + [long]$webViewArtifact.size
foreach ($package in $packages) {
    $totalDownloadBytes += [long]$package.size
}

$lock = [ordered]@{
    schemaVersion = 1
    edition = $Edition
    architecture = 'x64'
    pythonAbi = 'cp311'
    requirementsFile = 'build/runtime-locks/windows11-requirements.txt'
    requirementsSha256 = $requirementsHash
    python = [ordered]@{
        version = '3.11.9'
        architecture = 'x64'
        abi = 'cp311'
        artifact = $pythonArtifact
    }
    voicePython = [ordered]@{
        version = '3.10.11'
        architecture = 'x64'
        abi = 'cp310'
        artifact = $voicePythonArtifact
    }
    webView2 = [ordered]@{
        version = '150.0.4078.99'
        distribution = 'fixed'
        architecture = 'x64'
        artifact = $webViewArtifact
    }
    packages = $packages
    totalDownloadBytes = $totalDownloadBytes
}

$json = $lock | ConvertTo-Json -Depth 12
[IO.File]::WriteAllText(
    $lockPath,
    $json + [Environment]::NewLine,
    [Text.UTF8Encoding]::new($false))
Write-Host "Windows 11 runtime lock written: $lockPath"
Write-Host "Locked download size: $totalDownloadBytes bytes"
