FROM rust:1.97-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends musl-tools musl-dev \
    && rustup target add x86_64-unknown-linux-musl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src/bot
COPY bot/Cargo.toml bot/Cargo.lock ./
COPY bot/src ./src
ENV CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=musl-gcc
ENV RUSTFLAGS=-Ctarget-feature=+crt-static
RUN cargo build --release --target x86_64-unknown-linux-musl \
    && mkdir -p /artifacts \
    && cp target/x86_64-unknown-linux-musl/release/scratchwall-telegram /artifacts/scratchwall-telegram
