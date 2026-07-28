[CmdletBinding()]
param(
    [switch]$AllowDirtyForTest
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$stageParent = [IO.Path]::GetFullPath((Join-Path $repoRoot 'build\installer\stage')).TrimEnd('\')
$stageRoot = [IO.Path]::GetFullPath((Join-Path $stageParent 'windows11')).TrimEnd('\')
$cacheRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'build\runtime-cache\windows11')).TrimEnd('\')
$lockPath = Join-Path $repoRoot 'build\runtime-locks\windows11-runtime.json'
$sourceGatePath = Join-Path $repoRoot 'build\scripts\Test-HstarSource.ps1'
$stageValidatorPath = Join-Path $repoRoot 'build\scripts\Test-HstarWindows11Stage.ps1'

if ((Split-Path -Parent $stageRoot) -ne $stageParent -or (Split-Path -Leaf $stageRoot) -ne 'windows11') {
    throw "Unsafe Windows 11 stage path: $stageRoot"
}
if (-not $cacheRoot.StartsWith([IO.Path]::GetFullPath((Join-Path $repoRoot 'build\runtime-cache')).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe runtime cache path: $cacheRoot"
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )
    $directory = Split-Path -Parent $Path
    if ($directory) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
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

function Assert-CleanWorktree {
    $status = & git -C $repoRoot status --porcelain=v1 --untracked-files=all
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to inspect the Git worktree.'
    }
    if ($status -and -not $AllowDirtyForTest) {
        throw "Windows 11 release staging requires a clean Git worktree.`n$($status -join [Environment]::NewLine)"
    }
}

function Get-LowerSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-ArtifactPath {
    param([Parameter(Mandatory = $true)]$Artifact)

    $name = [string]$Artifact.name
    $url = [string]$Artifact.url
    $expectedHash = ([string]$Artifact.sha256).ToLowerInvariant()
    $expectedSize = [long]$Artifact.size
    if ([IO.Path]::GetFileName($name) -ne $name -or $url -notmatch '^https://' -or $expectedHash -notmatch '^[a-f0-9]{64}$' -or $expectedSize -le 0) {
        throw "Invalid locked runtime artifact: $name"
    }

    New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
    $destination = Join-Path $cacheRoot $name
    $resolvedDestination = [IO.Path]::GetFullPath($destination)
    if (-not $resolvedDestination.StartsWith($cacheRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Locked runtime artifact escaped the cache: $name"
    }
    if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
        $partial = "$destination.partial"
        Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
        try {
            Invoke-WebRequest -Uri $url -OutFile $partial -UseBasicParsing
            Move-Item -LiteralPath $partial -Destination $destination -Force
        }
        finally {
            Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
        }
    }

    $file = Get-Item -LiteralPath $destination
    if ($file.Length -ne $expectedSize) {
        throw "Locked artifact size mismatch: $name"
    }
    if ((Get-LowerSha256 -Path $destination) -ne $expectedHash) {
        throw "Locked artifact SHA-256 mismatch: $name"
    }
    return $destination
}

function Get-TrackedFiles {
    param([Parameter(Mandatory = $true)][string]$RelativeRoot)

    if ($RelativeRoot.IndexOfAny(@([char]0, [char]10, [char]13, [char]34)) -ge 0 -or
        $repoRoot.IndexOf([char]34) -ge 0) {
        throw "Unsafe Git path argument: $RelativeRoot"
    }

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = 'git.exe'
    $startInfo.Arguments = "-C `"$repoRoot`" -c core.quotepath=false ls-files -z -- `"$RelativeRoot`""
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
    $startInfo.StandardErrorEncoding = [Text.Encoding]::UTF8

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $process.Start() | Out-Null
    $output = $process.StandardOutput.ReadToEnd()
    $errorOutput = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    $exitCode = $process.ExitCode
    $process.Dispose()
    if ($exitCode -ne 0) {
        throw "Unable to list tracked files for ${RelativeRoot}: $errorOutput"
    }
    return @($output.Split(@([char]0), [StringSplitOptions]::RemoveEmptyEntries))
}

function Copy-TrackedRoot {
    param([Parameter(Mandatory = $true)][string]$RelativeRoot)

    $tracked = @(Get-TrackedFiles -RelativeRoot $RelativeRoot)
    if ($tracked.Count -eq 0) {
        throw "Tracked runtime root is empty: $RelativeRoot"
    }
    foreach ($relativePath in $tracked) {
        $source = Join-Path $repoRoot $relativePath
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw "Tracked runtime source is missing: $relativePath"
        }
        $target = Join-Path $stageRoot $relativePath
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $target -Force
    }
}

function New-SpdxPackage {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Version,
        [Parameter(Mandatory = $true)][string]$License,
        [Parameter(Mandatory = $true)][string]$DownloadLocation,
        [Parameter(Mandatory = $true)][object[]]$Checksums
    )
    return [pscustomobject][ordered]@{
        SPDXID = "SPDXRef-$Id"
        name = $Name
        versionInfo = $Version
        downloadLocation = $DownloadLocation
        filesAnalyzed = $false
        licenseConcluded = $License
        licenseDeclared = $License
        checksums = @($Checksums)
    }
}

function New-Sha256Checksum {
    param([Parameter(Mandatory = $true)][string]$Value)
    return [pscustomobject][ordered]@{
        algorithm = 'SHA256'
        checksumValue = $Value.ToLowerInvariant()
    }
}

Set-Location $repoRoot
Assert-CleanWorktree
New-Item -ItemType Directory -Path $stageParent -Force | Out-Null
if (Test-Path -LiteralPath $stageRoot) {
    if ((Split-Path -Parent $stageRoot) -ne $stageParent -or (Split-Path -Leaf $stageRoot) -ne 'windows11') {
        throw "Refusing unsafe stage cleanup: $stageRoot"
    }
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
}
Invoke-Native -Command 'powershell.exe' -Arguments @(
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $sourceGatePath
)
Assert-CleanWorktree

if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
    throw "Windows 11 runtime lock is missing: $lockPath"
}
$runtimeLock = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($runtimeLock.schemaVersion -ne 1 -or $runtimeLock.edition -ne 'windows11' -or
    $runtimeLock.architecture -ne 'x64' -or $runtimeLock.pythonAbi -ne 'cp311') {
    throw 'Windows 11 runtime lock metadata is invalid.'
}

$pythonArchive = Get-ArtifactPath -Artifact $runtimeLock.python.artifact
$webViewArchive = Get-ArtifactPath -Artifact $runtimeLock.webView2.artifact
$wheelPaths = @()
foreach ($package in $runtimeLock.packages) {
    $artifact = [pscustomobject]@{
        name = [string]$package.filename
        url = [string]$package.url
        sha256 = [string]$package.sha256
        size = [long]$package.size
    }
    $wheelPaths += Get-ArtifactPath -Artifact $artifact
}

New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null

$desktopProject = Join-Path $repoRoot 'desktop\Hstar.Desktop\Hstar.Desktop.csproj'
Invoke-Native -Command 'dotnet' -Arguments @(
    'publish',
    $desktopProject,
    '-c',
    'Release',
    '-r',
    'win-x64',
    '--self-contained',
    'true',
    '-p:PublishSingleFile=false',
    '-p:DebugType=None',
    '-p:DebugSymbols=false',
    '-o',
    $stageRoot
)

$pythonRoot = Join-Path $stageRoot 'runtime\python'
New-Item -ItemType Directory -Path $pythonRoot -Force | Out-Null
Expand-Archive -LiteralPath $pythonArchive -DestinationPath $pythonRoot -Force
$pythonPathFile = Join-Path $pythonRoot 'python311._pth'
$pythonPathContent = @(
    'python311.zip',
    '.',
    '',
    'Lib\site-packages',
    '..\..\app',
    'import site',
    ''
) -join "`n"
Write-Utf8NoBom -Path $pythonPathFile -Content $pythonPathContent

$sitePackages = Join-Path $pythonRoot 'Lib\site-packages'
New-Item -ItemType Directory -Path $sitePackages -Force | Out-Null
$pipPackage = @($runtimeLock.packages | Where-Object { $_.name -eq 'pip' }) | Select-Object -First 1
if (-not $pipPackage) {
    throw 'Windows 11 runtime lock does not include pip.'
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory(
    (Join-Path $cacheRoot ([string]$pipPackage.filename)),
    $sitePackages)

$embeddedPython = Join-Path $pythonRoot 'python.exe'
$pipTemp = Join-Path $stageRoot '.pip-temp'
New-Item -ItemType Directory -Path $pipTemp -Force | Out-Null
$savedTemp = $env:TEMP
$savedTmp = $env:TMP
$savedNoCache = $env:PIP_NO_CACHE_DIR
$savedNoBytecode = $env:PYTHONDONTWRITEBYTECODE
try {
    $env:TEMP = $pipTemp
    $env:TMP = $pipTemp
    $env:PIP_NO_CACHE_DIR = '1'
    $env:PYTHONDONTWRITEBYTECODE = '1'
    $pipArguments = @(
        '-I',
        '-m',
        'pip',
        'install',
        '--no-index',
        '--find-links',
        $cacheRoot,
        '--only-binary=:all:',
        '--no-deps',
        '--upgrade',
        '--no-compile',
        '--target',
        $sitePackages
    ) + $wheelPaths
    Invoke-Native -Command $embeddedPython -Arguments $pipArguments
}
finally {
    $env:TEMP = $savedTemp
    $env:TMP = $savedTmp
    $env:PIP_NO_CACHE_DIR = $savedNoCache
    $env:PYTHONDONTWRITEBYTECODE = $savedNoBytecode
    if (Test-Path -LiteralPath $pipTemp) {
        Remove-Item -LiteralPath $pipTemp -Recurse -Force
    }
}
Get-ChildItem -LiteralPath $sitePackages -Recurse -Directory |
    Where-Object { $_.Name -in @('test', 'tests') } |
    Sort-Object -Property FullName -Descending |
    Remove-Item -Recurse -Force
Get-ChildItem -LiteralPath $pythonRoot -Recurse -Directory -Filter '__pycache__' |
    Sort-Object -Property FullName -Descending |
    Remove-Item -Recurse -Force
Get-ChildItem -LiteralPath $pythonRoot -Recurse -File |
    Where-Object { $_.Extension -in @('.pyc', '.pyo') } |
    Remove-Item -Force

$webViewRoot = Join-Path $stageRoot 'runtime\browser\WebView2'
New-Item -ItemType Directory -Path $webViewRoot -Force | Out-Null
$webViewExtractRoot = Join-Path $stageRoot '.webview2-extract'
New-Item -ItemType Directory -Path $webViewExtractRoot -Force | Out-Null
try {
    Write-Host "> expand.exe -F:* $webViewArchive $webViewExtractRoot"
    & "$env:SystemRoot\System32\expand.exe" '-F:*' $webViewArchive $webViewExtractRoot | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "WebView2 CAB expansion failed with exit code $LASTEXITCODE."
    }

    $webViewExecutables = @(Get-ChildItem -LiteralPath $webViewExtractRoot -Recurse -File -Filter 'msedgewebview2.exe')
    if ($webViewExecutables.Count -ne 1) {
        throw "Fixed WebView2 runtime must contain exactly one msedgewebview2.exe; found $($webViewExecutables.Count)."
    }
    $webViewPayloadRoot = $webViewExecutables[0].Directory.FullName
    if (-not $webViewPayloadRoot.StartsWith($webViewExtractRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Fixed WebView2 payload escaped the extraction root: $webViewPayloadRoot"
    }
    Get-ChildItem -LiteralPath $webViewPayloadRoot -Force | ForEach-Object {
        Move-Item -LiteralPath $_.FullName -Destination $webViewRoot -Force
    }
}
finally {
    if (Test-Path -LiteralPath $webViewExtractRoot) {
        Remove-Item -LiteralPath $webViewExtractRoot -Recurse -Force
    }
}
if (-not (Test-Path -LiteralPath (Join-Path $webViewRoot 'msedgewebview2.exe') -PathType Leaf)) {
    throw 'Fixed WebView2 runtime did not contain msedgewebview2.exe.'
}

$applicationFiles = @(
    'main.py',
    'native_file_picker.py',
    'openshop_ai.py',
    'openshop_fonts.py',
    'openshop_image_ops.py',
    'openshop_projects.py'
)
foreach ($fileName in $applicationFiles) {
    $source = Join-Path $repoRoot $fileName
    $target = Join-Path $stageRoot (Join-Path 'app' $fileName)
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Force
}
foreach ($trackedRoot in @('hstar_runtime', 'voice_assistant')) {
    $tracked = @(Get-TrackedFiles -RelativeRoot $trackedRoot)
    if ($tracked.Count -eq 0) {
        throw "Tracked application package is empty: $trackedRoot"
    }
    foreach ($relativePath in $tracked) {
        if ($relativePath -match '(^|/)(__pycache__|tests?)(/|$)' -or $relativePath -match '\.(pyc|pyo)$') {
            continue
        }
        $source = Join-Path $repoRoot $relativePath
        $target = Join-Path (Join-Path $stageRoot 'app') $relativePath
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $target -Force
    }
}

foreach ($trackedRoot in @('static', 'workflows', 'API/defaults', 'CLI/windows')) {
    Copy-TrackedRoot -RelativeRoot $trackedRoot
}
foreach ($rootFile in @('VERSION', 'LICENSE')) {
    Copy-Item -LiteralPath (Join-Path $repoRoot $rootFile) -Destination (Join-Path $stageRoot $rootFile) -Force
}

$manifestRoot = Join-Path $stageRoot 'manifests'
$licenseRoot = Join-Path $stageRoot 'licenses'
New-Item -ItemType Directory -Path $manifestRoot, $licenseRoot -Force | Out-Null
Copy-Item -LiteralPath $lockPath -Destination (Join-Path $manifestRoot 'windows11-runtime.json') -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'LICENSE') -Destination (Join-Path $licenseRoot 'Hstar-LICENSE') -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'integrations\openshop\LICENSE') -Destination (Join-Path $licenseRoot 'OpenShop-LICENSE') -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'integrations\storyai-3d-director-desk\LICENSE') -Destination (Join-Path $licenseRoot 'StoryAI-3D-Director-LICENSE') -Force

$dataLayout = [ordered]@{
    schemaVersion = 1
    writableRoot = 'user-selected'
    directories = @(
        'config', 'secrets', 'projects/canvases', 'projects/openshop', 'projects/director',
        'assets', 'outputs', 'history', 'models', 'cache', 'logs', 'backups', 'temp'
    )
}
Write-Utf8NoBom -Path (Join-Path $stageRoot 'defaults\data-root-layout.json') -Content (($dataLayout | ConvertTo-Json -Depth 5) + "`n")

Invoke-Native -Command $embeddedPython -Arguments @(
    '-I',
    '-B',
    '-c',
    "import fastapi,uvicorn,PIL,httpx,websockets,fontTools; print('runtime-ok')"
)

$version = (Get-Content -LiteralPath (Join-Path $repoRoot 'VERSION') -Raw -Encoding UTF8).Trim()
$sourceCommit = (& git -C $repoRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[a-f0-9]{40}$') {
    throw 'Unable to resolve the exact source commit.'
}
$sourceCommitTime = (& git -C $repoRoot show -s --format=%cI $sourceCommit).Trim()
if ($LASTEXITCODE -ne 0) {
    throw 'Unable to resolve the source commit timestamp.'
}
$createdUtc = ([DateTimeOffset]::Parse($sourceCommitTime)).ToUniversalTime().ToString('o')
$runtimeLockHash = Get-LowerSha256 -Path $lockPath

$spdxPackages = @()
$spdxPackages += New-SpdxPackage `
    -Id 'Hstar' `
    -Name 'Hstar' `
    -Version $version `
    -License 'LicenseRef-Hstar-Restricted' `
    -DownloadLocation 'NOASSERTION' `
    -Checksums @((New-Sha256Checksum -Value (Get-LowerSha256 -Path (Join-Path $stageRoot 'VERSION'))))
$spdxPackages += New-SpdxPackage `
    -Id 'Hstar-Desktop' `
    -Name 'Hstar.Desktop' `
    -Version $version `
    -License 'LicenseRef-Hstar-Restricted' `
    -DownloadLocation 'NOASSERTION' `
    -Checksums @((New-Sha256Checksum -Value (Get-LowerSha256 -Path (Join-Path $stageRoot 'Hstar.exe'))))
$spdxPackages += New-SpdxPackage `
    -Id 'Python' `
    -Name 'Python' `
    -Version ([string]$runtimeLock.python.version) `
    -License 'PSF-2.0' `
    -DownloadLocation ([string]$runtimeLock.python.artifact.url) `
    -Checksums @((New-Sha256Checksum -Value ([string]$runtimeLock.python.artifact.sha256)))
$spdxPackages += New-SpdxPackage `
    -Id 'WebView2' `
    -Name 'Microsoft Edge WebView2' `
    -Version ([string]$runtimeLock.webView2.version) `
    -License 'NOASSERTION' `
    -DownloadLocation ([string]$runtimeLock.webView2.artifact.url) `
    -Checksums @((New-Sha256Checksum -Value ([string]$runtimeLock.webView2.artifact.sha256)))

$openShopPackage = Get-Content -LiteralPath (Join-Path $repoRoot 'integrations\openshop\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$directorPackage = Get-Content -LiteralPath (Join-Path $repoRoot 'integrations\storyai-3d-director-desk\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$spdxPackages += New-SpdxPackage `
    -Id 'OpenShop' `
    -Name 'OpenShop' `
    -Version ([string]$openShopPackage.version) `
    -License 'NOASSERTION' `
    -DownloadLocation 'NOASSERTION' `
    -Checksums @((New-Sha256Checksum -Value (Get-LowerSha256 -Path (Join-Path $stageRoot 'static\openshop\index.html'))))
$spdxPackages += New-SpdxPackage `
    -Id 'StoryAI-3D-Director' `
    -Name 'StoryAI 3D Director' `
    -Version ([string]$directorPackage.version) `
    -License ([string]$directorPackage.license) `
    -DownloadLocation 'NOASSERTION' `
    -Checksums @((New-Sha256Checksum -Value (Get-LowerSha256 -Path (Join-Path $stageRoot 'static\3d-director\index.html'))))

foreach ($package in $runtimeLock.packages) {
    $id = 'Python-' + (([string]$package.name) -replace '[^A-Za-z0-9.-]', '-')
    $spdxPackages += New-SpdxPackage `
        -Id $id `
        -Name ([string]$package.name) `
        -Version ([string]$package.version) `
        -License 'NOASSERTION' `
        -DownloadLocation ([string]$package.url) `
        -Checksums @((New-Sha256Checksum -Value ([string]$package.sha256)))
}

$vendorManifest = Get-Content -LiteralPath (Join-Path $repoRoot 'integrations\openshop\vendor\runtime-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$vendorGroups = @($vendorManifest.files | Group-Object -Property package, version)
foreach ($group in $vendorGroups) {
    $first = $group.Group | Select-Object -First 1
    $id = 'OpenShop-' + (([string]$first.package) -replace '[^A-Za-z0-9.-]', '-')
    $checksums = @($group.Group | ForEach-Object { New-Sha256Checksum -Value ([string]$_.sha256) })
    $sourceLocation = [string]$first.source
    if ($sourceLocation -notmatch '^https://') {
        $sourceLocation = 'NOASSERTION'
    }
    $spdxPackages += New-SpdxPackage `
        -Id $id `
        -Name ([string]$first.package) `
        -Version ([string]$first.version) `
        -License ([string]$first.license) `
        -DownloadLocation $sourceLocation `
        -Checksums $checksums
}

$relationships = @(
    [pscustomobject][ordered]@{
        spdxElementId = 'SPDXRef-DOCUMENT'
        relationshipType = 'DESCRIBES'
        relatedSpdxElement = 'SPDXRef-Hstar'
    }
)
foreach ($package in $spdxPackages | Where-Object { $_.SPDXID -ne 'SPDXRef-Hstar' }) {
    $relationships += [pscustomobject][ordered]@{
        spdxElementId = 'SPDXRef-Hstar'
        relationshipType = 'DEPENDS_ON'
        relatedSpdxElement = $package.SPDXID
    }
}
$sbom = [ordered]@{
    spdxVersion = 'SPDX-2.3'
    dataLicense = 'CC0-1.0'
    SPDXID = 'SPDXRef-DOCUMENT'
    name = "Hstar-Windows11-$version"
    documentNamespace = "https://hstar.local/spdx/windows11/$sourceCommit/$version"
    creationInfo = [ordered]@{
        created = $createdUtc
        creators = @('Tool: Hstar Windows 11 stage builder')
    }
    packages = @($spdxPackages)
    relationships = @($relationships)
}
$sbomPath = Join-Path $manifestRoot 'sbom.spdx.json'
Write-Utf8NoBom -Path $sbomPath -Content (($sbom | ConvertTo-Json -Depth 20) + "`n")

$release = [ordered]@{
    schemaVersion = 1
    product = 'Hstar'
    edition = 'windows11'
    architecture = 'x64'
    version = $version
    sourceCommit = $sourceCommit
    sourceTreeClean = (-not $AllowDirtyForTest.IsPresent)
    qualification = if ($AllowDirtyForTest) { 'test-dirty' } else { 'release' }
    sourceCommitTimeUtc = $createdUtc
    runtimeLockSha256 = $runtimeLockHash
    sbomSha256 = Get-LowerSha256 -Path $sbomPath
    fileCount = 0
    stageBytes = 0
    stageBytesExcludes = @('manifests/files.sha256')
}
$releasePath = Join-Path $manifestRoot 'release.json'
for ($iteration = 0; $iteration -lt 5; $iteration++) {
    Write-Utf8NoBom -Path $releasePath -Content (($release | ConvertTo-Json -Depth 10) + "`n")
    $payloadFiles = @(Get-ChildItem -LiteralPath $stageRoot -Recurse -File)
    $nextCount = $payloadFiles.Count
    $nextBytes = [long](($payloadFiles | Measure-Object -Property Length -Sum).Sum)
    if ($release.fileCount -eq $nextCount -and $release.stageBytes -eq $nextBytes) {
        break
    }
    $release.fileCount = $nextCount
    $release.stageBytes = $nextBytes
}
Write-Utf8NoBom -Path $releasePath -Content (($release | ConvertTo-Json -Depth 10) + "`n")

$hashLines = @()
$payloadFiles = @(Get-ChildItem -LiteralPath $stageRoot -Recurse -File | Sort-Object -Property FullName)
foreach ($file in $payloadFiles) {
    $relativePath = $file.FullName.Substring($stageRoot.Length + 1).Replace('\', '/')
    if ($relativePath -eq 'manifests/files.sha256') {
        continue
    }
    $hashLines += "$(Get-LowerSha256 -Path $file.FullName)  $relativePath"
}
Write-Utf8NoBom -Path (Join-Path $manifestRoot 'files.sha256') -Content (($hashLines -join "`n") + "`n")

Invoke-Native -Command 'powershell.exe' -Arguments @(
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $stageValidatorPath
)
Write-Host "Windows 11 stage created: $stageRoot"
