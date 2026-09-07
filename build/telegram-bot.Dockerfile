FROM rust:1.97-bullseye
WORKDIR /src/bot
COPY bot/Cargo.toml bot/Cargo.lock ./
COPY bot/src ./src
RUN cargo build --release \
    && mkdir -p /artifacts \
    && cp target/release/scratchwall-telegram /artifacts/scratchwall-telegram \
    && file /artifacts/scratchwall-telegram
