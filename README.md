# Syncplay P2P v2.0

Synchronized video playback across multiple platforms using WebRTC peer-to-peer data channels with a lightweight signaling relay.

## Clients

| Client | Platform | Protocol | Status |
|--------|----------|----------|--------|
| Rust TUI | Linux/macOS/Windows | v2.0.0 P2P | ✅ |
| Web | Any browser | v2.0.0 P2P | ✅ |
| React Native | iOS/Android | v2.0.0 P2P | ✅ |

## Quick Start

### Web Client (easiest)
1. Start signaling server: `cd p2p/rust && cargo run --bin syncplay-signaling`
2. Start web client: `cd web-client && pnpm dev`
3. Open http://localhost:3000

### Rust TUI
```bash
cd p2p/rust
cargo build --release --features tui
./target/release/syncplay-signaling &
./target/release/syncplay-tui --room movienight --username alice
```

### React Native
```bash
cd react-native
npm install
npx expo start
```

## Features

- 22 message types over binary MessagePack protocol
- Speed sync (0.5x / 1x / 2x)
- Latency compensation with per-peer RTT tracking
- Controller access control (host-managed permissions)
- State replay for late-joining peers
- File transfer with SHA-256 verification
- Subtitle auto-detection and bundling
- Voice chat via Opus codec
- SFU mode for large rooms
- TURN relay support for NAT traversal
- Dark/light mode
- Keyboard shortcuts

## Documentation

- [Protocol Specification](docs/PROTOCOL.md)
- [Architecture Overview](docs/ARCHITECTURE.md)
- [API Reference](docs/API.md)
- [Rust Client Guide](p2p/README.md)
- [Contributing](docs/CONTRIBUTING.md)

## Tests

324 tests: 245 Rust + 65 JS E2E + 12 RN + 2 RN helpers

## License

Licensed under the [Apache License, version 2.0](https://www.apache.org/licenses/LICENSE-2.0.html). See LICENSE.

## Authors

- *Initial concept and core internals developer* - Uriziel
- *GUI design and current lead developer* - Et0h
- *Original SyncPlay code* - Tomasz Kowalczyk (Fluxid)
- *P2P rewrite* - [hongkongkiwi](https://github.com/hongkongkiwi)
- *Other contributors* - See http://syncplay.pl/about/development/
