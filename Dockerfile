FROM node:24-bookworm-slim AS web
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY apps/web apps/web
RUN pnpm --filter @scratchwall/web build

FROM rust:1.97-bookworm AS server
WORKDIR /src
COPY server/Cargo.toml server/Cargo.lock* ./server/
COPY server/src ./server/src
RUN cargo build --manifest-path server/Cargo.toml --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=server /src/server/target/release/scratchwall-server /usr/local/bin/scratchwall-server
COPY --from=web /src/apps/web/dist /app/web
ENV LISTEN_ADDR=0.0.0.0:8080 DATA_DIR=/data WEB_DIR=/app/web
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["scratchwall-server"]

