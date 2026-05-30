# Syncplay P2P

WebRTC-based peer-to-peer media synchronization. Replaces the original
Twisted TCP server with a single Rust crate that serves as both a
lightweight signaling server and a Python-native client library.

## Architecture

```
p2p/rust/          ← single Rust crate
  src/
    messages.rs     — 17 message types + payload structs + builders
    wire.rs         — MessagePack framing (17 tests)
    connection.rs   — WebRTC connection manager + signaling client
    sync.rs         — Host-authoritative state sync manager
    signalling.rs   — WebSocket signaling server (~250 lines)
    python.rs       — PyO3 bindings → `import syncplay_p2p`
    lib.rs          — Crate root
    main.rs         — `syncplay-signaling` binary
```

## Quick Start

### Build the signaling server

```bash
cd p2p/rust
cargo build --release --bin syncplay-signaling
./target/release/syncplay-signaling
# → [signaling] listening on 127.0.0.1:8998
```

### Build the Python module

```bash
cd p2p/rust
python3 -m venv venv && source venv/bin/activate
pip install maturin
maturin develop --release
python3 -c "import syncplay_p2p; print('OK')"
```

### Use from Python

```python
import asyncio
import syncplay_p2p

async def main():
    # Create/join a room
    conn = syncplay_p2p.ConnectionManager("alice", ["chat", "readiness"])
    await conn.connect("ws://localhost:8998", "movie-night")

    # Start syncing
    sync = syncplay_p2p.SyncManager(conn)
    await sync.start()

    # Host controls playback
    sync.update_playstate(123.45, paused=False)   # broadcast position
    await sync.send_chat("hello!")
    await sync.set_ready(True)
    await sync.request_seek(300.0)

    await sync.stop()
    await conn.disconnect()

asyncio.run(main())
```

## Tests

```bash
cd p2p/rust
cargo test --lib          # 17 tests (all message types)
cargo check               # 0 errors, 0 warnings
cargo build --release     # release binary in ~25s
```

## Protocol

See `docs/webrtc-p2p-protocol.md` for the full protocol specification.
