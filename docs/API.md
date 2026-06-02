# API Reference

## P2PStateManager

The `P2PStateManager` class is the core protocol engine. It handles all 22 message types, peer tracking, host election, latency measurement, controller access control, playlist management, file transfer, voice chat, avatar/status management, subtitle detection, and state replay.

**Package:** `syncplay-p2p-client`
**Source:** `packages/p2p-client/src/state.ts`

```typescript
import { P2PStateManager } from 'syncplay-p2p-client';
```

### Constructor

```typescript
constructor(username: string, features?: string[])
```

Creates a new state manager instance.

**Parameters:**
- `username` — Display name for this peer
- `features` — Optional feature flags array (default: `['chat', 'readiness', 'playlist']`)

---

### Connection Lifecycle

#### `connectionState`
```typescript
get connectionState(): ConnectionState
```
Current connection state. One of: `'offline' | 'connecting' | 'handshaking' | 'connecting_peers' | 'ready' | 'reconnecting' | 'error'`

#### `isHost`
```typescript
get isHost(): boolean
```
Whether this peer is the current room host.

#### `myUsername`
```typescript
get myUsername(): string
```
This peer's username.

#### `myPeerId`
```typescript
get myPeerId(): string
```
This peer's assigned ID (set after signaling handshake).

#### `connected`
```typescript
get connected(): boolean
```
Whether fully connected and transport is active.

#### `onConnected(peerId, hostId, transport)`
```typescript
onConnected(peerId: string, hostId: string, transport: P2PTransport): void
```
Called by transport layer when signaling handshake completes. Transitions to `'ready'`, starts sync and ping loops.

#### `onDisconnected(reason)`
```typescript
onDisconnected(reason: string): void
```
Called by transport layer on disconnect. Stops loops, clears state, transitions to `'offline'`.

#### `transit(newState, error?)`
```typescript
transit(newState: ConnectionState, error?: string): void
```
Validated state transition. Logs warnings for illegal transitions. Sets `transitionTimestamp` and `lastTransitionMessage`.

#### `destroy()`
```typescript
destroy(): void
```
Cancel reconnection, stop loops, clear all event handlers. Call when unmounting.

---

### Event System

#### `onSyncEvent(handler)`
```typescript
onSyncEvent(handler: (event: SyncEvent) => void): void
```
Register an event handler. Multiple handlers can be registered — all fire on each event in registration order.

#### SyncEvent Type
```typescript
interface SyncEvent {
  type: SyncEventType;
  data?: unknown;
  timestamp: number;
}

type SyncEventType =
  | 'chat'              // Chat message received
  | 'playstate'         // Playstate changed (position, pause, speed)
  | 'user-join'         // Peer joined room
  | 'user-leave'        // Peer left room
  | 'host-change'       // Host changed
  | 'error'             // Connection or protocol error
  | 'transfer-complete' // File transfer finished
  | 'transfer-progress' // File transfer progress update
```

#### `onVoiceFrame`
```typescript
onVoiceFrame: ((data: Uint8Array, from: string) => void) | null
```
Callback set by VoiceChat module to receive incoming Opus audio frames.

#### `onReconnectSuccess`
```typescript
onReconnectSuccess: (() => void) | null
```
Callback invoked after successful reconnection.

#### `onSendTransport`
```typescript
onSendTransport: ((msgType: MessageType, payload: unknown) => void) | null
```
Configurable callback for the connection layer.

---

### Playback Control

#### `updatePlaystate(position, paused, speed?)`
```typescript
updatePlaystate(position: number, paused: boolean, speed?: number): void
```
Update playback state. If host: applies immediately and broadcasts. If non-host: delegates to `requestSeek()`.

#### `requestSeek(position)`
```typescript
requestSeek(position: number): void
```
Request seek from host (non-host) or apply immediately (host).

#### `requestPause()`
```typescript
requestPause(): void
```
Request pause from host (non-host) or apply immediately (host).

#### `requestPlay()`
```typescript
requestPlay(): void
```
Request play/resume from host (non-host) or apply immediately (host).

#### `requestSetSpeed(speed)`
```typescript
requestSetSpeed(speed: number): void
```
Request playback speed change (e.g., 0.5, 1.0, 2.0).

#### `updateSpeed(speed)`
```typescript
updateSpeed(speed: number): void
```
Host-only speed change without broadcasting position.

---

### Readiness

#### `setReady(isReady)`
```typescript
setReady(isReady: boolean): void
```
Set own readiness state. Broadcasts to all peers.

#### `setReadyFor(targetUsername, isReady)`
```typescript
setReadyFor(targetUsername: string, isReady: boolean): void
```
Host-only: set another peer's readiness state.

---

### Playlist

#### `addToPlaylist(files)`
```typescript
addToPlaylist(files: string[]): void
```
Append files to playlist. Max 250 entries. Non-host sends `PlaylistRequest`.

#### `setPlaylist(files)`
```typescript
setPlaylist(files: string[]): void
```
Replace entire playlist. Max 250 entries. Non-host sends `PlaylistRequest`.

#### `setPlaylistIndex(idx)`
```typescript
setPlaylistIndex(idx: number): void
```
Set current playlist index. Resets position to 0.

#### `clearPlaylist()`
```typescript
clearPlaylist(): void
```
Clear all playlist entries. Resets index to 0.

---

### Chat

#### `sendChat(text)`
```typescript
sendChat(text: string): void
```
Send a chat message. Auto-expands `:emoji:` shortcodes (39 supported).

#### `sendSlashCommand(cmd)`
```typescript
sendSlashCommand(cmd: string): string | null
```
Process a slash command. Returns the expanded text or `null` if unrecognized.

Supported commands: `/me`, `/shrug`, `/tableflip` (alias `/flip`), `/unflip`, `/lenny`

---

### Controllers

#### `addController(username)`
```typescript
addController(username: string): void
```
Grant controller status. Host-only broadcast.

#### `removeController(username)`
```typescript
removeController(username: string): void
```
Revoke controller status. Host-only broadcast.

#### `isController(username)`
```typescript
isController(username: string): boolean
```
Check if a user has controller status. Always returns `true` for own username.

---

### Avatar & Status

#### `setAvatar(presetId, customUrl, accent)`
```typescript
setAvatar(presetId: string, customUrl: string, accent: string): void
```
Set own avatar. Uses one of 12 built-in presets or a custom URL.

#### `setStatus(statusText)`
```typescript
setStatus(statusText: string): void
```
Set own status text. 14 built-in presets available.

---

### Voice

#### `sendVoiceMute(muted)`
```typescript
sendVoiceMute(muted: boolean): void
```
Broadcast voice mute state.

#### `sendVoiceFrame(data, seq)`
```typescript
sendVoiceFrame(data: Uint8Array, seq: number): void
```
Send an Opus-encoded voice audio frame. Non-host sends to host for relay.

#### `toggleMute()`
```typescript
toggleMute(): boolean
```
Toggle mute state. Returns new mute state.

---

### File Transfer

#### `sendFile(file, targetPeerId?)`
```typescript
async sendFile(file: File | Blob, targetPeerId?: string): Promise<string | null>
```
Send a file via 256KB chunks with incremental SHA-256 verification. Emits `transfer-progress` events.

Returns transfer ID or `null` on failure.

#### `sendFileRN(filePath, targetPeerId?)`
```typescript
async sendFileRN(filePath: string, targetPeerId?: string): Promise<string | null>
```
React Native file sending. Fully implemented — requires the RN layer to wire `P2PState.fileReader` with an `expo-file-system`-backed reader callback.

#### `requestFile(peerId, filename, offset?)`
```typescript
requestFile(peerId: string, filename: string, offset?: number): void
```
Request a file transfer from a peer.

#### `cancelTransfer(transferId)`
```typescript
cancelTransfer(transferId: string): void
```
Cancel an in-progress file transfer and free resources.

---

### File Info

#### `sendFileInfo(file?)`
```typescript
sendFileInfo(file?: FileMetadata): void
```
Broadcast current file metadata. Host-only. Also sends subtitle info if available.

---

### Subtitle Detection

#### `findSubtitles(files, videoName)`
```typescript
findSubtitles(files: ReadonlyArray<{ name: string; size?: number }>, videoName: string): SubtitleTrack[]
```
Find subtitle files matching a video filename. Supports 7 formats (.srt, .ass, .ssa, .vtt, .sub, .idx, .txt). Auto-detects language from filename using 50+ ISO 639 codes.

#### `setSubtitleTracks(tracks)`
```typescript
setSubtitleTracks(tracks: SubtitleTrack[]): void
```
Store subtitle tracks for state replay to late joiners.

#### `sendSubtitleInfo()`
```typescript
sendSubtitleInfo(): void
```
Broadcast subtitle track info to all peers.

#### `detectSubtitleLanguage(filename)` (static)
```typescript
static detectSubtitleLanguage(filename: string): string | undefined
```
Extract ISO 639-1 language code from a subtitle filename. Recognizes 2-letter codes, 3-letter codes (mapped), and flags like "forced", "sdh", "hi", "cc".

---

### State Replay

#### `sendStateTo(peerId)`
```typescript
sendStateTo(peerId: string): void
```
Send full room state to a newly joined peer: playstate, playlist, readiness states, controller list, avatars, statuses, subtitles.

---

### Peer Tracking

#### `getSnapshot()`
```typescript
getSnapshot(): RoomStateSnapshot
```
Get a serializable snapshot of current room state for UI consumption.

```typescript
interface RoomStateSnapshot {
  position: number;
  paused: boolean;
  setBy: string;
  seq: number;
  speed: number;
  playlist: FileEntry[];
  playlistIndex: number;
  controllers: string[];
  readyStates: Record<string, boolean>;
  peers: PeerState[];
  avatars: Record<string, { presetId: string; customUrl: string; accent: string }>;
  statuses: Record<string, { statusText: string; timestamp: number }>;
}
```

#### `getPeerStats()`
```typescript
getPeerStats(): Array<{ peerId: string; username: string; iceState: string; rtt: number; muted: boolean; isReady: boolean }>
```
Get formatted peer statistics for UI display.

#### `getLatencies()`
```typescript
getLatencies(): Record<string, number>
```
Get per-peer round-trip times in milliseconds.

#### `updateIceState(peerId, state)`
```typescript
updateIceState(peerId: string, state: 'new' | 'checking' | 'connected' | 'disconnected' | 'failed' | 'closed'): void
```
Update a peer's ICE connection state.

---

### Message Dispatch

#### `dispatch(msgType, payload, from?)`
```typescript
dispatch(msgType: MessageType, payload: unknown, from?: string): void
```
Dispatch an incoming data channel message to the appropriate handler. Called by the transport layer.

---

### Config Persistence

#### `saveConfig(key?)`
```typescript
saveConfig(key?: string): void
```
Persist current connection config (host, username, room) to `localStorage`.

#### `loadConfig(key?)` (static)
```typescript
static loadConfig(key?: string): { host: string; username: string; room: string }
```
Load saved config from `localStorage`. Returns defaults if none found.

#### `setLastConfig(host, username, room)`
```typescript
setLastConfig(host: string, username: string, room: string): void
```
Store config for later persistence.

---

### Reconnection

#### `reconnect(connectFn, reason?)`
```typescript
reconnect(connectFn: () => Promise<void>, reason?: string): void
```
Begin reconnection with exponential backoff (2s, 4s, 8s, 16s, 32s). Max 5 attempts.

#### `cancelReconnect()`
```typescript
cancelReconnect(): void
```
Cancel any in-progress reconnection attempt.

---

## PeerState

```typescript
interface PeerState {
  id: string;
  username: string;
  features: string[];
  isReady: boolean;
  isController: boolean;
  isHost: boolean;
  file?: FileMetadata;
  rtt: number;
  muted: boolean;
  iceState: 'new' | 'checking' | 'connected' | 'disconnected' | 'failed' | 'closed';
  avatar?: { presetId: string; customUrl: string; accent: string };
  status?: { text: string; timestamp: number };
}
```

## P2PTransport

```typescript
interface P2PTransport {
  send(msgType: MessageType, payload: unknown): void;
}
```

## IncomingTransfer

```typescript
interface IncomingTransfer {
  transferId: string;
  filename: string;
  totalSize: number;
  chunkSize: number;
  chunks: Map<number, Uint8Array>;
  expectedChunks: number;
  expectedFingerprint: string;
  receivedBytes: number;
}
```

---

## Message Types

```typescript
enum MessageType {
  Hello = 0x01,
  Playstate = 0x02,
  PlaystateRequest = 0x03,
  Chat = 0x04,
  Readiness = 0x05,
  PlaylistChange = 0x06,
  PlaylistRequest = 0x07,
  FileInfo = 0x08,
  FileTransfer = 0x09,
  FileRequest = 0x0a,
  FileResponse = 0x0b,
  LatencyPing = 0x0c,
  LatencyPong = 0x0d,
  HostElected = 0x0e,
  UserInfo = 0x0f,
  PeerDisconnect = 0x10,
  VoiceMute = 0x11,
  SubtitleInfo = 0x12,
  ControllerChange = 0x13,
  AvatarSet = 0x14,
  StatusUpdate = 0x15,
  VoiceFrame = 0x16,
}
```

## Wire Encoding

```typescript
// Encode a typed payload into a wire frame
function encode<T>(msgType: MessageType, payload: T): Uint8Array

// Decode a wire frame header — returns [MessageType, total_frame_length]
function decodeHeader(buf: Uint8Array): [MessageType, number]

// Decode payload from a complete frame — returns [MessageType, payload]
function decode<T>(buf: Uint8Array): [MessageType, T]
```

## PeerDiscovery

```typescript
class PeerDiscovery {
  onPeerFound: PeerFoundCallback | null;
  foundPeers: DiscoveredPeer[];
  foundRooms: DiscoveredRoom[];

  queryServerRooms(signalingUrl: string): Promise<DiscoveredRoom[]>;
  startDiscovery(port?: number, room?: string, username?: string): void;
  stopDiscovery(): void;
  scanOnce(): void;
}
```

## Avatars & Status Presets

12 built-in avatar presets exported as `AVATAR_PRESETS`. 14 built-in status presets exported as `STATUS_PRESETS`. Both available from `syncplay-p2p-client`.
