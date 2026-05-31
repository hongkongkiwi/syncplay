# Syncplay P2P

Pure Rust peer-to-peer media synchronization — WebRTC data channels,
host-authoritative playstate sync, and a ratatui terminal UI.
One crate compiles to two binaries: a signaling server and a TUI client.

## Architecture

```
p2p/rust/                  ← single Rust crate (edition 2021)
  src/
    main.rs                → syncplay-signaling  (WebSocket relay)
    tui_main.rs            → syncplay-tui        (ratatui client, --features tui)
    messages.rs            — 20 message types (0x01–0x13) + payloads + builders
    wire.rs                — MessagePack framing (17 tests)
    connection.rs          — WebRTC ICE/STUN/TURN, signaling handshake, peer lifecycle
    sync.rs                — Host-authoritative state sync, controller gating
    signalling.rs          — WebSocket server: rooms, SDP/ICE relay, host migration
    file_transfer.rs       — Streaming chunked transfer (256KB), SHA-256, subtitles
    voice_chat.rs          — Opus 48kHz, cpal mic capture, mute toggle
    player.rs              — Cross-platform detection (8 players)
    player_controller.rs   — mpv JSON IPC + VLC RC interface
    config.rs              — P2pConfig: STUN/TURN/download_dir/voice/player
    tui.rs                 — ratatui 6-panel adaptive layout, emoji, slash commands
    error.rs               — WireError, ConnectionError, SyncError (thiserror)
    lib.rs                 — Crate root, re-exports
  tests/
    e2e_integration.rs     — 10 integration tests (wire, config, signaling)
  docs/
    webrtc-p2p-protocol.md — Full protocol specification
```

## Quick Start

### Build

```bash
cd p2p/rust
cargo build --release --features tui    # both binaries in target/release/
# or use the justfile at repo root:
just release
```

### Run the signaling server

```bash
./target/release/syncplay-signaling
# → Syncplay signaling server v2.0.0-alpha.1, listening on 127.0.0.1:8998

# Custom port / bind:
./target/release/syncplay-signaling --port 9000 --bind 0.0.0.0
```

### Run the TUI client

```bash
./target/release/syncplay-tui --room movie-night --username alice

# With voice chat, custom signaling, and a file:
./target/release/syncplay-tui \
    --room movie-night \
    --username alice \
    --signaling ws://my-server:8998 \
    --file ~/Videos/movie.mkv \
    --voice
```

## Protocol

20 message types over length-prefixed MessagePack frames on WebRTC data channels.
Host-authoritative with controller delegation.
See [docs/webrtc-p2p-protocol.md](../docs/webrtc-p2p-protocol.md).

## Development

```bash
just check               # cargo check --features tui
just test                # cargo test --lib (81 tests)
just clippy              # cargo clippy --all-targets -- -D warnings
just all                 # fmt + check + test + clippy
just dev                 # tmux: signaling + two TUI clients

# Git hooks (lefthook):
lefthook install         # pre-commit: fmt+check, pre-push: clippy+test+doc
```

## TUI Keybindings

| Key | Action |
|-----|--------|
| `q` / `Esc` | Quit |
| `?` | Toggle help |
| `Space` | Toggle ready |
| `p` | Play / Pause |
| `s` / `a` | Seek ±10s |
| `m` | Mute mic |
| `Tab` | Toggle voice |
| `Enter` | Send chat |
| `↑` / `↓` | Chat history |
| `PgUp` / `PgDn` | Scroll chat |
| `j` / `k` | Scroll playlist |

### Slash Commands

| Command | Action |
|---------|--------|
| `/help` | List commands |
| `/send <file>` | Send file to peers |
| `/file <path>` | Load file in player |
| `/playlist add <files>` | Add to playlist |
| `/playlist index <n>` | Jump to item |
| `/controller add <name>` | Grant control (host only) |
| `/controller remove <name>` | Revoke control (host only) |
| `/ready` | Toggle ready |
| `/react <n> :emoji:` | React to message |
| `/settings` | Show connection info |
| `/shrug` / `/tableflip` / `/lenny` | Memes |
