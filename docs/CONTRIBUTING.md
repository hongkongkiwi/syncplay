# Contributing to Syncplay P2P

## Development Setup

### Prerequisites

- **Rust** 1.70+ with `cargo`
- **Node.js** 20+ with `pnpm` (for web-client and shared library)
- **React Native** — Expo CLI 56, Xcode 16+ (iOS), Android Studio (Android)
- **Optional:** `just` command runner (`brew install just` or `cargo install just`)

### Clone & Install

```bash
git clone https://github.com/hongkongkiwi/syncplay.git
cd syncplay

# Rust
cd p2p/rust
cargo build

# Shared P2P library + Web client
cd ../..  # back to repo root
pnpm install
```

### Rust Development

```bash
cd p2p/rust

# Build all binaries (debug)
cargo build --features tui

# Build release
cargo build --release --features tui

# Run tests
cargo test --lib                    # 91 unit tests
cargo test --test e2e_integration   # 10 integration tests

# Lint
cargo clippy --features tui --all-targets -- -D warnings

# Format
cargo fmt --all -- --check

# Using just (recommended):
just build      # debug build
just release    # release build
just test       # run all tests
just clippy     # lint
just all        # fmt + check + test + clippy
just dev        # tmux: signaling + two TUI clients
```

### Web Client Development

```bash
# From repo root
cd web-client
pnpm dev              # Start dev server on http://localhost:3000

# Tests
pnpm test             # Unit tests
pnpm test:e2e         # Playwright E2E tests (65 tests)

# Build
pnpm build            # Production build
pnpm start            # Serve production build
```

### React Native Development

```bash
# From repo root
cd react-native
npm install

# iOS
npm run ios

# Android
npm run android

# Tests
npm test -- --watch=false          # 12 RN tests + 2 helpers

# Type check
npm run typecheck

# Dependency audit
npx expo install --check

# Android debug build
cd android && ./gradlew :app:assembleDebug
```

### Shared P2P Library

```bash
# The shared library lives in packages/p2p-client
# It's a workspace dependency used by both web-client and react-native

cd packages/p2p-client
pnpm test             # Run state machine and protocol tests
pnpm build            # Build the library
```

## Project Structure

```
syncplay/
├── packages/
│   └── p2p-client/           # Shared P2P protocol library
│       └── src/
│           ├── messages.ts   # 22 message types, payloads, builders
│           ├── wire.ts       # MessagePack binary encoding
│           ├── state.ts      # P2PStateManager (1441 lines)
│           ├── discovery.ts  # PeerDiscovery (HTTP rooms + mDNS)
│           └── index.ts      # Public API re-exports
├── web-client/               # TanStack Start web client
│   ├── src/
│   │   ├── routes/           # Page routes (index.tsx)
│   │   └── syncplay/         # connectionV2.ts, voiceChat.ts, syncControl.ts
│   └── e2e/                  # Playwright E2E tests
├── react-native/             # Expo React Native client
│   ├── src/
│   │   ├── app/              # syncControl.ts, playlistPlayback.ts, directoryScanner.ts
│   │   ├── navigation/       # Tab navigation
│   │   └── syncplay/         # connectionV2.ts, voiceChat.ts
│   └── __tests__/            # Jest tests
├── p2p/
│   └── rust/                 # Rust crate (3 binaries)
│       ├── src/
│       │   ├── main.rs        → syncplay-signaling
│       │   ├── tui_main.rs    → syncplay-tui
│       │   ├── turn_main.rs   → syncplay-turn
│       │   ├── sync.rs        — State sync (1563 lines)
│       │   ├── connection.rs  — WebRTC manager (1465 lines)
│       │   ├── signalling.rs  — WebSocket relay
│       │   ├── file_transfer.rs
│       │   ├── voice_chat.rs
│       │   ├── player.rs
│       │   ├── player_controller.rs
│       │   ├── tui.rs
│       │   └── ...
│       └── tests/
│           └── e2e_integration.rs
└── docs/
    ├── PROTOCOL.md
    ├── ARCHITECTURE.md
    ├── API.md
    ├── CONTRIBUTING.md
    ├── file-transfers.md
    └── webrtc-p2p-protocol.md  (legacy)
```

## Running Tests

### All Tests

```bash
# Rust
cd p2p/rust && cargo test

# Web client
cd web-client && pnpm test && pnpm test:e2e

# React Native
cd react-native && npm test -- --watch=false

# Total: 324 tests (245 Rust + 65 JS E2E + 12 RN + 2 RN helpers)
```

### Test Coverage

- **Rust** (245 tests): 91 unit + 10 integration + wire tests + signaling tests
- **Web E2E** (65): Playwright tests for connection, chat, playback sync
- **React Native** (14): 12 component tests + 2 helper tests

## Pre-commit Hooks

The project uses [lefthook](https://github.com/evilmartians/lefthook) for Git hooks.

```bash
# Install hooks
lefthook install
```

### Pre-commit (staged files)
- `cargo fmt --all -- --check` (Rust)
- `cargo check --features tui` (Rust)
- `pnpm lint` (JS/TS)

### Pre-push
- `cargo clippy --features tui --all-targets -- -D warnings`
- `cargo test --lib`
- `pnpm test`

## Coding Guidelines

### Rust
- Follow standard Rust conventions (`cargo fmt`, `cargo clippy`)
- Use `thiserror` for error types
- Message types in `messages.rs` must stay in sync with JS `packages/p2p-client/src/messages.ts`
- Wire format must remain compatible with MessagePack spec

### TypeScript
- Follow the existing patterns in `P2PStateManager`
- All message types, payloads, and builders must mirror Rust `messages.rs`
- Use strict TypeScript with explicit types
- Run `pnpm lint` before committing

### Synchronizing Message Types

When adding a new message type:
1. Add to `p2p/rust/src/messages.rs` (Rust enum + payload struct + builder)
2. Add to `packages/p2p-client/src/messages.ts` (TypeScript enum + interface + builder + PAYLOAD_BY_TYPE entry)
3. Add handler in `packages/p2p-client/src/state.ts` dispatch method
4. Add handler in `p2p/rust/src/sync.rs`
5. Add to protocol docs in `docs/PROTOCOL.md`
6. Update `docs/API.md` if it's a public API

## Documentation

- Protocol changes: update `docs/PROTOCOL.md`
- Architecture changes: update `docs/ARCHITECTURE.md`
- Public API changes: update `docs/API.md`
- Rust-specific docs: `p2p/README.md`
- Web client docs: `web-client/README.md`
- React Native docs: `react-native/README.md`

## Pull Request Checklist

- [ ] Tests pass for all affected platforms
- [ ] Message types synchronized between Rust and TypeScript
- [ ] Protocol docs updated if message format changed
- [ ] No clippy warnings in Rust (`cargo clippy -- -D warnings`)
- [ ] No lint errors in TypeScript (`pnpm lint`)
- [ ] Pre-commit hooks pass (`lefthook run pre-commit`)
- [ ] Cross-client compatibility verified (Rust ↔ Web ↔ React Native)

## Getting Help

- Issues: [GitHub Issues](https://github.com/hongkongkiwi/syncplay/issues)
- Protocol questions: See `docs/PROTOCOL.md`
- Architecture questions: See `docs/ARCHITECTURE.md`
