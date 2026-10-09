FROM ubuntu:22.04

ARG DEBIAN_FRONTEND=noninteractive
ARG NODE_VERSION=24.8.0
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl file libayatana-appindicator3-dev librsvg2-dev \
    libssl-dev libwebkit2gtk-4.1-dev libxdo-dev patchelf wget xdg-utils \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" | tar -xJ -C /usr/local --strip-components=1 \
    && corepack enable \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.97.0
ENV PATH=/root/.cargo/bin:$PATH
WORKDIR /src
RUN mkdir -p /root/.cache/tauri \
    && curl -fL --retry 10 --retry-all-errors -o /root/.cache/tauri/AppRun-x86_64 https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-x86_64 \
    && curl -fL --retry 10 --retry-all-errors -o /root/.cache/tauri/linuxdeploy-x86_64.AppImage https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy/linuxdeploy-x86_64.AppImage \
    && curl -fL --retry 10 --retry-all-errors -o /root/.cache/tauri/linuxdeploy-plugin-gtk.sh https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/master/linuxdeploy-plugin-gtk.sh \
    && chmod +x /root/.cache/tauri/*
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY apps/web apps/web
COPY scripts/native-config.mjs scripts/native-config.mjs
ARG VITE_API_BASE=http://localhost:8080
ARG NATIVE_IDENTIFIER=org.scratchwall.app
ENV VITE_API_BASE=$VITE_API_BASE NATIVE_IDENTIFIER=$NATIVE_IDENTIFIER
RUN node scripts/native-config.mjs
RUN pnpm --dir apps/web tauri build --config src-tauri/tauri.local.json --no-bundle \
    && mkdir -p /artifacts \
    && cp apps/web/src-tauri/target/release/scratchwall /artifacts/scratchwall
RUN pnpm --dir apps/web tauri build --config src-tauri/tauri.local.json --bundles appimage \
    && cp apps/web/src-tauri/target/release/bundle/appimage/*.AppImage /artifacts/
