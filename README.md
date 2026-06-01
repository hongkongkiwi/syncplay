# Syncplay

Synchronized video playback across multiple instances of mpv, VLC, MPC-HC, MPC-BE and mplayer2 over the Internet.

## P2P Rust Client (v2.0)

The next-generation Syncplay is a **pure Rust P2P stack** that replaces the central server architecture with WebRTC data channels, a lightweight signaling relay, and an integrated TURN relay server — all in one crate.

```
syncplay-tui          Terminal UI client (ratatui)
syncplay-signaling    WebSocket signaling relay
syncplay-turn         TURN relay for NAT traversal
```

See **[p2p/README.md](p2p/README.md)** for setup, keybindings, and slash commands.  
Full protocol spec: **[docs/webrtc-p2p-protocol.md](docs/webrtc-p2p-protocol.md)**

### Quick install

```bash
cd p2p/rust
cargo build --release --features tui

# Start signaling server
./target/release/syncplay-signaling

# Start TURN relay (for peers behind NAT)
./target/release/syncplay-turn --public-ip <your-ip> --users alice=pass,bob=pass

# Join a room
./target/release/syncplay-tui --room movie-night --username alice --voice
```

### Development

```bash
cd p2p/rust
cargo test --lib          # 91 unit tests
cargo test --test e2e_integration  # 10 integration tests
cargo clippy --features tui --all-targets -- -D warnings

# Or use just:
just build      # debug build
just release    # release build
just test       # run tests
just clippy     # lint
just all        # fmt + check + test + clippy
just dev        # tmux: signaling + two TUI clients
```

## Original Python Syncplay

The original Python Syncplay server and client remain available and fully functional.  
Official site: https://syncplay.pl  
Downloads: https://syncplay.pl/download/

## Mobile client

An Expo React Native mobile client lives in [`react-native/`](react-native/README.md). It can connect to a Syncplay server, join rooms, pick local media or stream URLs, use shared playlists, chat, and apply playback sync through the native mobile player.

The mobile app needs a native development build. Expo Go cannot run it because the TCP socket, file-system, video, and local storage pieces use native modules.

## Web client

A browser client lives in [`web-client/`](web-client/README.md). It uses TanStack Start and pnpm, plays local media through the browser video element, and talks to Syncplay through a WebSocket bridge because browsers cannot open raw TCP sockets.

```sh
pnpm install
pnpm --filter syncplay-web-client dev
```

## What it does

Syncplay synchronises the position and play state of multiple media players so that the viewers can watch the same thing at the same time. When one person pauses/unpauses playback or seeks within their media player, this is replicated across all media players connected to the same room. New joiners are synchronised automatically. Includes text chat and voice chat (P2P edition).

## What it doesn't do

Syncplay is not a file sharing service. The P2P edition supports file transfers for shared watching but only within a room of mutually trusted peers.

## License

Licensed under the [Apache License, version 2.0](https://www.apache.org/licenses/LICENSE-2.0.html). See LICENSE.

## Authors

- *Initial concept and core internals developer* - Uriziel.
- *GUI design and current lead developer* - Et0h.
- *Original SyncPlay code* - Tomasz Kowalczyk (Fluxid).
- *P2P Rust rewrite* - [hongkongkiwi](https://github.com/hongkongkiwi)
- *Other contributors* - See http://syncplay.pl/about/development/
