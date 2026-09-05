$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$env:ANDROID_HOME = 'C:\Users\Svyat\AppData\Local\Android\Sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:NDK_HOME = 'C:\Users\Svyat\AppData\Local\Android\Sdk\ndk\27.2.12479018'
$env:JAVA_HOME = 'G:\Program Files\Java\jdk-21'
$env:SCRATCHWALL_ANDROID_SIGNING_PROPERTIES = 'C:\Users\Svyat\.scratchwall\android-signing.properties'
$runtimeBin = 'C:\Users\Svyat\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback'
$env:PATH = "$runtimeBin;$env:PATH"

Set-Location -LiteralPath $projectRoot
New-Item -ItemType Directory -Force -Path 'artifacts' | Out-Null
$ErrorActionPreference = 'Continue'
& (Join-Path $runtimeBin 'pnpm.cmd') --dir apps/web tauri android build --apk --target aarch64 armv7 i686 x86_64 *> 'artifacts\android-build.log'
$buildExitCode = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
exit $buildExitCode
