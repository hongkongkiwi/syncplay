# Syncplay P2P Protocol Specification v2.0.0

## Overview

Syncplay P2P replaces the central TCP server architecture with:
1. A **lightweight signaling server** (WebSocket, language-agnostic)
2. **WebRTC data channels** between peers for all sync, chat, and file transfer
3. Standard **TURN server** (built-in or external) for NAT fallback

```
┌─────────────────────────────────────────────┐
│           SIGNALING SERVER                   │
│  WebSocket (Rust, ~1400 lines)               │
│                                              │
│  create/join → room management               │
│  signal → SDP/ICE relay                      │
└──────┬──────────┬──────────┬─────────────────┘
       │ SDP/ICE  │ SDP/ICE  │ SDP/ICE
       │ relay    │ relay    │ relay
       ▼          ▼          ▼
   ┌───────┐ ┌───────┐ ┌───────┐
   │ Peer A│◀│ Peer B│◀│ Peer C│   ← WebRTC Data Channels (full mesh)
   │ (HOST)│▶│       │▶│       │
   └───────┘ └───────┘ └───────┘
       │          │          │
       └──────────┴──────────┘
        ICE: STUN (~90%) / TURN (~10%)
```

The signaling server never touches media state, chat content, or file data.

---

## 1. Signaling Protocol (Server ↔ Client)

Transport: WebSocket with JSON messages.

### 1.1 Room Management

#### Create Room
```json
{
  "type": "create",
  "room": "movie-night",
  "password": "optional-room-password",
  "username": "alice",
  "persistent": false,
  "features": ["chat", "fileTransfer", "readiness", "playlist"]
}
```

`persistent` (optional, default false): if true, room is not removed when empty. `username` (optional) sets the display name. `features` is a string array of enabled features.

#### Join Room
```json
{
  "type": "join",
  "room": "movie-night",
  "password": "optional-room-password",
  "username": "bob",
  "features": ["chat", "fileTransfer", "readiness", "playlist"]
}
```

#### Leave Room
```json
{
  "type": "leave"
}
```

### 1.2 Server Responses

#### Room Created
```json
{
  "type": "created",
  "roomId": "movie-night",
  "hostId": "peer-uuid-1",
  "peerId": "peer-uuid-1",
  "peers": []
}
```

#### Room Info (sent to joining peer)
```json
{
  "type": "room_info",
  "roomId": "movie-night",
  "hostId": "peer-uuid-1",
  "peerId": "peer-uuid-2",
  "peers": [
    { "peerId": "peer-uuid-1", "username": "alice", "features": ["chat", "fileTransfer"] },
    { "peerId": "peer-uuid-3", "username": "carol", "features": ["chat", "readiness"] }
  ]
}
```

#### Peer Joined (broadcast to existing peers)
```json
{
  "type": "peer_joined",
  "peerId": "peer-uuid-2",
  "username": "bob",
  "features": ["chat", "fileTransfer", "readiness", "playlist"]
}
```

#### Peer Left
```json
{
  "type": "peer_left",
  "peerId": "peer-uuid-3",
  "reason": "disconnect"
}
```

#### Host Changed
```json
{
  "type": "host_changed",
  "hostId": "peer-uuid-2",
  "reason": "previous_host_left"
}
```

#### Error
```json
{
  "type": "error",
  "code": "room_full | wrong_password | name_taken | room_not_found",
  "message": "..."
}
```

#### Ping/Pong (keepalive)
```json
{ "type": "ping" }
```
```json
{ "type": "pong" }
```

Server disconnects after 30s of silence.

### 1.3 SDP / ICE Relay

The signaling server blindly relays SDP and ICE between peers:

```json
{
  "type": "signal",
  "target": "peer-uuid-2",
  "payload": {
    "kind": "offer | answer | ice-candidate",
    "sdp": "...",
    "candidate": "...",
    "sdpMid": "...",
    "sdpMLineIndex": 0
  }
}
```

---

## 2. P2P Data Channel Protocol (Peer ↔ Peer)

Each peer pair opens a **single WebRTC DataChannel** (binary, reliable, ordered). Messages are length-prefixed binary blobs:

```
[4 bytes: message type u32 BE][4 bytes: payload length u32 BE][N bytes: payload (MessagePack)]
```

- Header: 8 bytes
- Max payload: 10 MB
- Encoding: MessagePack

### 2.1 Message Types

| Type | Hex | Name | Direction | Description |
|------|-----|------|-----------|-------------|
| 0x01 | 01 | Hello | both | Connection handshake |
| 0x02 | 02 | Playstate | host→peers | Authoritative position/paused/speed state |
| 0x03 | 03 | PlaystateRequest | peer→host | Non-host wants to seek/pause/play/set speed |
| 0x04 | 04 | Chat | both | Chat message (host relays in mesh) |
| 0x05 | 05 | Readiness | both | User ready/not-ready state |
| 0x06 | 06 | PlaylistChange | host→peers | Playlist updated |
| 0x07 | 07 | PlaylistRequest | peer→host | Request playlist change |
| 0x08 | 08 | FileInfo | both | Share current file metadata |
| 0x09 | 09 | FileTransfer | both | File chunk data (P2P direct) |
| 0x0A | 0A | FileRequest | peer→peer | Request file transfer |
| 0x0B | 0B | FileResponse | peer→peer | Accept/reject file transfer |
| 0x0C | 0C | LatencyPing | both | RTT measurement request |
| 0x0D | 0D | LatencyPong | both | RTT measurement response |
| 0x0E | 0E | HostElected | new_host→all | Host change announcement |
| 0x0F | 0F | UserInfo | both | Username + features on connect |
| 0x10 | 10 | PeerDisconnect | both | Graceful disconnect notification |
| 0x11 | 11 | VoiceMute | both | Voice mute/unmute toggle |
| 0x12 | 12 | SubtitleInfo | host→peers | Available subtitle tracks |
| 0x13 | 13 | ControllerChange | host→peers | Controller add/remove |
| 0x14 | 14 | AvatarSet | both | Avatar preset/custom assignment |
| 0x15 | 15 | StatusUpdate | both | User status text update |
| 0x16 | 16 | VoiceFrame | both | Opus-encoded audio frame |

### 2.2 Message Payloads (MessagePack)

#### Hello (0x01)
```
username:    string    — display name
version:     string    — protocol version ("2.0.0")
room:        string    — room name
features:    string[]  — enabled features (chat, fileTransfer, readiness, playlist)
```

#### Playstate (0x02) — Host → Peers
```
position:    f64       — seconds
paused:      bool      — is playback paused
doSeek:      bool      — true = immediate seek, false = smooth correction
setBy:       string    — who caused this change
seq:         u64       — monotonic sequence number (drop stale)
timestamp:   u64       — unix ms, for latency compensation
speed:       f64       — playback speed multiplier (0.5, 1.0, 2.0)
```

Latency compensation formula:
```
position += (now - playstate.timestamp) * speed / 1000 + latency * speed
```

#### PlaystateRequest (0x03) — Peer → Host
```
action:      string | { setspeed: f64 }  — "seek" | "pause" | "play" | setspeed
position:    f64       — for seek action
requestId:   string    — UUID for correlation
```

Valid actions:
- `"seek"` — seek to position
- `"pause"` — pause playback
- `"play"` — resume playback
- `{ "setspeed": 0.5 }` — change speed (0.5, 1.0, 2.0)

Host validates controller access, then broadcasts new Playstate.

#### Chat (0x04)
```
from:        string    — sender username
message:     string    — chat text (may contain :emoji: shortcodes)
timestamp:   u64       — unix ms
```

#### Readiness (0x05)
```
username:      string  — target user
isReady:       bool    — ready state
manuallyInitiated: bool — user-initiated vs host override
setBy:         string  — who set this (for host overrides)
```

#### PlaylistChange (0x06) — Host → All
```
files:  [{ name: string, duration: f64 }]  — playlist entries
index:  u64                                 — current playlist index
setBy:  string                              — who set the playlist
```

Max playlist size: 250 entries.

#### PlaylistRequest (0x07) — Peer → Host
```
action:  "set_playlist" | "set_index"
files:   [{ name: string, duration: f64 }]  — for set_playlist
index:   u64                                 — for set_index
```

#### FileInfo (0x08)
```
username:  string
file:      { name: string, duration: f64, size: u64, checksum?: string } | null
```

#### FileTransfer (0x09)
```json
transferId:  string         — UUID
chunkIndex:  u64            — chunk sequence number
offset:      u64            — byte offset in file
totalSize:   u64            — total file size
chunkSize:   u32            — bytes per chunk (256KB default, must not be 0)
data:        bin            — raw bytes for this chunk (up to 256KB)
```

Final verification chunk sent with `chunkIndex = 0xFFFFFFFFFFFFFFFF` (u64::MAX). Receiver computes SHA-256 of assembled file and verifies against the fingerprint sent in the verification chunk's `data` field.

#### FileRequest (0x0A)
```
transferId:   string    — UUID
filename:     string    — requested filename
offset:       u64       — resume offset (0 = from start)
fingerprint:  string    — expected SHA-256 (empty = no verification)
```

#### FileResponse (0x0B)
```
transferId:   string    — UUID matching request
accepted:     bool      — whether accepted
reason:       string    — rejection reason if not accepted
fingerprint:  string    — SHA-256 of file being sent
chunkSize:    u32       — chunk size for this transfer
```

#### LatencyPing (0x0C)
```
sendTime:  u64  — unix ms when ping was sent
```

#### LatencyPong (0x0D)
```
sendTime:     u64  — echoed from ping
receiveTime:  u64  — unix ms when ping was received
```

RTT = `now - ping.sendTime`. Latency warning at >500ms.

#### HostElected (0x0E)
```
host_id:  string  — new host's peer ID
reason:   string  — reason for change (e.g., "previous_host_left")
```

#### UserInfo (0x0F)
```
username:  string    — display name
features:  string[]  — enabled features
```

#### PeerDisconnect (0x10)
```
reason:  string  — disconnect reason
```

#### VoiceMute (0x11)
```
muted:  bool  — whether sender is muted
```

#### SubtitleInfo (0x12)
```
subtitles:  [{ filename: string, size: u64, language?: string }]
```

Supported subtitle extensions: .srt, .ass, .ssa, .vtt, .sub, .idx, .txt.
Language detection supports 50+ ISO 639-1/2 codes.

#### ControllerChange (0x13)
```
peer_id:  string             — username being granted/revoked
action:   "add" | "remove"   — grant or revoke
```

#### AvatarSet (0x14)
```
username:    string  — target user
preset_id:   string  — avatar preset ID (one of 12 built-in)
custom_url:  string  — custom image URL (overrides preset)
accent:      string  — CSS accent color
```

Built-in avatar presets (12):
- `cool-cat` 😎, `pixel-panda` 🐼, `retro-ghost` 👻, `foxy` 🦊
- `octo` 🐙, `bot-buddy` 🤖, `sparkle` 🦄, `cactus` 🌵
- `pizza-pal` 🍕, `rocker` 🎸, `wizard` 🧙, `dino` 🦖

#### StatusUpdate (0x15)
```
username:     string  — user updating status
status_text:  string  — status text
timestamp:    u64     — unix ms
```

Built-in status presets (14):
hyped 🔥, cozy 🧋, sleepy 😴, excited 🎬, nostalgic 🥲, snacks 🍿, bathroom 🚽, wild 😱, intently 👀, no-spoilers 🤫, laughing 😂, crying 😭, mindblown 🤯, afk 🏃

#### VoiceFrame (0x16)
```
data:        bin       — Opus-encoded audio data
seq:         u64       — sequence number for ordering
timestamp:   u64       — capture time (unix ms)
sampleRate:  u32       — sample rate in Hz
channels:    u32       — audio channels
from:        string    — sender peer ID
```

---

## 3. Room Host Model

### 3.1 Host Responsibilities

The host is the **authoritative source of truth** for:
- Playstate (position, paused, speed)
- Playlist (current content, current index)
- Controller management (grant/revoke)
- Chat relay (receives from peers, broadcasts to all in mesh)

The host does NOT touch:
- File transfers (P2P direct between peers)
- Voice frames (P2P direct; host only relays in mesh)
- File info (peers broadcast directly)

### 3.2 Host Election

```
On room creation:  creator = host
On host leave:     longest-connected peer = new host
On host crash:     signaling server detects disconnect, broadcasts host_changed
```

All peers agree via deterministic join order tracked by the signaling server. New host announces via `HostElected` (0x0E) on data channels.

### 3.3 Controller Access Control

- Host can grant controller status to specific peers via `ControllerChange` (0x13)
- Controllers can send `PlaystateRequest` (0x03): seek, pause, play, set speed
- Non-controllers' requests are silently dropped by the host
- Controller list is replayed to late joiners via `sendStateTo()`

---

## 4. State Synchronization Flow

### 4.1 Normal Playback

```
Host plays video →
  Every 500ms: host broadcasts Playstate(position, paused=false, speed)

Peer receives →
  Compare with local position
  If diff > threshold: seek to corrected position
  If behind: skip ahead using speed multiplier
  Apply latency compensation: position += (now - timestamp) * speed / 1000 + latency * speed
```

### 4.2 Non-Host Seeks

```
Peer B seeks to 5:00 →
  B sends PlaystateRequest(action="seek", position=300.0) → Host

Host receives →
  Validates B is allowed to control
  Broadcasts Playstate(position=300.0, doSeek=true, setBy="bob") → All peers

All peers →
  Seek to 300.0
  Show OSD: "bob seeked to 5:00"
```

### 4.3 Speed Changes

```
Peer requests speed 2x →
  B sends PlaystateRequest({ SetSpeed: 2.0 }) → Host

Host receives →
  Validates, sets speed, broadcasts Playstate(speed=2.0)
```

### 4.4 IgnoringOnTheFly (Self-Correction Guard)

- Non-host sends `PlaystateRequest` (not `Playstate`)
- Host broadcasts `Playstate`
- Non-host compares: "did the host's response match my request?"
- If yes: normal. If no (simultaneous change): host's version wins.

### 4.5 State Replay for Late Joiners

When a new peer joins, the host calls `sendStateTo()` which replays:
1. Current `Playstate` (position, paused, speed)
2. Full `PlaylistChange` (all entries + current index)
3. `Readiness` for every peer
4. `ControllerChange` for every controller
5. `AvatarSet` for every peer with an avatar
6. `StatusUpdate` for every peer with a status
7. `SubtitleInfo` if host has loaded subtitles

---

## 5. Connection Lifecycle

```
Peer A                          Signaling Server                   Peer B
  │                                    │                              │
  │── WS connect ─────────────────────▶│                              │
  │── create {room, username} ────────▶│                              │
  │◀── created {hostId=A} ────────────│                              │
  │                                    │                              │
  │                                    │◀── WS connect ───────────────│
  │                                    │◀── join {room, username} ────│
  │◀── peer_joined {B} ──────────────│                              │
  │                                    │── room_info {peers:[A]} ────▶│
  │                                    │                              │
  │── signal {offer, target=B} ───────▶│                              │
  │                                    │── signal {offer, from=A} ───▶│
  │                                    │◀── signal {answer, target=A}─│
  │◀── signal {answer, from=B} ──────│                              │
  │                                    │                              │
  │  ◀═══════ ICE candidates (via server) ═══════════════════════▶   │
  │                                    │                              │
  │  ◀═══════ WebRTC DataChannel ESTABLISHED ════════════════════▶   │
  │                                    │                              │
  │── Hello ─────────────────────────────────────────────────────▶   │
  │◀─ Hello ──────────────────────────────────────────────────────   │
  │── Playstate (host broadcast) ─────────────────────────────────▶   │
  │── FileInfo ───────────────────────────────────────────────────▶   │
  │◀─ FileInfo ────────────────────────────────────────────────────   │
  │── (state replay for B if host) ───────────────────────────────▶   │
```

---

## 6. File Transfer

### 6.1 Chunked Transfer

- File chunk size: 256KB
- Transfer ID: UUID per transfer
- Incremental SHA-256 computed over all chunks
- Final verification chunk sent with `chunkIndex = MAX_SAFE_INTEGER`
- Receiver assembles, computes SHA-256, verifies fingerprint match
- If mismatch: transfer discarded, error logged

### 6.2 Transfer Flow

```
Requester                            Provider
  │                                      │
  │── FileRequest ──────────────────────▶│
  │   {transferId, filename, fingerprint}│
  │                                      │
  │◀── FileResponse ────────────────────│
  │   {accepted: true, fingerprint}      │
  │                                      │
  │◀── FileTransfer (chunk 0) ──────────│
  │◀── FileTransfer (chunk 1) ──────────│
  │   ...                                │
  │◀── FileTransfer (chunk N) ──────────│
  │◀── FileTransfer (final, chunkIndex=MAX_SAFE_INTEGER) ──│
  │                                      │
  │  Assemble + SHA-256 verify           │
```

---

## 7. Voice Chat

- Codec: Opus, 16kHz mono (default)
- Capture: MediaRecorder (Web) / expo-av (React Native) / cpal (Rust)
- Non-host sends voice frames to host for relay
- Host relays to all other peers (mesh mode)
- Voice frames carry sequence numbers for ordering
- Mute state synced via `VoiceMute` (0x11)

---

## 8. Chat

- Chat messages (0x04) support 39 emoji shortcodes
- Host relays chat to all peers in mesh mode
- Slash commands supported: `/me`, `/shrug`, `/tableflip`, `/unflip`, `/lenny`
- Max 2000 chat messages retained in memory

---

## 9. Discovery

### HTTP Room Listing

```
GET /rooms → [{ "room": "movienight", "peers": 3, "hasPassword": false }]
```

Available on the signaling server's HTTP port (default 8998). Converts `ws://` to `http://`.

### mDNS (DEFERRED)

Service type: `_syncplay-p2p._tcp.local`. TXT records for room, username, version. Available in Node.js/Electron; not in browsers.

---

## 10. Protocol Constants

| Constant | Value |
|----------|-------|
| PROTOCOL_VERSION | "2.0.0" |
| DEF_SYNC_INTERVAL | 500 ms |
| DEF_PING_INTERVAL | 2000 ms |
| MAX_CHAT | 2000 messages |
| MAX_PLAYLIST | 250 entries |
| MAX_PAYLOAD | 10 MB |
| CHUNK_SIZE | 256 KB |
| LATENCY_WARN_MS | 500 ms |
| MAX_RECONNECT_ATTEMPTS | 5 |
| RECONNECT_BACKOFF_BASE | 2000 ms |
| RECONNECT_BACKOFF_MAX | 32000 ms |
