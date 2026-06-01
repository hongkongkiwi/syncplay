# ── Syncplay P2P Docker image ──────────────────────────────────────
# Multi-stage build: produces a minimal image with all three binaries.
#
# Build:  docker build -t syncplay-p2p -f p2p/Dockerfile .
# Run signaling:  docker run -p 8998:8998 syncplay-p2p signaling
# Run TURN:       docker run -p 3478:3478/udp syncplay-p2p turn --public-ip <ip> --users user=pass
#
# For production TURN, consider using coturn instead:
#   docker run -d --network=host coturn/coturn

FROM rust:1.89-slim-bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY p2p/rust/Cargo.toml p2p/rust/Cargo.lock* ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs \
    && echo 'fn main() {}' > src/tui_main.rs \
    && echo 'fn main() {}' > src/turn_main.rs \
    && mkdir -p tests && echo '' > tests/e2e_integration.rs
RUN cargo build --release --bin syncplay-signaling \
    && cargo build --release --bin syncplay-turn \
    && rm -rf src target

COPY p2p/rust/ .
RUN cargo build --release --bin syncplay-signaling \
    && cargo build --release --features tui --bin syncplay-tui \
    && cargo build --release --bin syncplay-turn

# ── Runtime image ──────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/target/release/syncplay-signaling /usr/local/bin/
COPY --from=builder /build/target/release/syncplay-tui /usr/local/bin/
COPY --from=builder /build/target/release/syncplay-turn /usr/local/bin/

EXPOSE 8998 3478/udp

ENTRYPOINT ["syncplay-signaling"]
CMD []
