# Architecture

## System Overview

Syncplay P2P v2.0 uses WebRTC data channels for direct peer-to-peer communication, with a lightweight WebSocket signaling relay for connection establishment.

### Mesh Mode (default)

Each peer connects directly to every other peer via WebRTC data channels. The signaling server only relays SDP offers/answers and ICE candidates.

```
Signaling Server (Rust, ~400 lines)
         │
    ┌────┼────┐
    ▼    ▼    ▼
  PeerA◄─►PeerB
    ▲    │    ▲
    └────┼────┘
         ▼
       PeerC
```

### SFU Mode

All traffic routes through the signaling server. One RTCPeerConnection per peer. Better for large rooms (5+ peers).

```
Signaling Server + SFU
         │
    ┌────┼────┐
    ▼    ▼    ▼
   A    B    C
```

## Component Architecture

### Shared P2P Library (`packages/p2p-client`)

The core protocol library shared between Web and React Native clients:

- `messages.ts` — 22 message type enum, 20+ payload interfaces, builder functions, avatar presets (12), status presets (14)
- `wire.ts` — MessagePack binary encoding/decoding (8-byte header: 4B type u32 BE + 4B payload_len u32 BE + N bytes msgpack). Max payload 10 MB. Includes convenience encoders for Chat, Readiness, and PeerDisconnect.
- `state.ts` — `P2PStateManager`: all protocol logic (1441 lines). Handles connection state machine, message dispatch for all 22 types, host-authoritative playstate sync, per-peer latency tracking, chat with emoji expansion (39 shortcodes), playlist management, controller access control, file transfer with SHA-256 verification, subtitle detection (7 formats, 50+ language codes), voice frame relay, avatar/status management, state replay for late joiners, and config persistence.
- `discovery.ts` — `PeerDiscovery`: network scanner with HTTP `/rooms` endpoint querying plus mDNS framework for LAN peer discovery
- `index.ts` — Re-exports all public API

### Rust Core (`p2p/rust`)

Single crate compiling to three binaries:

- `syncplay-signaling` (`main.rs`) — WebSocket relay, room management, host election
- `syncplay-tui` (`tui_main.rs`) — Terminal UI with ratatui, 6 panels, 17 keybindings
- `syncplay-turn` (`turn_main.rs`) — TURN relay for NAT traversal

Key modules:
- `sync.rs` (1563 lines) — Host-authoritative state sync, controller gating
- `connection.rs` (1465 lines) — WebRTC ICE/STUN/TURN, signaling handshake, peer lifecycle
- `signalling.rs` — WebSocket server: rooms, SDP/ICE relay, host migration
- `file_transfer.rs` — Streaming chunked transfer (256KB), SHA-256, subtitles
- `voice_chat.rs` — Opus 48kHz, cpal mic capture, decode + output playback
- `player.rs` — Cross-platform media player detection (8 players)
- `player_controller.rs` — mpv JSON IPC + VLC RC interface
- `tui.rs` — ratatui 6-panel adaptive layout, emoji, slash commands
- `config.rs` — P2pConfig: STUN/TURN/download_dir/voice/player
- `error.rs` — WireError, ConnectionError, SyncError (thiserror)
- `state.rs` — ConnectionStateMachine: lifecycle tracking
- `messages.rs` — 22 message types + payloads + builders
- `wire.rs` — MessagePack framing (17 tests)
- `sfu.rs` — Selective Forwarding Unit for large rooms

### Web Client (`web-client`)

- TanStack Start (React 19 + SSR)
- `connectionV2.ts` — WebSocket signaling + RTCPeerConnection. Wraps `P2PStateManager`. Manages ICE config (STUN/TURN), data channel lifecycle, error classification with user-friendly messages.
- `routes/index.tsx` — Single-page UI: video player, chat with emoji, playlist, peer list, room controls
- `voiceChat.ts` — MediaRecorder-based Opus voice capture
- `connection.ts` — Legacy v1 WebSocket bridge (for original Syncplay servers)
- `syncControl.ts` — Browser video element sync with latency compensation

### React Native (`react-native`)

- Expo SDK 56
- `connectionV2.ts` — Self-contained P2P stack (inline P2PStateManager). WebSocket signaling + RTCPeerConnection with platform-native WebRTC. Error mapping, reconnection, ICE restart.
- `App.tsx` — Tab-based UI: connect, watch, room, chat, settings
- `voiceChat.ts` — expo-av based voice capture
- `syncControl.ts` — Native video player sync with playback rate correction
- `playlistPlayback.ts` — Shared playlist management with filename matching
- `directoryScanner.ts` — Local media directory scanning (deeper on Android)

## Data Flow

### Connection Establishment

1. Client connects to signaling server via WebSocket
2. Sends `create` or `join` message with room + credentials
3. Server responds with `peerId`, `hostId`, and existing peers
4. Client creates `RTCPeerConnection` with STUN/TURN config
5. SDP offer/answer exchanged via signaling relay (`signal` messages)
6. ICE candidates exchanged via signaling relay
7. Data channel `syncplay-v2` opens (binary, reliable, ordered)
8. `Hello` message sent over data channel → peer tracking begins
9. All sync/chat/voice data flows directly over data channels

### Host Responsibilities

The host is the **authoritative source of truth** for:
- Playstate (position, paused, speed)
- Playlist (current items, current index)
- Controller management (grant/revoke control)
- Chat relay (receives from peers, broadcasts to all in mesh)

The host does NOT touch:
- File transfers (P2P direct between requester and provider)
- Voice frames (P2P direct; host only relays in mesh mode)
- File info (peers broadcast directly)

### State Synchronization

1. Host broadcasts `Playstate` every 500ms (position, paused, speed, seq)
2. Peers apply latency compensation: `position += (now - timestamp) * speed / 1000 + latency * speed`
3. Non-host seeks: send `PlaystateRequest` → host validates → host broadcasts new `Playstate`
4. Late joiners receive full state replay via `sendStateTo()`: playstate, playlist, readiness states, controllers, avatars, statuses, subtitles

### Latency Measurement

1. Every 2 seconds, each peer sends `LatencyPing` to all other peers
2. Recipient responds with `LatencyPong` (echoes `sendTime`, adds `receiveTime`)
3. RTT = `now - ping.sendTime`, stored per-peer
4. Warning emitted at >500ms

### Host Election

1. Room creator becomes initial host
2. When host leaves, longest-connected peer becomes new host
3. Signaling server broadcasts `host_changed` to all peers
4. New host announces via `HostElected` (0x0e) on data channels

## Connection State Machine

```
offline → connecting → handshaking → connecting_peers → ready
                                                       ↕
                                                  reconnecting
```

- `offline`: No connection, initial state
- `connecting`: WebSocket opened, signaling in progress
- `handshaking`: SDP exchanged, ICE gathering
- `connecting_peers`: Data channels opening
- `ready`: Fully connected, sync active
- `reconnecting`: Connection lost, exponential backoff (2s→32s, max 5 attempts)
- `error`: Unrecoverable error

Transitions to `error` and `offline` are always allowed. Illegal transitions are logged and ignored.

## Wire Protocol

```
[4 bytes: message type u32 BE][4 bytes: payload length u32 BE][N bytes: MessagePack payload]
```

- Header: 8 bytes total
- Max payload: 10 MB (enforced in encode)
- Message types: 0x01 (Hello) through 0x16 (VoiceFrame) = 22 types
- Encoding: MessagePack (binary)
- Transport: WebRTC DataChannel (reliable, ordered, binary)
