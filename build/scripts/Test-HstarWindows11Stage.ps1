[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$stageRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'build\installer\stage\windows11')).TrimEnd('\')
$approvedParent = [IO.Path]::GetFullPath((Join-Path $repoRoot 'build\installer\stage')).TrimEnd('\')
if ((Split-Path -Parent $stageRoot) -ne $approvedParent -or (Split-Path -Leaf $stageRoot) -ne 'windows11') {
    throw "Unsafe Windows 11 stage path: $stageRoot"
}
if (-not (Test-Path -LiteralPath $stageRoot -PathType Container)) {
    throw "Windows 11 stage does not exist: $stageRoot"
}

function Get-StageRelativePath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not $resolved.StartsWith($stageRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Stage file escaped the approved root: $resolved"
    }
    return $resolved.Substring($stageRoot.Length + 1).Replace('\', '/')
}

function Require-StageFile {
    param([Parameter(Mandatory = $true)][string]$RelativePath)
    $path = Join-Path $stageRoot $RelativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required staged file is missing: $RelativePath"
    }
    return $path
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

function Get-PeSubsystem {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = [IO.File]::OpenRead($Path)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        $stream.Position = 0x3c
        $peOffset = $reader.ReadInt32()
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) {
            throw "Not a PE file: $Path"
        }
        $optionalHeader = $peOffset + 24
        $stream.Position = $optionalHeader
        $magic = $reader.ReadUInt16()
        if ($magic -notin 0x10b, 0x20b) {
            throw "Unsupported PE optional header: $Path"
        }
        $stream.Position = $optionalHeader + 0x44
        return $reader.ReadUInt16()
    }
    finally {
        $reader.Dispose()
        $stream.Dispose()
    }
}

$requiredFiles = @(
    'Hstar.exe',
    'Microsoft.Windows.SDK.NET.dll',
    'WinRT.Runtime.dll',
    'VERSION',
    'LICENSE',
    'app\main.py',
    'app\hstar_runtime\__init__.py',
    'app\voice_assistant\__init__.py',
    'API\defaults\api-providers.json',
    'workflows\Z-Image.json',
    'static\index.html',
    'static\js\desktop-shell-bridge.js',
    'static\openshop\index.html',
    'static\openshop\LICENSE',
    'static\3d-director\index.html',
    'static\3d-director\models\ue-mannequin-retopology.glb',
    'runtime\python\python.exe',
    'runtime\python\pythonw.exe',
    'runtime\python\python311._pth',
    'runtime\python\Lib\site-packages\fastapi\__init__.py',
    'runtime\voice-python\python.exe',
    'runtime\voice-python\pythonw.exe',
    'runtime\voice-python\python310._pth',
    'runtime\voice-python\Lib\site-packages\pip\__init__.py',
    'runtime\browser\WebView2\msedgewebview2.exe',
    'manifests\windows11-runtime.json',
    'manifests\files.sha256',
    'manifests\release.json',
    'manifests\sbom.spdx.json'
)
foreach ($relativePath in $requiredFiles) {
    Require-StageFile -RelativePath $relativePath | Out-Null
}

if ((Get-PeSubsystem -Path (Join-Path $stageRoot 'Hstar.exe')) -ne 2) {
    throw 'Hstar.exe must use the Windows GUI subsystem.'
}

$allFiles = @(Get-ChildItem -LiteralPath $stageRoot -Recurse -File)
$forbidden = @(
    '(^|/)\.git(/|$)',
    '(^|/)node_modules(/|$)',
    '(^|/)tests?(/|$)',
    '^tools/tests/',
    '^build/',
    '^data/',
    '^assets/(?:input|library|output|uploads)(/|$)',
    '^assets/startup/',
    '^output/',
    '^projects/',
    '^cache/',
    '^logs/',
    '^secrets/',
    '(^|/)__pycache__(/|$)',
    '(^|/)\.hstar-voice(/|$)',
    'FunAudioLLM/Fun-ASR-Nano-2512',
    '(^|/)voice-assistant-data(/|$)',
    '(^|/)\.cache/modelscope(/|$)',
    '(^|/)\.modelscope(/|$)',
    '(^|/)API/\.env$',
    '(^|/)config/api-providers\.json$',
    '(^|/)real-smoke-.*\.json$',
    '\.(pt|safetensors|wav|pcm|raw|webm|ogg|m4a|pyc|pyo)$',
    '(^|/)unins\d*\.(exe|dat)$'
)
foreach ($file in $allFiles) {
    $relativePath = Get-StageRelativePath -Path $file.FullName
    foreach ($pattern in $forbidden) {
        if ($relativePath -match $pattern) {
            throw "Forbidden staged payload: $relativePath"
        }
    }
    if ($file.Extension -ieq '.bin' -and $file.Length -gt 100MB) {
        throw "Oversized binary payload is not approved: $relativePath"
    }
}

$sourceLockPath = Join-Path $repoRoot 'build\runtime-locks\windows11-runtime.json'
$stagedLockPath = Join-Path $stageRoot 'manifests\windows11-runtime.json'
if ((Get-FileHash -LiteralPath $sourceLockPath -Algorithm SHA256).Hash -ne
    (Get-FileHash -LiteralPath $stagedLockPath -Algorithm SHA256).Hash) {
    throw 'Staged Windows 11 runtime lock differs from the source lock.'
}
$runtimeLock = Get-Content -LiteralPath $stagedLockPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($runtimeLock.edition -ne 'windows11' -or $runtimeLock.architecture -ne 'x64' -or $runtimeLock.pythonAbi -ne 'cp311') {
    throw 'Staged runtime lock has the wrong edition, architecture, or Python ABI.'
}

$manifestPath = Join-Path $stageRoot 'manifests\files.sha256'
$manifest = @{}
foreach ($line in Get-Content -LiteralPath $manifestPath -Encoding UTF8) {
    if ([string]::IsNullOrWhiteSpace($line)) {
        continue
    }
    if ($line -notmatch '^([a-f0-9]{64})  (.+)$') {
        throw "Invalid files.sha256 entry: $line"
    }
    $relativePath = $Matches[2]
    if ($manifest.ContainsKey($relativePath)) {
        throw "Duplicate files.sha256 path: $relativePath"
    }
    $manifest[$relativePath] = $Matches[1]
}

$expectedManifestFiles = @($allFiles |
    Where-Object { (Get-StageRelativePath -Path $_.FullName) -ne 'manifests/files.sha256' })
if ($manifest.Count -ne $expectedManifestFiles.Count) {
    throw "files.sha256 covers $($manifest.Count) files, expected $($expectedManifestFiles.Count)."
}
foreach ($file in $expectedManifestFiles) {
    $relativePath = Get-StageRelativePath -Path $file.FullName
    if (-not $manifest.ContainsKey($relativePath)) {
        throw "files.sha256 is missing: $relativePath"
    }
    $actualHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($manifest[$relativePath] -ne $actualHash) {
        throw "Staged file hash mismatch: $relativePath"
    }
}

$release = Get-Content -LiteralPath (Join-Path $stageRoot 'manifests\release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($release.edition -ne 'windows11' -or $release.architecture -ne 'x64') {
    throw 'Release manifest does not identify the Windows 11 x64 edition.'
}
if ([string]$release.sourceCommit -notmatch '^[a-f0-9]{40}$') {
    throw 'Release manifest source commit is invalid.'
}
if ([long]$release.fileCount -ne $manifest.Count -or [long]$release.stageBytes -le 0) {
    throw 'Release manifest file count or stage byte count is invalid.'
}

$sbom = Get-Content -LiteralPath (Join-Path $stageRoot 'manifests\sbom.spdx.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($sbom.spdxVersion -ne 'SPDX-2.3' -or $sbom.dataLicense -ne 'CC0-1.0') {
    throw 'SPDX document metadata is invalid.'
}
$sbomNames = @($sbom.packages | ForEach-Object { [string]$_.name })
foreach ($requiredName in @('Hstar', 'Hstar.Desktop', 'Python', 'Hstar Voice Python', 'Microsoft Edge WebView2', 'OpenShop', 'StoryAI 3D Director')) {
    if ($requiredName -notin $sbomNames) {
        throw "SPDX document is missing package: $requiredName"
    }
}
foreach ($dependency in $runtimeLock.packages) {
    $package = @($sbom.packages | Where-Object {
        ([string]$_.name).Equals([string]$dependency.name, [StringComparison]::OrdinalIgnoreCase)
    }) | Select-Object -First 1
    if (-not $package -or [string]$package.versionInfo -ne [string]$dependency.version) {
        throw "SPDX document is missing exact Python package: $($dependency.name)"
    }
    $checksum = @($package.checksums | Where-Object {
        $_.algorithm -eq 'SHA256' -and $_.checksumValue -eq $dependency.sha256
    })
    if ($checksum.Count -ne 1) {
        throw "SPDX checksum is missing for Python package: $($dependency.name)"
    }
}
if (($sbom | ConvertTo-Json -Depth 20) -match 'Fun-ASR-Nano|safetensors|model\.pt') {
    throw 'SPDX document must not include optional voice model weights.'
}

$python = Join-Path $stageRoot 'runtime\python\python.exe'
Invoke-Native -Command $python -Arguments @(
    '-I',
    '-B',
    '-c',
    "import fastapi,uvicorn,PIL,httpx,websockets,fontTools; print('runtime-ok')"
)
$voicePython = Join-Path $stageRoot 'runtime\voice-python\python.exe'
Invoke-Native -Command $voicePython -Arguments @(
    '-I',
    '-B',
    '-c',
    "import sys, pip, voice_assistant.service; assert sys.version_info[:2] == (3, 10); print('voice-runtime-ok')"
)

$validationParent = Join-Path $repoRoot 'tmp\windows11-stage-validation'
$validationData = Join-Path $validationParent ([Guid]::NewGuid().ToString('N'))
$resolvedValidation = [IO.Path]::GetFullPath($validationData)
$resolvedParent = [IO.Path]::GetFullPath($validationParent).TrimEnd('\')
if (-not $resolvedValidation.StartsWith($resolvedParent + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe stage validation data path: $resolvedValidation"
}
New-Item -ItemType Directory -Path $resolvedValidation -Force | Out-Null
$savedProgram = $env:HSTAR_PROGRAM_DIR
$savedData = $env:HSTAR_DATA_DIR
$savedEdition = $env:HSTAR_EDITION
try {
    $env:HSTAR_PROGRAM_DIR = $stageRoot
    $env:HSTAR_DATA_DIR = $resolvedValidation
    $env:HSTAR_EDITION = 'windows11'
    Invoke-Native -Command $python -Arguments @('-I', '-B', '-c', "import main; print('backend-import-ok')")
}
finally {
    $env:HSTAR_PROGRAM_DIR = $savedProgram
    $env:HSTAR_DATA_DIR = $savedData
    $env:HSTAR_EDITION = $savedEdition
    if (-not $resolvedValidation.StartsWith($resolvedParent + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing unsafe stage validation cleanup: $resolvedValidation"
    }
    if (Test-Path -LiteralPath $resolvedValidation) {
        Remove-Item -LiteralPath $resolvedValidation -Recurse -Force
    }
}

Write-Host "Windows 11 stage validation passed: $($allFiles.Count) files."
