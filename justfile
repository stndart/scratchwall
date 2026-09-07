# Force PowerShell on Windows so recipes don't go through Git Bash's `sh`,
# which otherwise applies MSYS path translation and breaks bind mounts.
set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

[doc("List recipes")]
default:
    @just --list

[doc("Pass-through to docker compose (quote flags: just compose -- logs -f scratchwall)")]
compose *args:
    docker compose {{args}}

[doc("Build Windows/Android/Linux apps into artifacts/ and publish them to data/downloads")]
build:
    .\scripts\build-release.ps1

[doc("Build only Windows NSIS + portable EXE, then publish")]
build-windows:
    .\scripts\build-release.ps1 -Windows

[doc("Build only the universal Android APK, then publish")]
build-android:
    .\scripts\build-release.ps1 -Android

[doc("Build only Linux ELF + AppImage via Docker, then publish")]
build-linux:
    .\scripts\build-release.ps1 -Linux

[doc("Build the Telegram bot Linux ELF into artifacts/linux")]
build-telegram:
    docker build -f build/telegram-bot.Dockerfile -t scratchwall-telegram-builder .
    New-Item -ItemType Directory -Force -Path artifacts\linux | Out-Null
    docker create --name scratchwall-telegram-artifacts scratchwall-telegram-builder
    docker cp scratchwall-telegram-artifacts:/artifacts/scratchwall-telegram artifacts/linux/scratchwall-telegram
    docker rm scratchwall-telegram-artifacts
