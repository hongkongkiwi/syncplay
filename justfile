# ─── Syncplay P2P ───────────────────────────────────────────────────
# https://github.com/casey/just — a handy way to save and run commands
#
# Usage: just [recipe]

default: check test clippy

# ── Build ──────────────────────────────────────────────────────────

# Build all binaries (lib + signaling + tui)
build:
    cargo build --features tui

# Build in release mode
release:
    cargo build --release --features tui

# ── Check & Lint ───────────────────────────────────────────────────

# Type-check only (no codegen)
check:
    cargo check --features tui

# Run all unit tests
test:
    cargo test --lib

# Run tests with output
test-verbose:
    cargo test --lib -- --nocapture

# Lint with clippy (treat warnings as errors)
clippy:
    cargo clippy --features tui --lib -- -D warnings

# Fix auto-fixable clippy warnings
clippy-fix:
    cargo clippy --features tui --lib --fix --allow-dirty

# Format code
fmt:
    cargo fmt --check

# Format code in-place
fmt-fix:
    cargo fmt

# All checks: format + check + test + clippy
all: fmt check test clippy

# ── Run ────────────────────────────────────────────────────────────

# Start the signaling server (default port 8998)
run-signaling:
    cargo run --bin syncplay-signaling

# Start the terminal UI client
run-tui room="syncplay-tui" signaling="ws://localhost:8998" username="" password="" file="":
    cargo run --bin syncplay-tui --features tui -- \
        --room "{{room}}" \
        --signaling "{{signaling}}" \
        --username "{{username}}" \
        --password "{{password}}" \
        --file "{{file}}"

# Run signaling + TUI together (requires tmux)
dev:
    tmux new-session -d -s syncplay 'cargo run --bin syncplay-signaling' \; \
        split-window -h 'sleep 1 && cargo run --bin syncplay-tui --features tui -- --room dev --username alice' \; \
        split-window -v 'sleep 2 && cargo run --bin syncplay-tui --features tui -- --room dev --username bob' \; \
        attach-session

# ── Watch ──────────────────────────────────────────────────────────

# Watch for changes and re-check
watch:
    cargo watch -x 'check --features tui'

# Watch for changes and re-test
watch-test:
    cargo watch -x 'test --lib'

# Watch and run clippy
watch-clippy:
    cargo watch -x 'clippy --features tui --lib -- -D warnings'

# ── Docs ───────────────────────────────────────────────────────────

# Generate and open docs
docs:
    cargo doc --features tui --open

# ── Clean ──────────────────────────────────────────────────────────

# Clean build artifacts
clean:
    cargo clean

# Deep clean (including cargo registry cache)
clean-all: clean
    rm -rf ~/.cargo/registry/cache
