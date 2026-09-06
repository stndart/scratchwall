param(
  [switch]$Windows,
  [switch]$Android,
  [switch]$Linux
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

$buildWindows = $Windows -or (-not ($Windows -or $Android -or $Linux))
$buildAndroid = $Android -or (-not ($Windows -or $Android -or $Linux))
$buildLinux = $Linux -or (-not ($Windows -or $Android -or $Linux))

$artifactDir = Join-Path $root 'artifacts'
$downloadDir = Join-Path $root 'data\downloads'
New-Item -ItemType Directory -Force -Path $artifactDir, $downloadDir | Out-Null

$tauriConf = Get-Content -LiteralPath (Join-Path $root 'apps\web\src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$version = $tauriConf.version
$catalog = [ordered]@{
  'scratchwall.exe' = "Scratchwall_portable"
  "Scratchwall_${version}_x64-setup.exe" = "Windows installer"
  'Scratchwall-universal-release.apk' = "Android APK"
  "Scratchwall_${version}_amd64.AppImage" = "Linux AppImage"
  'scratchwall' = "Linux ELF"
}

function Invoke-Pnpm {
  param([Parameter(Mandatory = $true)][string[]]$PnpmArgs)
  Write-Host "pnpm $($PnpmArgs -join ' ')"
  $corepack = Get-Command corepack -ErrorAction SilentlyContinue
  if ($corepack) { & corepack pnpm @PnpmArgs } else { & pnpm @PnpmArgs }
  if ($LASTEXITCODE -ne 0) { throw "pnpm $($PnpmArgs -join ' ') failed ($LASTEXITCODE)" }
}

function Copy-BuiltFile {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Name
  )
  if (-not (Test-Path -LiteralPath $Source)) { throw "Missing build output: $Source" }
  $destination = Join-Path $artifactDir $Name
  Copy-Item -LiteralPath $Source -Destination $destination -Force
  Write-Host "staged $Name"
}

function Initialize-AndroidEnv {
  if (-not $env:ANDROID_HOME) {
    $defaultSdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
    if (Test-Path -LiteralPath $defaultSdk) { $env:ANDROID_HOME = $defaultSdk }
  }
  $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
  if (-not $env:ANDROID_HOME -or -not (Test-Path -LiteralPath $env:ANDROID_HOME)) {
    throw 'ANDROID_HOME is not set and the default Android SDK was not found.'
  }
  if (-not $env:NDK_HOME) {
    $ndkRoot = Join-Path $env:ANDROID_HOME 'ndk'
    $ndk = Get-ChildItem -LiteralPath $ndkRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
    if ($ndk) { $env:NDK_HOME = $ndk.FullName }
  }
  if (-not $env:JAVA_HOME) {
    $javaCandidates = @('G:\Program Files\Java\jdk-21')
    if ($env:ProgramFiles) { $javaCandidates += (Join-Path $env:ProgramFiles 'Java\jdk-21') }
    foreach ($candidate in $javaCandidates) {
      if (Test-Path -LiteralPath $candidate) { $env:JAVA_HOME = $candidate; break }
    }
  }
  if ($env:JAVA_HOME) { $env:PATH = "$($env:JAVA_HOME)\bin;$env:PATH" }
  if (-not $env:SCRATCHWALL_ANDROID_SIGNING_PROPERTIES) {
    $signing = Join-Path $env:USERPROFILE '.scratchwall\android-signing.properties'
    if (Test-Path -LiteralPath $signing) { $env:SCRATCHWALL_ANDROID_SIGNING_PROPERTIES = $signing }
  }
  if (-not $env:SCRATCHWALL_ANDROID_SIGNING_PROPERTIES) {
    throw 'Set SCRATCHWALL_ANDROID_SIGNING_PROPERTIES to the Android release keystore properties file.'
  }
}

if ($buildWindows) {
  Write-Host '==> Windows NSIS + portable EXE'
  Invoke-Pnpm -PnpmArgs @('--dir', 'apps/web', 'tauri', 'build', '--bundles', 'nsis')
  Copy-BuiltFile -Source (Join-Path $root 'apps\web\src-tauri\target\release\scratchwall.exe') -Name 'scratchwall.exe'
  Copy-BuiltFile -Source (Join-Path $root "apps\web\src-tauri\target\release\bundle\nsis\Scratchwall_${version}_x64-setup.exe") -Name "Scratchwall_${version}_x64-setup.exe"
}

if ($buildAndroid) {
  Write-Host '==> Android universal APK'
  Initialize-AndroidEnv
  Invoke-Pnpm -PnpmArgs @('--dir', 'apps/web', 'tauri', 'android', 'build', '--apk', '--target', 'aarch64', 'armv7', 'i686', 'x86_64')
  $apkRoot = Join-Path $root 'apps\web\src-tauri\gen\android\app\build\outputs\apk'
  $apk = Get-ChildItem -LiteralPath $apkRoot -Recurse -Filter '*.apk' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'universal' -and $_.Name -match 'release' -and $_.Name -notmatch 'unsigned' } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $apk) {
    $apk = Get-ChildItem -LiteralPath $apkRoot -Recurse -Filter '*release*.apk' -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -notmatch 'unsigned' } |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
  }
  if (-not $apk) { throw "No signed release APK found under $apkRoot" }
  Copy-BuiltFile -Source $apk.FullName -Name 'Scratchwall-universal-release.apk'
}

if ($buildLinux) {
  Write-Host '==> Linux ELF + AppImage (Ubuntu 22.04)'
  docker rm -f scratchwall-linux-artifacts 2>$null | Out-Null
  docker build -f build/linux.Dockerfile -t scratchwall-linux-builder .
  if ($LASTEXITCODE -ne 0) { throw "Linux image build failed ($LASTEXITCODE)" }
  docker create --name scratchwall-linux-artifacts scratchwall-linux-builder | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "docker create failed ($LASTEXITCODE)" }
  try {
    docker cp 'scratchwall-linux-artifacts:/artifacts/.' "$artifactDir\"
    if ($LASTEXITCODE -ne 0) { throw "docker cp failed ($LASTEXITCODE)" }
  } finally {
    docker rm -f scratchwall-linux-artifacts | Out-Null
  }
  $appImage = Get-ChildItem -LiteralPath $artifactDir -Filter '*.AppImage' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $canonicalAppImage = Join-Path $artifactDir "Scratchwall_${version}_amd64.AppImage"
  if (-not $appImage) { throw 'Linux build did not produce an AppImage' }
  if ($appImage.FullName -ne $canonicalAppImage) {
    Move-Item -LiteralPath $appImage.FullName -Destination $canonicalAppImage -Force
  }
  if (-not (Test-Path -LiteralPath (Join-Path $artifactDir 'scratchwall'))) {
    throw 'Linux build did not produce the scratchwall ELF'
  }
}

& (Join-Path $PSScriptRoot 'checksums.ps1') -ArtifactDirectory $artifactDir

$missing = @()
foreach ($name in $catalog.Keys) {
  $source = Join-Path $artifactDir $name
  if (Test-Path -LiteralPath $source) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $downloadDir $name) -Force
  } else {
    $missing += "$($catalog[$name]) ($name)"
  }
}
Copy-Item -LiteralPath (Join-Path $artifactDir 'SHA256SUMS.txt') -Destination (Join-Path $downloadDir 'SHA256SUMS.txt') -Force

$missingList = $missing -join "`n - "
if ($missing -and -not ($Windows -or $Android -or $Linux)) {
  throw "Release catalog is incomplete:`n - $missingList"
}
if ($missing) {
  Write-Warning "Published a partial catalog. Missing:`n - $missingList"
}

$published = $catalog.Count - $missing.Count
Write-Host "Published $published artifacts to artifacts\ and data\downloads\"
Write-Host 'scratch.morad.uk will serve them from /downloads/ (data volume is bind-mounted).'
