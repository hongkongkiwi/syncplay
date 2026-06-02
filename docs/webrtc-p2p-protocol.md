# Syncplay P2P Protocol (WebRTC)

## Overview

Replace the central Twisted TCP server with:
1. A **lightweight signaling server** (language-agnostic, ~1400 lines)
2. **WebRTC data channels** between peers for all sync, chat, and file transfer
3. Standard **TURN server** (coturn/eturnal) for NAT fallback only

```
┌─────────────────────────────────────────────┐
│           SIGNALING SERVER                   │
│  HTTP/WS, any language (Node/Go/Rust/Deno)   │
│                                              │
│  POST /rooms          → create room          │
│  WS  /rooms/:id       → join, SDP relay      │
│  GET /rooms/:id/info  → peer list, host      │
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
        ICE: STUN (90%) / TURN (10%)
```

The signaling server never touches media state, chat content, or file data.

---

## 1. Signaling Protocol (Server ↔ Client)

Transport: WebSocket with JSON messages. Falls back to HTTP long-polling if needed.

### 1.1 Room Management

```
Client → Server
```

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

```
Server → Client
```

#### Room Created
```json
{
  "type": "created",
  "roomId": "movie-night",
  "hostId": "peer-uuid-1",
  "peers": []  // empty initially
}
```

#### Peer Joined (broadcast to existing peers)
```json
{
  "type": "peer_joined",
  "peerId": "peer-uuid-2",
  "username": "bob",
  "features": { "version": "2.0.0", ... }
}
```

#### Room Info (sent to joining peer)
```json
{
  "type": "room_info",
  "roomId": "movie-night",
  "hostId": "peer-uuid-1",
  "peers": [
    { "peerId": "peer-uuid-1", "username": "alice", "features": {...} },
    { "peerId": "peer-uuid-3", "username": "carol", "features": {...} }
  ]
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

#### Peer Left
```json
{
  "type": "peer_left",
  "peerId": "peer-uuid-3",
  "reason": "disconnect"
}
```

#### Error
```json
{
  "type": "error",
  "code": "room_full" | "wrong_password" | "name_taken" | "room_not_found",
  "message": "..."
}
```

### 1.3 SDP / ICE Relay

The signaling server blindly relays SDP and ICE between peers.

```
Sender → Server → Recipient
```

```json
{
  "type": "signal",
  "target": "peer-uuid-2",
  "payload": {
    "kind": "offer" | "answer" | "ice-candidate",
    "sdp": "..."             // for offer/answer
    "candidate": "...",      // for ice-candidate
    "sdpMid": "...",
    "sdpMLineIndex": 0
  }
}
```

Server simply forwards the `payload` to `target`. No validation, no inspection.

### 1.4 Heartbeat

```json
{ "type": "ping" }
```
```json
{ "type": "pong" }
```

Server disconnects after 30s of silence.

---

## 2. P2P Data Channel Protocol (Peer ↔ Peer)

Each peer pair opens a **single WebRTC DataChannel** (binary, reliable+ordered). Messages are length-prefixed binary blobs:

```
[4 bytes: message type] [4 bytes: payload length] [N bytes: payload (MessagePack)]
```

### 2.1 Message Types

| Type | Name | Direction | Description |
|------|------|-----------|-------------|
| 0x01 | `hello` | both | Connection handshake |
| 0x02 | `playstate` | host→peers | Authoritative position/paused/speed state |
| 0x03 | `playstate_request` | peer→host | Non-host wants to seek/pause/play/set-speed |
| 0x04 | `chat` | both (relay: peer→host→all) | Chat message |
| 0x05 | `readiness` | both (relay: peer→host→all) | User ready/not-ready |
| 0x06 | `playlist_change` | host→peers | Playlist updated |
| 0x07 | `playlist_request` | peer→host | Request playlist change |
| 0x08 | `file_info` | both | Share current file metadata |
| 0x09 | `file_transfer` | both (P2P direct) | File chunk data |
| 0x0A | `file_request` | peer→peer | Request file transfer |
| 0x0B | `file_response` | peer→peer | Accept/reject file transfer |
| 0x0C | `latency_ping` | both | RTT measurement |
| 0x0D | `latency_pong` | both | RTT response |
| 0x0E | `host_elected` | new_host→all | Host change announcement |
| 0x0F | `user_info` | both | Username, features on connect |
| 0x10 | `peer_disconnect` | both | Graceful disconnect notification |
| 0x11 | `voice_mute` | both | Voice mute/unmute toggle |
| 0x12 | `subtitle_info` | host→peers | Available subtitle tracks |
| 0x13 | `controller_change` | host→peers | Controller add/remove |
| 0x14 | `avatar_set` | both | Avatar preset/custom assignment |
| 0x15 | `status_update` | both | User status text update |
| 0x16 | `voice_frame` | both | Opus-encoded audio frame |

### 2.2 Message Payloads (MessagePack schema)

#### hello (0x01)
```python
{
    "username": "alice",
    "version": "2.0.0",
    "room": "movie-night",
    "features": ["chat", "fileTransfer", "readiness", "playlist"]
}
```

#### playstate (0x02) — Host → Peers
```python
{
    "position": 123.456,     # seconds
    "paused": False,
    "doSeek": True,           # False = smooth correction, True = immediate seek
    "setBy": "alice",         # who caused this change
    "timestamp": 1717000000,  # unix ms, for latency compensation
    "seq": 42,                # monotonic sequence number
    "speed": 1.0,             # playback speed (1.0 = normal, 2.0 = double)
}
```

#### playstate_request (0x03) — Peer → Host
```python
{
    "action": "seek" | "pause" | "play" | {"setspeed": 2.0},
    "position": 123.456,      # for seek
    "requestId": "uuid"       # for correlation
}
```

Host validates (is peer allowed to control?), then broadcasts new `playstate`. `setspeed` changes playback speed (0.5, 1.0, 2.0).

#### chat (0x04) — Peer → Host → All
```python
{
    "from": "alice",
    "message": "rewind that part!",
    "timestamp": 1717000000
}
```

Host broadcasts to all connected peers. This avoids N×(N-1) relay but adds one hop. Direct mesh relay is also fine for small rooms.

#### readiness (0x05)
```python
{
    "username": "alice",
    "isReady": True,
    "manuallyInitiated": True,
    "setBy": "alice"         # for override (room controller setting others)
}
```

#### playlist_change (0x06) — Host → All
```python
{
    "files": [
        {"name": "episode1.mkv", "duration": 3600.0},
        {"name": "episode2.mkv", "duration": 3600.0}
    ],
    "index": 0,
    "setBy": "alice"
}
```

#### playlist_request (0x07) — Peer → Host
```python
{
    "action": "set_playlist" | "set_index",
    "files": [...],           # for set_playlist
    "index": 1               # for set_index
}
```

#### file_info (0x08)
```python
{
    "username": "alice",
    "file": {
        "name": "movie.mkv",
        "duration": 7200.5,
        "size": 2147483648,
        "checksum": "sha256:abcdef..."  # optional
    }
}
```

#### file_transfer (0x09) — P2P direct, no host relay
```python
{
    "transferId": "uuid",
    "chunkIndex": 42,
    "offset": 11010048,
    "totalSize": 2147483648,
    "chunkSize": 262144,
    "data": b"..."             # raw bytes for this chunk
}
```

#### file_request (0x0A)
```python
{
    "transferId": "uuid",
    "filename": "movie.mkv",
    "offset": 0,              # resume support
    "fingerprint": "sha256:abc..."  # verify same file
}
```

#### file_response (0x0B)
```python
{
    "transferId": "uuid",
    "accepted": True,
    "reason": null,           # "file_not_found", "busy", etc. if rejected
    "fingerprint": "sha256:abc...",
    "chunkSize": 262144
}
```

#### latency_ping (0x0C)
```python
{
    "sendTime": 1717000000000  # unix ms
}
```

#### latency_pong (0x0D)
```python
{
    "sendTime": 1717000000000,  # echoed from ping
    "receiveTime": 1717000000050
}
```

#### peer_disconnect (0x10)
```python
{
    "reason": "left"  # disconnect reason
}
```

#### voice_mute (0x11)
```python
{
    "muted": True  # whether sender is muted
}
```

#### subtitle_info (0x12)
```python
{
    "subtitles": [
        {"filename": "movie.eng.srt", "size": 4096, "language": "eng"},
    ]
}
```

Supported subtitle extensions: .srt, .ass, .ssa, .vtt, .sub, .idx, .txt. Language detection supports 50+ ISO 639-1/2 codes.

#### controller_change (0x13)
```python
{
    "peer_id": "alice",          # username being granted/revoked
    "action": "add" | "remove"   # grant or revoke
}
```

#### avatar_set (0x14)
```python
{
    "username": "alice",
    "preset_id": "cool-cat",    # one of 12 built-in presets
    "custom_url": "",           # custom image URL (overrides preset)
    "accent": "#FF6B6B",        # CSS accent color
}
```

Built-in avatar presets (12): cool-cat, pixel-panda, retro-ghost, foxy, octo, bot-buddy, sparkle, cactus, pizza-pal, rocker, wizard, dino.

#### status_update (0x15)
```python
{
    "username": "alice",
    "status_text": "I'm feeling: hyped! 🔥",
    "timestamp": 1717000000000,
}
```

Built-in status presets (14): hyped, cozy, sleepy, excited, nostalgic, snacks, bathroom, wild, intently, no-spoilers, laughing, crying, mindblown, afk.

#### voice_frame (0x16) — P2P direct (or via host relay in mesh)
```python
{
    "data": b"...",             # Opus-encoded audio
    "seq": 0,                   # sequence number for ordering
    "timestamp": 1717000000000, # capture time (unix ms)
    "sampleRate": 16000,        # sample rate in Hz
    "channels": 1,              # audio channels
    "from": "peer-uuid-1",      # sender peer ID
}
```

---

## 3. Room Host Model

### 3.1 Host Responsibilities

The host is the **authoritative source of truth** for:
- Playstate (position, paused, speed)
- Playlist (current list, current index)
- Chat relay (receives from peers, broadcasts to all)
- Controller management (grant/revoke control)
- Voice frame relay (receives from peers, broadcasts in mesh)

The host does NOT touch:
- File transfers (P2P direct between requester and provider)
- File info (peers broadcast directly)
- Voice frames in SFU mode (server-managed)

### 3.2 Host Election

```
On room creation:  creator = host
On host leave:     longest-connected peer = new host
On host crash:     signaling server detects disconnect, broadcasts host_changed
```

Host election is deterministic so all peers agree without negotiation:
1. Signaling server tracks join order
2. When host disconnects, first remaining peer in join order becomes host
3. Server broadcasts `host_changed` to all peers
4. New host announces itself via `host_elected` (0x0E) on data channels

### 3.3 Controlled Rooms (Password)

Password validation happens at the signaling server level:

1. Room creator sets a password
2. On join, server validates password
3. Server can grant "controller" status to specific peers
4. Host enforces: only controllers can send `playstate_request`

Alternative (fully P2P): The host itself validates a shared secret passed through the data channel. But signaling-server validation is simpler and already has the password.

### 3.4 Host Fallback (No Signaling Server)

For LAN/zeroconf scenarios without a signaling server:
- Peers discover each other via mDNS
- First peer to create/broadcast the room is host
- Host acts as signaling relay for late joiners (relays SDP)
- This makes the app work LAN-only with zero infrastructure

---

## 4. State Synchronization Flow

### 4.1 Normal Playback (host playing, others following)

```
Host plays video →
  Every 500ms: host broadcasts playstate(position, paused=false, speed)

Peer receives →
  Compare with local position
  If diff > rewindThreshold: rewind
  If diff > slowDownThreshold: adjust speed
  If behind: fastforward
  Apply latency compensation: position += (now - playstate.timestamp) * speed / 1000 + latency * speed
```

This mirrors the current `_changePlayerStateAccordingToGlobalState` logic in `client.py`.

### 4.2 Non-Host Seeks

```
Peer B seeks to 5:00 →
  B sends playstate_request(action="seek", position=300.0) → Host

Host receives →
  Validates B is allowed to control
  Broadcasts playstate(position=300.0, doSeek=true, setBy="bob") → All peers

All peers →
  Seek to 300.0
  Show OSD: "bob seeked to 5:00"
```

### 4.3 IgnoringOnTheFly (Self-Correction Guard)

Current Syncplay has `ignoringOnTheFly` to prevent feedback loops. In P2P this becomes simpler because the host is authoritative:

- Non-host sends `playstate_request` (not `playstate`)
- Host broadcasts `playstate`
- Non-host compares: "did the host's response match my request?"
- If yes: normal. If no (someone else changed state simultaneously): host's version wins.

---

## 5. Connection Lifecycle

```
Peer A                          Signaling Server                   Peer B
  │                                    │                              │
  │── WS connect ─────────────────────▶│                              │
  │── create {room, pwd} ─────────────▶│                              │
  │◀── created {hostId=A} ────────────│                              │
  │                                    │                              │
  │                                    │◀── WS connect ───────────────│
  │                                    │◀── join {room, pwd} ────────│
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
  │  ◀══════════ WebRTC DataChannel ESTABLISHED ════════════════▶   │
  │                                    │                              │
  │── hello ─────────────────────────────────────────────────────▶   │
  │◀─ hello ──────────────────────────────────────────────────────   │
  │── playstate (host broadcast) ─────────────────────────────────▶   │
  │── file_info ──────────────────────────────────────────────────▶   │
  │◀─ file_info ───────────────────────────────────────────────────   │
```

---

## 6. Signaling Server Implementation Sketch

The signaling server is so simple it can be implemented in ~150 lines:

```javascript
// Node.js signaling server (conceptual)
const rooms = new Map(); // roomId -> { password, hostId, peers: Map<peerId, ws> }

wss.on('connection', (ws) => {
  let currentPeer = null;

  ws.on('message', (data) => {
    const msg = JSON.parse(data);

    switch (msg.type) {
      case 'create': {
        const room = { hostId: genId(), peers: new Map() };
        if (msg.password) room.password = msg.password;
        rooms.set(msg.room, room);
        ws.send(JSON.stringify({ type: 'created', roomId: msg.room, hostId: room.hostId, peers: [] }));
        break;
      }

      case 'join': {
        const room = rooms.get(msg.room);
        if (!room) { ws.send(err('room_not_found')); return; }
        if (room.password && room.password !== msg.password) { ws.send(err('wrong_password')); return; }

        const peer = { id: genId(), username: msg.username, ws, features: msg.features };
        room.peers.set(peer.id, peer);
        currentPeer = peer;

        // Send room info to joiner
        ws.send(JSON.stringify({ type: 'room_info', roomId: msg.room, hostId: room.hostId,
          peers: [...room.peers.values()].filter(p => p.id !== peer.id)
            .map(p => ({ peerId: p.id, username: p.username, features: p.features })) }));

        // Broadcast to existing peers
        for (const p of room.peers.values()) {
          if (p.id !== peer.id) {
            p.ws.send(JSON.stringify({ type: 'peer_joined', peerId: peer.id, username: peer.username, features: peer.features }));
          }
        }
        break;
      }

      case 'signal': {
        const room = findRoomFor(currentPeer);
        const target = room?.peers.get(msg.target);
        if (target) target.ws.send(JSON.stringify({ type: 'signal', from: currentPeer.id, payload: msg.payload }));
        break;
      }

      case 'leave': handleLeave(currentPeer);
    }
  });

  ws.on('close', () => handleLeave(currentPeer));
});

function handleLeave(peer) {
  if (!peer) return;
  const room = findRoomFor(peer);
  if (!room) return;
  room.peers.delete(peer.id);

  // Host migration
  if (room.hostId === peer.id && room.peers.size > 0) {
    room.hostId = room.peers.values().next().value.id; // first remaining
    broadcast(room, { type: 'host_changed', hostId: room.hostId, reason: 'previous_host_left' });
  }

  broadcast(room, { type: 'peer_left', peerId: peer.id });

  // Cleanup empty rooms (skip if persistent)
  if (room.peers.size === 0 && !room.persistent) rooms.delete(room.name);
}
```

---

## 7. Migration Path

### Phase 1: Signaling + TURN only (week 1-2)
- Write signaling server (Node/Go/Deno — your choice)
- Run coturn for TURN
- Implement WebRTC connection establishment in the client (`aiortc` in Python, or switch client to JS/Electron)

### Phase 2: Core sync over data channels (week 3-4)
- Implement the binary protocol on data channels
- Port `updateGlobalState` to use host-authoritative model
- Port chat, readiness, playlist

### Phase 3: File transfer P2P (week 5-6)
- Replace `TransferSocketRelay` with direct data channel file transfer
- Resume support, chunking, fingerprinting

### Phase 4: Polish (week 7-8)
- LAN/zeroconf mode (mDNS discovery, host-as-signaling-relay)
- Persistent rooms (store in signaling server or distributed)
- Controlled rooms with host validation

---

## 8. Key Advantages Over Current Architecture

| Aspect | Current (Twisted TCP) | WebRTC P2P |
|--------|----------------------|------------|
| Server language | Python (stuck) | Any language |
| Server complexity | 1009-line `server.py` + `protocols.py` | ~150-line WebSocket relay |
| Server CPU | Relays all state, chat, files | Only SDP/ICE relay |
| Server bandwidth | Proportional to peer count × data | Minimal (signaling only) |
| File transfers | Server-relayed (bottleneck) | P2P direct (fast) |
| NAT traversal | None (needs port forward) | Built-in (STUN/TURN) |
| Latency | Server-mediated (2 hops) | Direct (1 hop) |
| Offline/LAN mode | No | Yes (mDNS + host relay) |
| TLS | Manual certificate management | DTLS (automatic, per WebRTC) |

---

## 9. Risks & Open Questions

1. **aiortc vs Twisted**: `aiortc` is asyncio-based. Twisted integration is awkward. Consider switching the Python client to asyncio, or writing the P2P layer in Rust (via PyO3) or as a separate process that the Python client speaks to over local IPC.

2. **Browser client possible?** With this protocol, a browser-based Syncplay client becomes trivial. Just add the WebRTC data channel logic in JS. The signaling server already uses WebSocket. This is a huge win — no install needed.

3. **Large rooms**: Mesh topology with 50 peers = 2450 data channels. For rooms this large, consider an SFU-style relay where the host multiplexes to all peers over a single connection. But Syncplay rooms rarely exceed 10 people.

4. **TURN cost**: TURN relays data. For rooms where all peers are behind symmetric NAT, data flows through TURN instead of P2P — same as the current server relay. But this only affects ~10% of connections, and TURN bandwidth is cheap (coturn is free software, bandwidth is the only cost).
