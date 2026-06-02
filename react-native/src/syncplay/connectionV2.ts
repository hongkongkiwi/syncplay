// Syncplay P2P v2.0.0 — fully self-contained for React Native
// Wire protocol: [4B type u32 BE][4B len u32 BE][N bytes msgpack]
//
// Contains (all inline, no workspace imports):
//  - 20 message types + payloads
//  - Wire encode/decode
//  - P2PStateManager (room state, handlers, host election, latency, controllers, chat, emojis, slash commands, loops, events)
//  - P2PConnection (WebSocket signaling → RTCPeerConnection + DataChannel → dispatch to stateManager)

import { encode as msgpackEncode, decode as msgpackDecode } from "msgpackr";

// ══════════════════════════════════════════════════════════════════════════════
// 1. Message types & payloads (20 types, mirrors Rust syncplay-p2p messages.rs)
// ══════════════════════════════════════════════════════════════════════════════

export enum MessageType {
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
  VoiceFrame = 0x14,
}

// ── Payload interfaces ──────────────────────────────────────────────────────

export interface HelloPayload {
  username: string;
  version: string;
  room: string;
  features: string[];
}

export interface PlaystatePayload {
  position: number;
  paused: boolean;
  doSeek: boolean;
  setBy: string;
  seq: number;
  timestamp: number;
  speed: number;
}

export enum PlaystateAction {
  Seek = "seek",
  Pause = "pause",
  Play = "play",
  SetSpeed = "set_speed",
}

export interface PlaystateRequestPayload {
  action: PlaystateAction | { SetSpeed: number };
  position: number;
  requestId: string;
}

export interface ChatPayload {
  from: string;
  message: string;
  timestamp: number;
}

export interface ReadinessPayload {
  username: string;
  isReady: boolean;
  manuallyInitiated: boolean;
  setBy: string;
}

export interface FileEntry {
  name: string;
  duration: number;
}

export enum PlaylistAction {
  SetPlaylist = "set_playlist",
  SetIndex = "set_index",
}

export interface PlaylistChangePayload {
  files: FileEntry[];
  index: number;
  setBy: string;
}

export interface PlaylistRequestPayload {
  action: PlaylistAction;
  files: FileEntry[];
  index: number;
}

export interface FileMetadata {
  name: string;
  duration: number;
  size: number;
  checksum?: string;
}

export interface FileInfoPayload {
  username: string;
  file?: FileMetadata;
}

export interface FileTransferPayload {
  transferId: string;
  chunkIndex: number;
  offset: number;
  totalSize: number;
  chunkSize: number;
  data: Uint8Array;
}

export interface FileRequestPayload {
  transferId: string;
  filename: string;
  offset: number;
  fingerprint: string;
}

export interface FileResponsePayload {
  transferId: string;
  accepted: boolean;
  reason: string;
  fingerprint: string;
  chunkSize: number;
}

export interface LatencyPingPayload {
  sendTime: number;
}

export interface LatencyPongPayload {
  sendTime: number;
  receiveTime: number;
}

export interface HostElectedPayload {
  hostId: string;
  reason: string;
}

export interface UserInfoPayload {
  username: string;
  features: string[];
}

export interface PeerDisconnectPayload {
  reason: string;
}

export interface VoiceMutePayload {
  muted: boolean;
}

export interface SubtitleTrack {
  filename: string;
  size: number;
  language?: string;
}

export interface SubtitleInfoPayload {
  subtitles: SubtitleTrack[];
}

export enum ControllerAction {
  Add = "add",
  Remove = "remove",
}

export interface ControllerChangePayload {
  peer_id: string;
  action: ControllerAction;
}

// ── Payload builders ────────────────────────────────────────────────────────

export function helloPayload(
  username: string,
  version: string,
  room: string,
  features: string[],
): HelloPayload {
  return { username, version, room, features };
}

export function playstatePayload(
  position: number,
  paused: boolean,
  doSeek: boolean,
  setBy: string,
  seq: number,
  speed = 1.0,
): PlaystatePayload {
  return {
    position,
    paused,
    doSeek,
    setBy,
    seq,
    timestamp: Date.now(),
    speed,
  };
}

export function chatPayload(from: string, message: string): ChatPayload {
  return { from, message, timestamp: Date.now() };
}

export function readinessPayload(
  username: string,
  isReady: boolean,
  manuallyInitiated: boolean,
  setBy: string,
): ReadinessPayload {
  return { username, isReady, manuallyInitiated, setBy };
}

export function playstateRequestSeek(position: number): PlaystateRequestPayload {
  return {
    action: PlaystateAction.Seek,
    position,
    requestId: uuidv4(),
  };
}

export function playstateRequestPause(): PlaystateRequestPayload {
  return {
    action: PlaystateAction.Pause,
    position: 0,
    requestId: uuidv4(),
  };
}

export function playstateRequestPlay(): PlaystateRequestPayload {
  return {
    action: PlaystateAction.Play,
    position: 0,
    requestId: uuidv4(),
  };
}

export function playstateRequestSetSpeed(speed: number): PlaystateRequestPayload {
  return {
    action: { SetSpeed: speed },
    position: 0,
    requestId: uuidv4(),
  };
}

export function peerDisconnectPayload(reason: string): PeerDisconnectPayload {
  return { reason };
}

// ── UUID v4 helper (avoids crypto.randomUUID availability issues in some RN envs) ──

function uuidv4(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. Wire encoding (mirrors packages/p2p-client/src/wire.ts)
// ══════════════════════════════════════════════════════════════════════════════

const HEADER_SIZE = 8;
const MAX_PAYLOAD = 10 * 1024 * 1024; // 10 MB

/** Encode a typed payload into a wire frame. */
export function encode<T>(msgType: MessageType, payload: T): Uint8Array<ArrayBuffer> {
  const msgpackResult = msgpackEncode(payload);
  const bodyLen = msgpackResult.byteLength;
  if (bodyLen > MAX_PAYLOAD) {
    throw new Error(`Payload too large: ${bodyLen} > ${MAX_PAYLOAD}`);
  }
  const totalLen = HEADER_SIZE + bodyLen;
  const frameBuf = new ArrayBuffer(totalLen);
  const frame = new Uint8Array(frameBuf);
  const view = new DataView(frameBuf);
  view.setUint32(0, msgType, false); // big-endian
  view.setUint32(4, bodyLen, false);
  for (let i = 0; i < bodyLen; i++) {
    frame[HEADER_SIZE + i] = msgpackResult[i]!;
  }
  return frame;
}

/** Decode header from incomplete buffer. Returns [type, fullFrameLen]. */
export function decodeHeader(buf: Uint8Array): [MessageType, number] {
  if (buf.byteLength < HEADER_SIZE) {
    throw new Error(`Incomplete header: have ${buf.byteLength} bytes`);
  }
  const bufArr = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const view = new DataView(bufArr);
  const rawType = view.getUint32(0, false);
  const payloadLen = view.getUint32(4, false);
  if (payloadLen > MAX_PAYLOAD) {
    throw new Error(`Oversized payload: ${payloadLen} > ${MAX_PAYLOAD}`);
  }
  return [rawType as MessageType, HEADER_SIZE + payloadLen];
}

/** Decode a complete frame. Returns [type, payload]. */
export function decode<T>(buf: Uint8Array): [MessageType, T] {
  const [msgType, frameLen] = decodeHeader(buf);
  const body = buf.slice(HEADER_SIZE, frameLen);
  return [msgType, msgpackDecode(body) as T];
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. P2PStateManager — full room state, handlers, host election, latency, etc.
// ══════════════════════════════════════════════════════════════════════════════

// ── State shapes ────────────────────────────────────────────────────────────

export interface PeerState {
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
}

export interface RoomStateSnapshot {
  position: number;
  paused: boolean;
  setBy: string;
  seq: number;
  speed: number;
  playlist: FileEntry[];
  playlistIndex: number;
  controllers: string[];   // serialisable: username[]
  readyStates: Record<string, boolean>; // username → ready
  peers: Record<string, PeerState>;    // peerId → PeerState
}

export type ConnectionState =
  'offline' | 'connecting' | 'handshaking' | 'connecting_peers' | 'ready' | 'reconnecting' | 'error';

export type SyncEventType =
  'chat' | 'playstate' | 'user-join' | 'user-leave' | 'host-change' | 'error';

export interface SyncEvent {
  type: SyncEventType;
  data?: unknown;
  timestamp: number;
}

// ── Transport interface (P2PConnection implements this) ─────────────────────

export interface P2PTransport {
  send(msgType: MessageType, payload: unknown): void;
}

type EventHandlerFn = (event: SyncEvent) => void;

// ── Defaults ────────────────────────────────────────────────────────────────

const DEF_SYNC_INTERVAL = 500;   // ms — host broadcasts Playstate
const DEF_PING_INTERVAL = 2000;  // ms — latency pings
const MAX_CHAT_HISTORY = 2000;
const MAX_PLAYLIST = 250;
const PROTOCOL_VERSION = '2.0.0';
const LATENCY_WARN_MS = 500;

// ── Emoji shortcodes (39 codes, mirrors Rust TUI) ──────────────────────────

const EMOJIS: Record<string, string> = {
  ':smile:': '😊', ':joy:': '😂', ':heart:': '❤️', ':thumbsup:': '👍',
  ':thumbsdown:': '👎', ':clap:': '👏', ':wave:': '👋', ':fire:': '🔥',
  ':star:': '⭐', ':tada:': '🎉', ':100:': '💯', ':ok_hand:': '👌',
  ':sob:': '😭', ':cry:': '😢', ':angry:': '😠', ':skull:': '💀',
  ':rocket:': '🚀', ':check:': '✅', ':x:': '❌', ':warning:': '⚠️',
  ':popcorn:': '🍿', ':movie_camera:': '🎥', ':beer:': '🍺', ':coffee:': '☕',
  ':sunglasses:': '😎', ':wink:': '😉', ':pray:': '🙏', ':muscle:': '💪',
  ':party:': '🥳', ':robot:': '🤖', ':alien:': '👽', ':ghost:': '👻',
  ':sleepy:': '😴', ':zap:': '⚡', ':bulb:': '💡', ':lock:': '🔒',
  ':headphones:': '🎧', ':mic:': '🎤', ':mute:': '🔇',
};

// ── P2PStateManager ─────────────────────────────────────────────────────────

export class P2PStateManager {
  // Internal mutable room state
  private _room: {
    position: number;
    paused: boolean;
    setBy: string;
    seq: number;
    speed: number;
    playlist: FileEntry[];
    playlistIndex: number;
    controllers: Set<string>;
    readyStates: Map<string, boolean>;
    peers: Map<string, PeerState>;
  };

  private hostId = '';
  private peerId = '';
  private username = '';
  private latencyMap = new Map<string, number>();
  private voiceMutes = new Map<string, boolean>();
  private eventHandlers: EventHandlerFn[] = [];
  private syncIntervalId: ReturnType<typeof setInterval> | null = null;
  private pingIntervalId: ReturnType<typeof setInterval> | null = null;
  private syncIntervalMs = DEF_SYNC_INTERVAL;
  private pingIntervalMs = DEF_PING_INTERVAL;
  private _connectionState: ConnectionState = 'offline';
  private _transport: P2PTransport | null = null;
  private _connected = false;
  private _reconnectAttempts = 0;
  private _lastConfig: { host: string; username: string; room: string } | null = null;

  /** Called by transport when reconnection succeeds */
  onReconnectSuccess: (() => void) | null = null;

  constructor(
    username: string,
    features: string[] = ['chat', 'readiness', 'playlist'],
  ) {
    this.username = username;
    this._room = {
      position: 0,
      paused: true,
      setBy: '',
      seq: 0,
      speed: 1.0,
      playlist: [],
      playlistIndex: 0,
      controllers: new Set<string>(),
      readyStates: new Map<string, boolean>(),
      peers: new Map<string, PeerState>(),
    };
  }

  // ── Read-only accessors ───────────────────────────────────────────────────

  get connectionState(): ConnectionState { return this._connectionState; }
  get isConnected(): boolean { return this._connected; }
  get isHost(): boolean { return this.peerId !== '' && this.peerId === this.hostId; }
  get myUsername(): string { return this.username; }
  get myPeerId(): string { return this.peerId; }

  /** Serializable snapshot for UI consumption */
  getSnapshot(): RoomStateSnapshot {
    const readyStates: Record<string, boolean> = {};
    this._room.readyStates.forEach((v, k) => { readyStates[k] = v; });
    const peers: Record<string, PeerState> = {};
    this._room.peers.forEach((v, k) => { peers[k] = v; });
    return {
      position: this._room.position,
      paused: this._room.paused,
      setBy: this._room.setBy,
      seq: this._room.seq,
      speed: this._room.speed,
      playlist: [...this._room.playlist],
      playlistIndex: this._room.playlistIndex,
      controllers: [...this._room.controllers],
      readyStates,
      peers,
    };
  }

  // ── Connection lifecycle ──────────────────────────────────────────────────

  setConnectionState(s: ConnectionState, error?: string): void {
    this._connectionState = s;
    if (s === 'error') {
      this.emit({ type: 'error', data: error ?? 'Connection error', timestamp: Date.now() });
    }
  }

  /** Called by transport once signaling handshake completes */
  onConnected(peerId: string, hostId: string, transport: P2PTransport): void {
    this.peerId = peerId;
    this.hostId = hostId;
    this._transport = transport;
    this._connected = true;
    this.setConnectionState('ready');
    this.startLoop();
  }

  /** Called by transport on disconnect */
  onDisconnected(reason: string): void {
    this.stopLoop();
    this._connected = false;
    this.peerId = '';
    this.hostId = '';
    this._transport = null;
    this.setConnectionState('offline');
  }

  // ── Event system ──────────────────────────────────────────────────────────

  onSyncEvent(handler: EventHandlerFn): void {
    this.eventHandlers.push(handler);
  }

  offSyncEvent(handler: EventHandlerFn): void {
    this.eventHandlers = this.eventHandlers.filter(h => h !== handler);
  }

  private emit(event: SyncEvent): void {
    for (const h of this.eventHandlers) {
      try { h(event); } catch (e) { /* swallow */ }
    }
  }

  // ── Background loops ──────────────────────────────────────────────────────

  private startLoop(): void {
    this.stopLoop();
    this.syncIntervalId = setInterval(() => this.hostTick(), this.syncIntervalMs);
    this.pingIntervalId = setInterval(() => this.pingAll(), this.pingIntervalMs);
  }

  private stopLoop(): void {
    if (this.syncIntervalId !== null) { clearInterval(this.syncIntervalId); this.syncIntervalId = null; }
    if (this.pingIntervalId !== null) { clearInterval(this.pingIntervalId); this.pingIntervalId = null; }
  }

  /** Host broadcasts position every syncIntervalMs */
  private hostTick(): void {
    if (!this._connected || !this.isHost || !this._transport) return;
    this._transport.send(MessageType.Playstate, playstatePayload(
      this._room.position,
      this._room.paused,
      false,          // doSeek=false for periodic sync
      this.username,
      ++this._room.seq,
      this._room.speed,
    ));
  }

  /** Ping each peer for latency measurement */
  private pingAll(): void {
    if (!this._connected || !this._transport) return;
    for (const [id] of this._room.peers) {
      if (id !== this.peerId) {
        this._transport.send(MessageType.LatencyPing, { sendTime: Date.now() } as LatencyPingPayload);
      }
    }
  }

  // ── Chat ──────────────────────────────────────────────────────────────────

  sendChat(text: string): void {
    if (!this._connected || !this._transport) return;
    const expanded = this.expandEmojis(text);
    this._transport.send(MessageType.Chat, chatPayload(this.username, expanded));
  }

  /** Process a slash-command. Returns response string, or null if not a command. */
  sendSlashCommand(cmd: string): string | null {
    const parts = cmd.slice(1).split(/\s+/);
    const name = (parts[0] ?? '').toLowerCase();
    const args = parts.slice(1);

    switch (name) {
      case 'help': case 'h': return this.helpText();
      case 'me': return `* ${this.username} ${args.join(' ')}`;
      case 'nick': return 'Nickname: use the settings to change your username';
      case 'users': case 'who': return this.formatPeerList();
      case 'ready': {
        const cur = this._room.readyStates.get(this.username) ?? false;
        this.setReady(!cur);
        return null;
      }
      case 'leave': return '/leave sent — disconnect to leave the room';
      case 'version': return `Syncplay P2P v${PROTOCOL_VERSION}`;
      case 'shrug': return '¯\\_(ツ)_/¯';
      case 'tableflip': case 'flip': return '(╯°□°）╯︵ ┻━┻';
      case 'unflip': return '┬─┬ ノ( ゜-゜ノ)';
      case 'lenny': return '( ͡° ͜ʖ ͡°)';
      case 'controller': {
        if (!this.isHost) return 'Only the host can manage controllers';
        if (args[0] === 'add' && args[1]) { this.addController(args[1]); return `${args[1]} can now control playback`; }
        if (args[0] === 'remove' && args[1]) { this.removeController(args[1]); return `${args[1]} can no longer control playback`; }
        return 'Usage: /controller add|remove <username>';
      }
      case 'playlist': {
        if (args[0] === 'add' && args[1]) {
          this.addToPlaylist(args.slice(1).join(',').split(',').map(s => s.trim()).filter(Boolean));
          return 'Added to playlist';
        }
        if (args[0] === 'index' && args[1]) {
          this.setPlaylistIndex(parseInt(args[1]!, 10));
          return 'Playlist index set';
        }
        if (args[0] === 'clear') { this.clearPlaylist(); return 'Playlist cleared'; }
        return 'Usage: /playlist add|index|clear';
      }
      case 'settings': return this.settingsText();
      case 'cancel': return 'Transfers cannot be cancelled mid-flight';
      case 'react': {
        if (args[0] && args[1]) {
          return `${this.username} reacted to message ${args[0]}: ${this.expandEmojis(args[1]!)}`;
        }
        return 'Usage: /react <n> :emoji:';
      }
      case 'send': case 'download': case 'dl': case 'file': {
        if (args[0]) {
          this.requestFile(this.peerId, args[0]);
          return `Requesting file: ${args[0]}`;
        }
        return 'Usage: /send <filename>';
      }
      default: return null;
    }
  }

  // ── Playback control ──────────────────────────────────────────────────────

  updatePlaystate(position: number, paused: boolean): void {
    if (!this._connected) return;
    if (!this.isHost) {
      this.requestSeek(position);
      return;
    }
    this._room.position = position;
    this._room.paused = paused;
    this._room.setBy = this.username;
    if (this._transport) {
      this._transport.send(MessageType.Playstate, playstatePayload(
        position, paused, true, this.username, ++this._room.seq, this._room.speed,
      ));
    }
  }

  requestSeek(position: number): void {
    if (!this._connected || !this._transport) return;
    if (this.isHost) {
      this.updatePlaystate(position, this._room.paused);
    } else {
      this._transport.send(MessageType.PlaystateRequest, playstateRequestSeek(position));
    }
  }

  requestPause(): void {
    if (!this._connected || !this._transport) return;
    if (this.isHost) { this.updatePlaystate(this._room.position, true); } else {
      this._transport.send(MessageType.PlaystateRequest, playstateRequestPause());
    }
  }

  requestPlay(): void {
    if (!this._connected || !this._transport) return;
    if (this.isHost) { this.updatePlaystate(this._room.position, false); } else {
      this._transport.send(MessageType.PlaystateRequest, playstateRequestPlay());
    }
  }

  requestSetSpeed(speed: number): void {
    if (!this._connected || !this._transport) return;
    if (this.isHost) { this._room.speed = speed; this.updatePlaystate(this._room.position, this._room.paused); } else {
      this._transport.send(MessageType.PlaystateRequest, playstateRequestSetSpeed(speed));
    }
  }

  // ── Readiness ─────────────────────────────────────────────────────────────

  setReady(isReady: boolean): void {
    if (!this._connected || !this._transport) return;
    this._room.readyStates.set(this.username, isReady);
    this._transport.send(MessageType.Readiness, readinessPayload(
      this.username, isReady, true, this.username,
    ));
  }

  // ── Playlist ──────────────────────────────────────────────────────────────

  addToPlaylist(files: string[]): void {
    if (!this._connected) return;
    const entries: FileEntry[] = files.map(f => ({ name: f, duration: 0 }));
    if (!this.isHost && this._transport) {
      this._transport.send(MessageType.PlaylistRequest, {
        action: PlaylistAction.SetPlaylist,
        files: entries,
        index: this._room.playlistIndex,
      } as PlaylistRequestPayload);
      return;
    }
    const combined = [...this._room.playlist, ...entries].slice(0, MAX_PLAYLIST);
    this._room.playlist = combined;
    this.broadcastPlaylist();
  }

  setPlaylistIndex(idx: number): void {
    if (!this._connected) return;
    if (!this.isHost && this._transport) {
      this._transport.send(MessageType.PlaylistRequest, {
        action: PlaylistAction.SetIndex,
        files: [],
        index: idx,
      } as PlaylistRequestPayload);
      return;
    }
    if (idx >= 0 && idx < this._room.playlist.length) {
      this._room.playlistIndex = idx;
      this._room.position = 0;
    }
    this.broadcastPlaylist();
  }

  clearPlaylist(): void {
    this._room.playlist = [];
    this._room.playlistIndex = 0;
    this.broadcastPlaylist();
  }

  private broadcastPlaylist(): void {
    if (!this._connected || !this.isHost || !this._transport) return;
    this._transport.send(MessageType.PlaylistChange, {
      files: this._room.playlist,
      index: this._room.playlistIndex,
      setBy: this.username,
    } as PlaylistChangePayload);
  }

  // ── File info ─────────────────────────────────────────────────────────────

  sendFileInfo(file?: FileMetadata): void {
    if (!this._connected || !this.isHost || !this._transport) return;
    this._transport.send(MessageType.FileInfo, { username: this.username, file } as FileInfoPayload);
  }

  // ── Controllers ───────────────────────────────────────────────────────────

  addController(uname: string): void {
    if (!this._connected) return;
    this._room.controllers.add(uname);
    if (this.isHost && this._transport) {
      this._transport.send(MessageType.ControllerChange, {
        peer_id: uname,
        action: ControllerAction.Add,
      } as ControllerChangePayload);
    }
  }

  removeController(uname: string): void {
    if (!this._connected) return;
    this._room.controllers.delete(uname);
    if (this.isHost && this._transport) {
      this._transport.send(MessageType.ControllerChange, {
        peer_id: uname,
        action: ControllerAction.Remove,
      } as ControllerChangePayload);
    }
  }

  isController(username_: string): boolean {
    return username_ === this.username || this._room.controllers.has(username_);
  }

  // ── Voice ─────────────────────────────────────────────────────────────────

  sendVoiceMute(muted: boolean): void {
    if (!this._connected || !this._transport) return;
    this.voiceMutes.set(this.username, muted);
    this._transport.send(MessageType.VoiceMute, { muted } as VoiceMutePayload);
  }

  toggleMute(): boolean {
    const current = this.voiceMutes.get(this.username) ?? false;
    this.sendVoiceMute(!current);
    return !current;
  }

  /** Callback for incoming VoiceFrame payloads (raw audio data). Set by VoiceChat. */
  voiceFrameHandler: ((data: Uint8Array) => void) | null = null;

  sendVoiceFrame(data: Uint8Array, seq: number): void {
    if (!this._connected || !this._transport) return;
    if (this.voiceMutes.get(this.username) ?? false) return;
    this._transport.send(MessageType.VoiceFrame, {
      data,
      timestamp: Date.now(),
      seq,
    });
  }

  // ── File transfer (stub — full implementation needs chunk assembly) ───────

  requestFile(peerId_: string, filename: string, offset = 0): void {
    if (!this._connected || !this._transport) return;
    this._transport.send(MessageType.FileRequest, {
      transferId: uuidv4(),
      filename,
      offset,
      fingerprint: '',
    } as FileRequestPayload);
  }

  // ── Message dispatch (called by transport on each incoming message) ───────

  dispatch(msgType: MessageType, payload: unknown, from?: string): void {
    switch (msgType) {
      case MessageType.Hello: return this.handleHello(payload as HelloPayload);
      case MessageType.Playstate: return this.handlePlaystate(payload as PlaystatePayload);
      case MessageType.PlaystateRequest: return this.handlePlaystateRequest(payload as PlaystateRequestPayload);
      case MessageType.Chat: return this.handleChat(payload as ChatPayload);
      case MessageType.Readiness: return this.handleReadiness(payload as ReadinessPayload);
      case MessageType.PlaylistChange: return this.handlePlaylistChange(payload as PlaylistChangePayload);
      case MessageType.PlaylistRequest: return this.handlePlaylistRequest(payload as PlaylistRequestPayload);
      case MessageType.FileInfo: return this.handleFileInfo(payload as FileInfoPayload);
      case MessageType.FileTransfer: return this.handleFileTransfer(payload as FileTransferPayload);
      case MessageType.FileResponse: return this.handleFileResponse(payload as FileResponsePayload);
      case MessageType.LatencyPing: return this.handleLatencyPing(payload as LatencyPingPayload);
      case MessageType.LatencyPong: return this.handleLatencyPong(payload as LatencyPongPayload, from);
      case MessageType.HostElected: return this.handleHostElected(payload as HostElectedPayload);
      case MessageType.UserInfo: return this.handleUserInfo(payload as UserInfoPayload);
      case MessageType.PeerDisconnect: return this.handlePeerDisconnect(payload as PeerDisconnectPayload, from);
      case MessageType.VoiceMute: return this.handleVoiceMute(payload as VoiceMutePayload);
      case MessageType.VoiceFrame: {
        const vp = payload as { data: Uint8Array; timestamp: number; seq: number };
        if (this.voiceFrameHandler) {
          try { this.voiceFrameHandler(vp.data); } catch (e) { /* swallow */ }
        }
        return;
      }
      case MessageType.SubtitleInfo: return this.handleSubtitleInfo(payload as SubtitleInfoPayload);
      case MessageType.ControllerChange: return this.handleControllerChange(payload as ControllerChangePayload);
      case MessageType.FileRequest: {
        // TODO: auto-respond to incoming file requests
        break;
      }
    }
  }

  // ── Message handlers ──────────────────────────────────────────────────────

  private handleHello(p: HelloPayload): void {
    if (p.version !== PROTOCOL_VERSION) {
      console.warn(`[P2P] Version mismatch: peer=${p.version} us=${PROTOCOL_VERSION}`);
    }
    // Add peer to room state if not already present
    if (!this._room.peers.has(p.username)) {
      const peer: PeerState = {
        id: p.username,
        username: p.username,
        features: p.features ?? [],
        isReady: false,
        isController: false,
        isHost: false,
        rtt: 0,
        muted: false,
        iceState: 'new',
      };
      this._room.peers.set(p.username, peer);
      this.emit({ type: 'user-join', data: { username: p.username }, timestamp: Date.now() });
      // Replay current state to the newly joined peer
      this.sendStateTo(p.username);
    }
  }

  private handlePlaystate(p: PlaystatePayload): void {
    // Seq-based dedup
    if (p.seq <= this._room.seq && p.setBy === this._room.setBy) return;
    // Latency compensation
    const latency = p.setBy ? (this.latencyMap.get(p.setBy) ?? 0) : 0;
    const speed = p.speed ?? 1.0;
    this._room.position = p.position + (Date.now() - p.timestamp) * speed / 1000 + latency * speed;
    this._room.paused = p.paused;
    this._room.setBy = p.setBy;
    this._room.seq = p.seq;
    this._room.speed = speed;
    this.emit({ type: 'playstate', data: this.getSnapshot(), timestamp: Date.now() });
  }

  private handlePlaystateRequest(p: PlaystateRequestPayload): void {
    if (!this.isHost) return;
    const controller = this._room.setBy || p.requestId;
    if (!this.isController(controller) && controller !== this.username) {
      console.warn('[P2P] PlaystateRequest denied — not a controller');
      return;
    }
    if (typeof p.action === 'object' && 'SetSpeed' in p.action) {
      this._room.speed = p.action.SetSpeed;
      this.updatePlaystate(this._room.position, this._room.paused);
    } else {
      switch (p.action) {
        case PlaystateAction.Seek:
          this.updatePlaystate(p.position || this._room.position, this._room.paused);
          break;
        case PlaystateAction.Pause:
          this.updatePlaystate(this._room.position, true);
          break;
        case PlaystateAction.Play:
          this.updatePlaystate(this._room.position, false);
          break;
      }
    }
  }

  private handleChat(p: ChatPayload): void {
    if (p.from === this.username) return;
    this.emit({
      type: 'chat',
      data: { from: p.from, message: this.expandEmojis(p.message), timestamp: p.timestamp },
      timestamp: Date.now(),
    });
  }

  private handleReadiness(p: ReadinessPayload): void {
    this._room.readyStates.set(p.username, p.isReady);
    // Mesh P2P: every peer receives the original message directly via their DataChannel.
    // No host relay needed — relaying would cause duplicate readiness updates.
  }

  private handlePlaylistChange(p: PlaylistChangePayload): void {
    if (p.setBy === this.username) return;
    this._room.playlist = p.files;
    this._room.playlistIndex = p.index;
  }

  private handlePlaylistRequest(p: PlaylistRequestPayload): void {
    if (!this.isHost) return;
    if (p.action === PlaylistAction.SetPlaylist) {
      this._room.playlist = p.files.slice(0, MAX_PLAYLIST);
      this.broadcastPlaylist();
    } else if (p.action === PlaylistAction.SetIndex) {
      this.setPlaylistIndex(p.index);
    }
  }

  private handleFileInfo(p: FileInfoPayload): void {
    const peer = this._room.peers.get(p.username);
    if (peer) {
      if (p.file !== undefined) {
        peer.file = p.file;
      } else {
        // exactOptionalPropertyTypes prevents assigning undefined — use delete
        delete (peer as unknown as Record<string, unknown>).file;
      }
    }
  }

  private handleFileTransfer(p: FileTransferPayload): void {
    console.log(`[P2P] FileTransfer chunk ${p.chunkIndex}/${Math.ceil(p.totalSize / p.chunkSize)} from transfer ${p.transferId}`);
  }

  private handleFileResponse(p: FileResponsePayload): void {
    if (p.accepted) {
      console.log(`[P2P] File transfer ${p.transferId} accepted, fingerprint: ${p.fingerprint}`);
    } else {
      console.log(`[P2P] File transfer ${p.transferId} rejected: ${p.reason}`);
    }
  }

  private handleLatencyPing(p: LatencyPingPayload): void {
    if (!this._connected || !this._transport) return;
    this._transport.send(MessageType.LatencyPong, {
      sendTime: p.sendTime,
      receiveTime: Date.now(),
    } as LatencyPongPayload);
  }

  private handleLatencyPong(p: LatencyPongPayload, from?: string): void {
    const rtt = Date.now() - p.sendTime;
    const peerKey = from ?? 'peer';
    this.latencyMap.set(peerKey, rtt);
    // Update per-peer RTT in the peers map
    if (from) {
      const peer = this._room.peers.get(from);
      if (peer) peer.rtt = rtt;
    }
    if (rtt > LATENCY_WARN_MS) {
      console.warn(`[P2P] High latency to ${peerKey}: ${rtt.toFixed(0)}ms`);
    }
  }

  private handleHostElected(p: HostElectedPayload): void {
    this.hostId = p.hostId;
    const peer = this._room.peers.get(p.hostId);
    if (peer) {
      peer.isHost = true;
      this._room.controllers.add(peer.username);
    }
    this.emit({
      type: 'host-change',
      data: { hostId: p.hostId, reason: p.reason },
      timestamp: Date.now(),
    });
  }

  private handleUserInfo(p: UserInfoPayload): void {
    let peer = this._room.peers.get(p.username);
    if (!peer) {
      // Peer not yet tracked — create entry
      peer = {
        id: p.username,
        username: p.username,
        features: p.features,
        isReady: false,
        isController: false,
        isHost: false,
        rtt: 0,
        muted: false,
        iceState: 'new',
      };
      this._room.peers.set(p.username, peer);
      this.emit({ type: 'user-join', data: { username: p.username }, timestamp: Date.now() });
    } else {
      peer.features = p.features;
    }
  }

  private handlePeerDisconnect(p: PeerDisconnectPayload, from?: string): void {
    console.log(`[P2P] Peer left: ${p.reason} (from=${from ?? 'unknown'})`);
    if (from && this._room.peers.has(from)) {
      this._room.peers.delete(from);
      this._room.readyStates.delete(from);
      this.emit({ type: 'user-leave', data: { username: from, reason: p.reason }, timestamp: Date.now() });
    }
  }

  private handleVoiceMute(p: VoiceMutePayload): void {
    console.log(`[P2P] Voice mute update: ${p.muted}`);
  }

  private handleSubtitleInfo(p: SubtitleInfoPayload): void {
    this.emit({
      type: 'chat',
      data: {
        from: 'system',
        message: `Subtitles available: ${p.subtitles.map(t => t.filename + (t.language ? ` [${t.language}]` : '')).join(', ')}`,
        timestamp: Date.now(),
      },
      timestamp: Date.now(),
    });
  }

  private handleControllerChange(p: ControllerChangePayload): void {
    if (p.action === ControllerAction.Add) {
      this._room.controllers.add(p.peer_id);
    } else {
      this._room.controllers.delete(p.peer_id);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private expandEmojis(msg: string): string {
    return msg.replace(/:\w+:/g, m => EMOJIS[m] ?? m);
  }

  private formatPeerList(): string {
    const names: string[] = [];
    for (const [, p] of this._room.peers) {
      let line = p.username;
      if (p.isHost) line += ' (host)';
      if (p.file) line += ` [${p.file.name}]`;
      names.push(line);
    }
    return names.length ? names.join(', ') : 'No peers connected';
  }

  private settingsText(): string {
    return [
      `Room: ${this.username} → ${this._room.setBy || 'none'}`,
      `Position: ${this._room.position.toFixed(1)}s ${this._room.paused ? '||' : '▶'}`,
      `Speed: ${this._room.speed}x`,
      `Playlist: ${this._room.playlist.length} items, index ${this._room.playlistIndex}`,
      `Peers: ${this._room.peers.size}`,
      `Controllers: ${[...this._room.controllers].join(',') || 'none'}`,
      `Protocol: v${PROTOCOL_VERSION}`,
    ].join('\n');
  }

  private helpText(): string {
    return `Syncplay P2P v${PROTOCOL_VERSION} — Commands:
  /help — this list
  /me <action> — send action
  /users — list peers
  /ready — toggle ready
  /leave — disconnect
  /version — show version
  /controller add|remove <user> — manage controllers (host)
  /playlist add|index|clear — manage playlist
  /settings — show room state
  /shrug /tableflip /lenny — fun stuff
  /react <n> :emoji: — react to message`;
  }

  /** Send full current state to a newly joined peer so they can catch up. */
  sendStateTo(peerId: string): void {
    if (!this._connected || !this._transport) return;
    // Send current playstate
    this._transport.send(MessageType.Playstate, playstatePayload(
      this._room.position,
      this._room.paused,
      true, // doSeek so the peer applies it immediately
      this.username,
      this._room.seq,
      this._room.speed,
    ));
    // Send current playlist
    this._transport.send(MessageType.PlaylistChange, {
      files: this._room.playlist,
      index: this._room.playlistIndex,
      setBy: this.username,
    } as PlaylistChangePayload);
    // Send readiness for all peers
    for (const [uname, ready] of this._room.readyStates) {
      this._transport.send(MessageType.Readiness, readinessPayload(
        uname, ready, false, this.username,
      ));
    }
    // Send controller list
    for (const ctrl of this._room.controllers) {
      this._transport.send(MessageType.ControllerChange, {
        peer_id: ctrl,
        action: ControllerAction.Add,
      } as ControllerChangePayload);
    }
  }

  /** Update ICE connection state for a specific peer */
  updateIceState(peerId: string, state: PeerState['iceState']): void {
    const peer = this._room.peers.get(peerId);
    if (peer) peer.iceState = state;
  }

  /** Return stats for all known peers */
  getPeerStats(): PeerState[] {
    return [...this._room.peers.values()];
  }

  /** Attempt reconnection with exponential backoff */
  reconnect(connectFn: () => Promise<void>, reason?: string): void {
    if (this._reconnectAttempts >= 5) {
      this.setConnectionState('error', 'Max reconnect attempts reached');
      return;
    }
    this._reconnectAttempts++;
    this.setConnectionState('reconnecting');
    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts - 1), 30000);
    console.log(`[P2P] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts}/5): ${reason ?? 'unknown'}`);
    setTimeout(async () => {
      try {
        await connectFn();
        this._reconnectAttempts = 0;
        if (this.onReconnectSuccess) this.onReconnectSuccess();
      } catch {
        // connect() will call setConnectionState('error') on failure
      }
    }, delay);
  }

  /** Store last config for reconnect */
  setLastConfig(host: string, username: string, room: string): void {
    this._lastConfig = { host, username, room };
  }

  /** Persist config to storage (in-memory fallback for RN) */
  saveConfig(key: string): void {
    this._lastConfig = this._lastConfig ?? { host: '', username: '', room: '' };
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, JSON.stringify(this._lastConfig));
      }
    } catch { /* storage unavailable */ }
  }

  /** Load persisted config (in-memory fallback for RN) */
  static loadConfig(key: string): { host: string; username: string; room: string } {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(key);
        if (raw) return JSON.parse(raw) as { host: string; username: string; room: string };
      }
    } catch { /* storage unavailable */ }
    return { host: '', username: '', room: '' };
  }

  destroy(): void {
    this.stopLoop();
    this.eventHandlers = [];
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. Error UX
// ══════════════════════════════════════════════════════════════════════════════

/** Machine-readable error codes for connection failures. */
export enum ErrorCode {
  SignalingUnreachable = 'SIGNALING_UNREACHABLE',
  ServerRejected = 'SERVER_REJECTED',
  DataChannelClosed = 'DATA_CHANNEL_CLOSED',
  InternalError = 'INTERNAL_ERROR',
  Unknown = 'UNKNOWN',
}

/**
 * Map a raw error message to a user-friendly message and ErrorCode.
 * All connection error handlers should pass raw errors through this function
 * before displaying to the user.
 */
export function humanReadableError(raw: string): { code: ErrorCode; message: string } {
  const lowered = raw.toLowerCase();

  if (lowered.includes('signaling server unreachable') || lowered.includes('unreachable')) {
    return {
      code: ErrorCode.SignalingUnreachable,
      message: 'Cannot reach the signaling server. Check the host address.',
    };
  }

  if (lowered.includes('server rejected connection') || lowered.includes('rejected')) {
    return {
      code: ErrorCode.ServerRejected,
      message: 'Connection rejected. Check room name and password.',
    };
  }

  if (lowered.includes('data channel closed unexpectedly') || lowered.includes('unexpected')) {
    return {
      code: ErrorCode.DataChannelClosed,
      message: 'Connection lost. Attempting to reconnect...',
    };
  }

  if (lowered.includes('websocket was null') || lowered.includes('internal')) {
    return {
      code: ErrorCode.InternalError,
      message: 'Internal error. Please try again.',
    };
  }

  return { code: ErrorCode.Unknown, message: raw };
}

// ══════════════════════════════════════════════════════════════════════════════
// 5. P2PConnection — WebSocket signaling → RTCPeerConnection + DataChannel
// ══════════════════════════════════════════════════════════════════════════════

// Use react-native-webrtc in RN, built-in WebRTC otherwise
let RTCPeerConnectionImpl: typeof RTCPeerConnection;
let RTCSessionDescriptionImpl: typeof RTCSessionDescription;
let RTCIceCandidateImpl: typeof RTCIceCandidate;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rnWebrtc = require('react-native-webrtc');
  RTCPeerConnectionImpl = rnWebrtc.RTCPeerConnection;
  RTCSessionDescriptionImpl = rnWebrtc.RTCSessionDescription;
  RTCIceCandidateImpl = rnWebrtc.RTCIceCandidate;
} catch {
  RTCPeerConnectionImpl = RTCPeerConnection;
  RTCSessionDescriptionImpl = RTCSessionDescription;
  RTCIceCandidateImpl = RTCIceCandidate;
}

// ── Config ──────────────────────────────────────────────────────────────────

export interface P2PConnectionConfig {
  signalingUrl: string;
  username: string;
  room: string;
  password?: string;
  sfu?: boolean;
  turnUrl?: string;
}

// ── P2PConnection class ─────────────────────────────────────────────────────

export class P2PConnection implements P2PTransport {
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private peerId = '';
  private hostId = '';
  private _connectionState: ConnectionState = 'offline';
  private username = '';
  private _intentionalDisconnect = false;
  private _sfuMode = false;
  private _webrtcTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastConfig: P2PConnectionConfig | null = null;

  /** The state manager that processes all decoded messages */
  readonly stateManager: P2PStateManager;

  constructor(username: string) {
    this.username = username;
    this.stateManager = new P2PStateManager(username);
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  get connectionState(): ConnectionState { return this._connectionState; }
  get isHost(): boolean { return this.peerId !== '' && this.peerId === this.hostId; }

  // ── Connect ───────────────────────────────────────────────────────────────

  async connect(config: P2PConnectionConfig): Promise<void> {
    this.disconnect();
    this._intentionalDisconnect = false;
    this.username = config.username;
    this.lastConfig = config;
    this._sfuMode = config.sfu ?? false;

    this._connectionState = 'connecting';
    this.stateManager.setConnectionState('connecting');
    this.stateManager.setLastConfig(config.signalingUrl, config.username, config.room);
    this.stateManager.onReconnectSuccess = () => {
      this._intentionalDisconnect = false;
    };

    try {
      // 1. WebSocket signaling
      this.ws = new WebSocket(config.signalingUrl);
      await new Promise<void>((resolve, reject) => {
        this.ws!.onopen = () => resolve();
        this.ws!.onerror = () => reject(new Error('Signaling server unreachable'));
      });

      // 2. Create room / join via signaling
      this.ws.send(JSON.stringify({
        type: 'create',
        room: config.room,
        password: config.password ?? '',
        username: config.username,
        features: ['chat', 'readiness', 'playlist'],
      }));

      const resp = await new Promise<Record<string, unknown>>((resolve) => {
        this.ws!.onmessage = (e) => resolve(JSON.parse(e.data as string));
      });

      if (resp.type === 'error') {
        throw new Error(`${resp.code ?? 'unknown'}: ${resp.message ?? 'Signaling error'}`);
      }

      this.peerId = (resp.peerId as string) ?? '';
      this.hostId = (resp.hostId as string) ?? '';

      // Now handle further signaling messages
      this.ws.onmessage = (e: MessageEvent) => this.handleSignal(JSON.parse(e.data as string));

      this._connectionState = 'handshaking';
      this.stateManager.setConnectionState('handshaking');

      // 3. Create RTCPeerConnection
      const iceServers: Array<{ urls: string; username?: string; credential?: string }> = [
        { urls: 'stun:stun.l.google.com:19302' },
      ];
      if (config.turnUrl) {
        // Parse turn URL: turn(s):user:pass@host:port or bare URL
        const turnMatch = config.turnUrl.match(
          /^(turns?):([^:@]+):([^@]+)@([^:]+)(?::(\d+))?$/,
        );
        if (turnMatch) {
          const server = {
            urls: `${turnMatch[1]}:${turnMatch[4]}:${turnMatch[5] ?? '3478'}` as string,
            username: turnMatch[2] as string | undefined,
            credential: turnMatch[3] as string | undefined,
          };
        } else {
          iceServers.push({ urls: config.turnUrl });
        }
      }
      this.pc = new RTCPeerConnectionImpl({
        iceServers,
      });

      // ── ICE connection state tracking ──────────────────────────
      let iceWarningTimeout: ReturnType<typeof setTimeout> | null = null;

      this.pc.oniceconnectionstatechange = () => {
        if (!this.pc) return;
        const rawState = (this.pc as any).iceConnectionState as string;
        // Map RTCIceConnectionState to PeerState.iceState values
        const mapped = rawState as PeerState['iceState'];
        // Update all known peers' ICE state
        for (const stat of this.stateManager.getPeerStats()) {
          this.stateManager.updateIceState(stat.id, mapped);
        }

        // ICE connection timeout warning (30s in checking/new)
        if (rawState === 'checking' || rawState === 'new') {
          if (!iceWarningTimeout) {
            iceWarningTimeout = setTimeout(() => {
              console.warn('[P2P] ICE connection still in ' + rawState + ' after 30s');
            }, 30000);
          }
        } else {
          if (iceWarningTimeout) {
            clearTimeout(iceWarningTimeout);
            iceWarningTimeout = null;
          }
        }
      };

      // ── WebRTC connection timeout (30s) ────────────────────────
      this._webrtcTimeout = setTimeout(() => {
        if (this.dc?.readyState !== 'open') {
          const msg = 'ICE connection timed out';
          this.stateManager.setConnectionState('error', msg);
          this._connectionState = 'error';
        }
      }, 30000);

      this.pc.onicecandidate = (e: RTCPeerConnectionIceEvent) => {
        if (e.candidate) {
          const signal: Record<string, unknown> = {
            type: 'signal',
            payload: {
              kind: 'ice-candidate',
              candidate: e.candidate.candidate,
              sdpMid: e.candidate.sdpMid,
              sdpMLineIndex: e.candidate.sdpMLineIndex,
            },
          };
          if (this._sfuMode) signal.target = '_server';
          this.ws?.send(JSON.stringify(signal));
        }
      };

      this.pc.ondatachannel = (e: RTCDataChannelEvent) => {
        this.dc = e.channel;
        this.setupDC();
      };

      // 3. Create and send offer
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      if (config.sfu) {
        // SFU mode: let server create the data channel, just send offer
        this.ws.send(JSON.stringify({
          type: 'signal',
          target: '_server',
          payload: { kind: 'offer', sdp: offer.sdp },
        }));
      } else {
        // P2P mode: create data channel and send offer
        this.dc = this.pc.createDataChannel('syncplay-v2');
        this.setupDC();

        this.ws.send(JSON.stringify({
          type: 'signal',
          payload: { kind: 'offer', sdp: offer.sdp },
        }));
      }

      // 4. Mark ready
      this._connectionState = 'ready';
      this.stateManager.onConnected(this.peerId, this.hostId, this);
      this.stateManager.saveConfig('syncplay-p2p-config');
    } catch (e) {
      // Clear WebRTC timeout
      if (this._webrtcTimeout) {
        clearTimeout(this._webrtcTimeout);
        this._webrtcTimeout = null;
      }
      const { message } = humanReadableError(String(e));
      this._connectionState = 'error';
      this.stateManager.setConnectionState('error', message);
      throw e;
    }
  }

  // ── DataChannel setup ─────────────────────────────────────────────────────

  private setupDC(): void {
    if (!this.dc) return;

    const onOpen = () => {
      // Clear the WebRTC connection timeout
      if (this._webrtcTimeout) {
        clearTimeout(this._webrtcTimeout);
        this._webrtcTimeout = null;
      }
    };

    const onClose = () => {
      if (this._intentionalDisconnect) {
        this.stateManager.onDisconnected('Data channel closed');
      } else {
        // Unexpected close — attempt reconnection
        this._handleUnexpectedDisconnect('Data channel closed unexpectedly');
      }
    };

    this.dc.onopen = onOpen;

    // If already open (e.g. when receiving an incoming channel), fire immediately
    if (this.dc.readyState === 'open') {
      onOpen();
    }

    this.dc.onmessage = (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) {
        try {
          const [msgType, payload] = decode(new Uint8Array(e.data));
          this.stateManager.dispatch(msgType, payload);
        } catch (err) {
          console.warn('[P2P] decode error:', err);
        }
      }
    };

    this.dc.onclose = onClose;
  }

  // ── Signaling handler ─────────────────────────────────────────────────────

  private async handleSignal(msg: Record<string, unknown>): Promise<void> {
    if (msg.type === 'signal' && this.pc) {
      const p = msg.payload as Record<string, unknown>;
      if (p.kind === 'answer' && typeof p.sdp === 'string') {
        await this.pc.setRemoteDescription(
          new RTCSessionDescriptionImpl({ type: 'answer', sdp: p.sdp }),
        );
      }
      if (p.kind === 'ice-candidate' && typeof p.candidate === 'string') {
        try {
          await this.pc.addIceCandidate(
            new RTCIceCandidateImpl({
              candidate: p.candidate,
              sdpMid: typeof p.sdpMid === 'string' ? p.sdpMid : undefined,
              sdpMLineIndex: typeof p.sdpMLineIndex === 'number' ? p.sdpMLineIndex : null,
            } as RTCIceCandidateInit),
          );
        } catch (err) {
          console.warn('[P2P] ICE candidate error:', err);
        }
      }
    }
    if (msg.type === 'host_changed') {
      this.hostId = (msg.hostId as string) ?? this.hostId;
      this.stateManager.dispatch(MessageType.HostElected, {
        hostId: this.hostId,
        reason: 'signaling',
      } as HostElectedPayload);
    }
    if (msg.type === 'user_joined') {
      // When a new peer joins via signaling, dispatch UserInfo to add them to state
      const newUsername = (msg.username as string) ?? '';
      if (newUsername) {
        this.stateManager.dispatch(MessageType.UserInfo, {
          username: newUsername,
          features: (msg.features as string[]) ?? [],
        } as UserInfoPayload);
      }
    }
  }

  // ── P2PTransport.send implementation ──────────────────────────────────────

  send(msgType: MessageType, payload: unknown): void {
    if (!this.stateManager.isConnected) return;
    if (!this.dc || this.dc.readyState !== 'open') return;
    try {
      this.dc.send(encode(msgType, payload));
    } catch (err) {
      console.warn('[P2P] send error:', err);
    }
  }

  // ── Convenience send methods ──────────────────────────────────────────────

  sendChat(text: string): void {
    if (!this.dc || this.dc.readyState !== 'open') return;
    this.stateManager.sendChat(text);
  }

  sendSlashCommand(cmd: string): string | null {
    return this.stateManager.sendSlashCommand(cmd);
  }

  sendReadiness(isReady: boolean): void {
    if (!this.dc || this.dc.readyState !== 'open') return;
    this.stateManager.setReady(isReady);
  }

  sendPlaystate(position: number, paused: boolean, doSeek: boolean, speed = 1.0): void {
    if (!this.stateManager.isConnected) return;
    if (!this.dc || this.dc.readyState !== 'open') return;
    if (doSeek) {
      this.stateManager.updatePlaystate(position, paused);
    } else {
      // Direct send for non-seek updates (e.g. local position sync)
      this.send(MessageType.Playstate, playstatePayload(
        position, paused, false, this.username, 0, speed,
      ));
    }
  }

  requestSeek(position: number): void {
    this.stateManager.requestSeek(position);
  }

  requestPause(): void {
    this.stateManager.requestPause();
  }

  requestPlay(): void {
    this.stateManager.requestPlay();
  }

  requestSetSpeed(speed: number): void {
    this.stateManager.requestSetSpeed(speed);
  }

  toggleMute(): boolean {
    return this.stateManager.toggleMute();
  }

  // ── Peer stats ────────────────────────────────────────────────────────

  getPeerStats(): PeerState[] {
    return this.stateManager.getPeerStats();
  }

  // ── Reconnection ──────────────────────────────────────────────────────

  private _handleUnexpectedDisconnect(reason: string): void {
    if (!this.lastConfig) {
      this.stateManager.onDisconnected(reason);
      return;
    }

    // Clean up transport-level resources but keep config
    this.dc?.close();
    this.pc?.close();
    this.ws?.close();
    this.dc = null;
    this.pc = null;
    this.ws = null;
    this.peerId = '';
    this.hostId = '';

    // Use StateManager's reconnect with backoff
    this.stateManager.reconnect(async () => {
      await this.connect(this.lastConfig!);
      // connect() swallows errors — check state to detect failure
      if (this.stateManager.connectionState === 'error') {
        throw new Error('Reconnect attempt failed');
      }
    }, reason);
  }

  // ── Disconnect ────────────────────────────────────────────────────────────

  disconnect(): void {
    this._intentionalDisconnect = true;

    // Clear WebRTC timeout
    if (this._webrtcTimeout) {
      clearTimeout(this._webrtcTimeout);
      this._webrtcTimeout = null;
    }

    if (this.dc?.readyState === 'open') {
      this.send(MessageType.PeerDisconnect, peerDisconnectPayload('user quit'));
    }
    this.dc?.close();
    this.pc?.close();
    this.ws?.close();
    this.dc = null;
    this.pc = null;
    this.ws = null;
    this._connectionState = 'offline';
    this.stateManager.onDisconnected('user quit');
  }
}
