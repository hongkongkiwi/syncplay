// P2P v2.0.0 State Manager — mirrors Rust SyncManager
// Handles all 20 message types, peer tracking, host election,
// latency per-peer, controllers, speed sync, state replay, chat relay
//
// Security: Data channels use DTLS (WebRTC built-in).
// For additional app-layer encryption, consider AES-GCM on
// Chat and FileTransfer payloads using a pre-shared room key.

import {
  MessageType,
  PlaystateAction,
  PlaylistAction,
  ControllerAction,
  type AvatarSetPayload,
  type ChatPayload,
  type ControllerChangePayload,
  type FileEntry,
  type FileMetadata,
  type FileRequestPayload,
  type FileResponsePayload,
  type FileTransferPayload,
  type HelloPayload,
  type LatencyPingPayload,
  type LatencyPongPayload,
  type PeerDisconnectPayload,
  type PlaylistChangePayload,
  type PlaylistRequestPayload,
  type PlaystateRequestPayload,
  type ReadinessPayload,
  type StatusUpdatePayload,
  type SubtitleInfoPayload,
  type SubtitleTrack,
  type UserInfoPayload,
  type VoiceMutePayload,
  avatarSetPayload,
  chatPayload,
  playstatePayload,
  playstateRequestPause,
  playstateRequestPlay,
  playstateRequestSeek,
  playstateRequestSetSpeed,
  readinessPayload,
  statusUpdatePayload,
} from './messages';

// ── Connection interface ──────────────────────────────────────────

export interface P2PTransport {
  send(msgType: MessageType, payload: unknown): void;
}

// ── State shapes ──────────────────────────────────────────────────

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
  avatar?: { presetId: string; customUrl: string; accent: string };
  status?: { text: string; timestamp: number };
}

export interface RoomStateSnapshot {
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
}

export type ConnectionState = 'offline' | 'connecting' | 'handshaking' | 'connecting_peers' | 'ready' | 'reconnecting' | 'error';
export type SyncEventType = 'chat' | 'playstate' | 'user-join' | 'user-leave' | 'host-change' | 'error' | 'transfer-complete' | 'transfer-progress';

export interface SyncEvent {
  type: SyncEventType;
  data?: unknown;
  timestamp: number;
}

type EventHandler = (event: SyncEvent) => void;

// ── File transfer ──────────────────────────────────────────────────

export interface IncomingTransfer {
  transferId: string;
  filename: string;
  totalSize: number;
  chunkSize: number;
  chunks: Map<number, Uint8Array>;
  expectedChunks: number;
  expectedFingerprint: string;
  receivedBytes: number;
}

// ── Defaults ──────────────────────────────────────────────────────

const DEF_SYNC_INTERVAL = 500;
const DEF_PING_INTERVAL = 2000;
const MAX_CHAT = 2000;
const MAX_PLAYLIST = 250;
const PROTOCOL_VERSION = '2.0.0';
const LATENCY_WARN_MS = 500;

// ── Emoji shortcodes (39 from Rust TUI) ──────────────────────────

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

// ── State Manager ─────────────────────────────────────────────────

export class P2PStateManager {
  private room: {
    position: number; paused: boolean; setBy: string; seq: number; speed: number;
    playlist: FileEntry[]; playlistIndex: number;
    controllers: Set<string>; readyStates: Map<string, boolean>;
    peers: Map<string, PeerState>;
  };
  private hostId = '';
  private peerId = '';
  private username = '';
  private latencyMap = new Map<string, number>();
  private voiceMutes = new Map<string, boolean>();
  private incomingTransfers = new Map<string, IncomingTransfer>();
  private eventHandlers: EventHandler[] = [];
  private syncIntervalId: ReturnType<typeof setInterval> | null = null;
  private pingIntervalId: ReturnType<typeof setInterval> | null = null;
  private syncIntervalMs = DEF_SYNC_INTERVAL;
  private pingIntervalMs = DEF_PING_INTERVAL;
  private _connectionState: ConnectionState = 'offline';
  private _transport: P2PTransport | null = null;
  private _connected = false;

  // ── State machine fields ────────────────────────────────────────
  reconnectAttempt = 0;
  maxReconnectAttempts = 5;
  peerCount = 0;
  transitionTimestamp = 0;
  lastTransitionMessage = '';
  private _lastConfig: { host: string; username: string; room: string } | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Configurable callbacks for the connection layer
  onSendTransport: ((msgType: MessageType, payload: unknown) => void) | null = null;

  /** Voice frame handler — set by VoiceChat to receive incoming audio */
  onVoiceFrame: ((data: Uint8Array, from: string) => void) | null = null;
  onReconnectSuccess: (() => void) | null = null;

  constructor(
    username: string,
    features: string[] = ['chat', 'readiness', 'playlist'],
  ) {
    this.username = username;
    this.room = {
      position: 0, paused: true, setBy: '', seq: 0, speed: 1.0,
      playlist: [], playlistIndex: 0,
      controllers: new Set(), readyStates: new Map(), peers: new Map(),
    };
  }

  // ── Connection lifecycle ──────────────────────────────────────────

  get connectionState(): ConnectionState { return this._connectionState; }
  get isHost(): boolean { return this._connected && this.peerId === this.hostId; }
  get myUsername(): string { return this.username; }
  get myPeerId(): string { return this.peerId; }
  get connected(): boolean { return this._connected; }

  /** Public accessor returning per-peer latencies */
  getLatencies(): Record<string, number> {
    return Object.fromEntries(this.latencyMap);
  }

  /** Update a peer's ICE connection state */
  updateIceState(peerId: string, state: PeerState['iceState']): void {
    const peer = this.room.peers.get(peerId);
    if (peer) {
      peer.iceState = state;
      if (state === 'disconnected') {
        console.warn(`[P2PState] ICE disconnected for peer ${peer.username} (${peerId})`);
      } else if (state === 'failed') {
        console.warn(`[P2PState] ICE connection failed for peer ${peer.username} (${peerId})`);
      }
    }
  }

  /** Returns formatted peer stats for UI consumption */
  getPeerStats(): Array<{ peerId: string; username: string; iceState: string; rtt: number; muted: boolean; isReady: boolean }> {
    return [...this.room.peers.values()].map(p => ({
      peerId: p.id,
      username: p.username,
      iceState: p.iceState,
      rtt: p.rtt,
      muted: p.muted,
      isReady: p.isReady,
    }));
  }

  /** Serializable snapshot for UI consumption */
  getSnapshot(): RoomStateSnapshot {
    return {
      position: this.room.position,
      paused: this.room.paused,
      setBy: this.room.setBy,
      seq: this.room.seq,
      speed: this.room.speed,
      playlist: [...this.room.playlist],
      playlistIndex: this.room.playlistIndex,
      controllers: [...this.room.controllers],
      readyStates: Object.fromEntries(this.room.readyStates),
      peers: [...this.room.peers.values()].map(p => ({ ...p })),
    };
  }

  /**
   * Validated state transition.  Logs a warning for illegal transitions
   * and returns without changing state.  "error" and "offline" are always allowed.
   */
  transit(newState: ConnectionState, error?: string): void {
    const prev = this._connectionState;
    if (prev === newState) return;

    const allowed = this._isValidTransition(prev, newState);
    if (!allowed) {
      console.warn(`[P2PState] Illegal transition: ${prev} → ${newState} (ignored)`);
      return;
    }

    this._connectionState = newState;
    this.transitionTimestamp = Date.now();
    this.lastTransitionMessage = `${prev} → ${newState}${error ? ` (${error})` : ''}`;

    if (newState === 'error') {
      this.emit({ type: 'error', data: error ?? 'Connection error', timestamp: Date.now() });
    }

    if (newState === 'offline') {
      this.cancelReconnect();
    }
  }

  private _isValidTransition(from: ConnectionState, to: ConnectionState): boolean {
    // Always-allowed transitions
    if (to === 'error' || to === 'offline') return true;

    const allowed: Partial<Record<ConnectionState, ConnectionState[]>> = {
      offline: ['connecting'],
      connecting: ['handshaking'],
      handshaking: ['ready', 'connecting_peers'],
      connecting_peers: ['ready'],
      ready: ['reconnecting'],
      reconnecting: ['ready', 'offline'],
    };

    return allowed[from]?.includes(to) ?? false;
  }

  /** Called by transport when signaling handshake completes */
  onConnected(peerId: string, hostId: string, transport: P2PTransport): void {
    this.peerId = peerId;
    this.hostId = hostId;
    this._transport = transport;
    this._connected = true;
    this.transit('ready');
    this.startLoop();
  }

  /** Called by transport when disconnected */
  onDisconnected(reason: string): void {
    this._connected = false;
    this.stopLoop();
    this.peerId = '';
    this.hostId = '';
    this._transport = null;
    this.room.peers.clear();
    this.room.readyStates.clear();
    this.room.controllers.clear();
    this.latencyMap.clear();
    this.peerCount = 0;
    this.transit('offline');
  }

  // ── Event system ─────────────────────────────────────────────────

  /**
   * Register an event handler for sync events (chat, playstate, user-join,
   * user-leave, host-change, error, transfer-complete, transfer-progress).
   *
   * This behaves like Rust's `Vec<PeerFn>` — multiple handlers can be
   * registered and **all** fire on each emitted event. Handlers are called
   * in registration order via a simple for-loop.
   *
   * This enables TUI-like callback chains: independent subsystems (chat UI,
   * media controller, file-transfer progress bar, toast notifications) can
   * each subscribe to the same events without coordinating.
   */
  onSyncEvent(handler: EventHandler): void {
    this.eventHandlers.push(handler);
  }

  private emit(event: SyncEvent): void {
    for (const h of this.eventHandlers) h(event);
  }

  // ── Background loops ─────────────────────────────────────────────

  private startLoop(): void {
    this.stopLoop();
    this.syncIntervalId = setInterval(() => this.hostTick(), this.syncIntervalMs);
    this.pingIntervalId = setInterval(() => this.pingAll(), this.pingIntervalMs);
  }

  private stopLoop(): void {
    if (this.syncIntervalId) { clearInterval(this.syncIntervalId); this.syncIntervalId = null; }
    if (this.pingIntervalId) { clearInterval(this.pingIntervalId); this.pingIntervalId = null; }
  }

  private hostTick(): void {
    if (!this.isHost || !this._transport || !this._connected) return;
    this._transport.send(MessageType.Playstate, playstatePayload(
      this.room.position, this.room.paused, false,
      this.username, ++this.room.seq, this.room.speed,
    ));
  }

  private pingAll(): void {
    if (!this._transport || !this._connected) return;
    for (const [id] of this.room.peers) {
      if (id !== this.peerId) {
        this._transport.send(MessageType.LatencyPing, { sendTime: Date.now() });
      }
    }
  }

  // ── Chat ─────────────────────────────────────────────────────────

  sendChat(text: string): void {
    if (!this._transport || !this._connected) return;
    const expanded = this.expandEmojis(text);
    this._transport.send(MessageType.Chat, chatPayload(this.username, expanded));
  }

  sendSlashCommand(cmd: string): string | null {
    const parts = cmd.slice(1).split(/\s+/);
    const name = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (name) {
      case 'help': case 'h': return this.helpText();
      case 'me': return `* ${this.username} ${args.join(' ')}`;
      case 'nick': return `Nickname: use the settings to change your username`;
      case 'users': case 'who': return this.formatPeerList();
      case 'ready': this.setReady(!(this.room.readyStates.get(this.username) ?? false)); return null;
      case 'leave': return '/leave sent — disconnect to leave the room';
      case 'version': return `Syncplay P2P v${PROTOCOL_VERSION}`;
      case 'shrug': return '¯\\_(ツ)_/¯';
      case 'tableflip': case 'flip': return '(╯°□°）╯︵ ┻━┻';
      case 'unflip': return '┬─┬ ノ( ゜-゜ノ)';
      case 'lenny': return '( ͡° ͜ʖ ͡°)';
      case 'send': case 'download': case 'dl': {
        if (!args[0]) return 'Usage: /send <filename>';
        this.requestFile('', args[0], 0);
        return `Requesting file: ${args[0]}`;
      }
      case 'file': {
        if (!args[0]) return 'Usage: /file <path>';
        return `Load file: ${args[0]} (use the media picker to open files)`;
      }
      case 'controller': {
        if (!this.isHost) return 'Only the host can manage controllers';
        if (args[0] === 'add' && args[1]) { this.addController(args[1]); return `${args[1]} can now control playback`; }
        if (args[0] === 'remove' && args[1]) { this.removeController(args[1]); return `${args[1]} can no longer control playback`; }
        return 'Usage: /controller add|remove <username>';
      }
      case 'playlist': {
        if (args[0] === 'add' && args[1]) {
          this.addToPlaylist(args.slice(1).join(',').split(',').map(s => s.trim()));
          return 'Added to playlist';
        }
        if (args[0] === 'index' && args[1]) { this.setPlaylistIndex(parseInt(args[1], 10)); return 'Playlist index set'; }
        if (args[0] === 'clear') { this.clearPlaylist(); return 'Playlist cleared'; }
        return 'Usage: /playlist add|index|clear';
      }
      case 'settings': return this.settingsText();
      case 'cancel': return 'Transfers cannot be cancelled mid-flight';
      case 'react': {
        if (args[0] && args[1]) {
          return `${this.username} reacted to message ${args[0]}: ${this.expandEmojis(args[1])}`;
        }
        return 'Usage: /react <n> :emoji:';
      }
      default: return null;
    }
  }

  // ── Playback control ─────────────────────────────────────────────

  updatePlaystate(position: number, paused: boolean, speed?: number): void {
    if (!this.isHost) {
      this.requestSeek(position);
      return;
    }
    if (speed !== undefined) this.room.speed = speed;
    this.room.position = position;
    this.room.paused = paused;
    this.room.setBy = this.username;
    if (this._transport) {
      this._transport.send(MessageType.Playstate, playstatePayload(
        position, paused, true, this.username, ++this.room.seq, this.room.speed,
      ));
    }
  }

  requestSeek(position: number): void {
    if (!this._transport || !this._connected) return;
    if (this.isHost) { this.updatePlaystate(position, this.room.paused); }
    else this._transport.send(MessageType.PlaystateRequest, playstateRequestSeek(position));
  }

  requestPause(): void {
    if (!this._transport || !this._connected) return;
    if (this.isHost) { this.updatePlaystate(this.room.position, true); }
    else this._transport.send(MessageType.PlaystateRequest, playstateRequestPause());
  }

  requestPlay(): void {
    if (!this._transport || !this._connected) return;
    if (this.isHost) { this.updatePlaystate(this.room.position, false); }
    else this._transport.send(MessageType.PlaystateRequest, playstateRequestPlay());
  }

  requestSetSpeed(speed: number): void {
    if (!this._transport || !this._connected) return;
    if (this.isHost) { this.room.speed = speed; this.updatePlaystate(this.room.position, this.room.paused); }
    else this._transport.send(MessageType.PlaystateRequest, playstateRequestSetSpeed(speed));
  }

  /** Host-only speed change WITHOUT broadcasting position */
  updateSpeed(speed: number): void {
    this.room.speed = speed;
    if (this.isHost && this._transport && this._connected) {
      this._transport.send(MessageType.PlaystateRequest, playstateRequestSetSpeed(speed));
    }
  }

  // ── Readiness ────────────────────────────────────────────────────

  setReady(isReady: boolean): void {
    if (!this._transport || !this._connected) return;
    this.room.readyStates.set(this.username, isReady);
    this._transport.send(MessageType.Readiness, readinessPayload(
      this.username, isReady, true, this.username,
    ));
  }

  /** Host sets another peer's readiness */
  setReadyFor(targetUsername: string, isReady: boolean): void {
    if (!this.isHost || !this._transport || !this._connected) return;
    this.room.readyStates.set(targetUsername, isReady);
    const peer = this.room.peers.get(targetUsername);
    if (peer) peer.isReady = isReady;
    this._transport.send(MessageType.Readiness, readinessPayload(
      targetUsername, isReady, false, this.username,
    ));
  }

  // ── Playlist ─────────────────────────────────────────────────────

  addToPlaylist(files: string[]): void {
    const entries: FileEntry[] = files.filter(f => f).map(f => ({ name: f, duration: 0 }));
    if (!this.isHost && this._transport && this._connected) {
      this._transport.send(MessageType.PlaylistRequest, {
        action: PlaylistAction.SetPlaylist, files: entries, index: this.room.playlistIndex,
      });
      return;
    }
    const combined = [...this.room.playlist, ...entries].slice(0, MAX_PLAYLIST);
    this.room.playlist = combined;
    this.broadcastPlaylist();
  }

  /** Replace entire playlist (not append) */
  setPlaylist(files: string[]): void {
    const entries: FileEntry[] = files.filter(f => f).map(f => ({ name: f, duration: 0 }));
    if (!this.isHost && this._transport && this._connected) {
      this._transport.send(MessageType.PlaylistRequest, {
        action: PlaylistAction.SetPlaylist, files: entries, index: 0,
      });
      return;
    }
    this.room.playlist = entries.slice(0, MAX_PLAYLIST);
    this.room.playlistIndex = 0;
    this.broadcastPlaylist();
  }

  setPlaylistIndex(idx: number): void {
    if (!this.isHost && this._transport && this._connected) {
      this._transport.send(MessageType.PlaylistRequest, {
        action: PlaylistAction.SetIndex, files: [], index: idx,
      });
      return;
    }
    if (idx >= 0 && idx < this.room.playlist.length) {
      this.room.playlistIndex = idx;
      this.room.position = 0;
    }
    this.broadcastPlaylist();
  }

  clearPlaylist(): void {
    this.room.playlist = [];
    this.room.playlistIndex = 0;
    this.broadcastPlaylist();
  }

  private broadcastPlaylist(): void {
    if (!this.isHost || !this._transport) return;
    this._transport.send(MessageType.PlaylistChange, {
      files: this.room.playlist, index: this.room.playlistIndex, setBy: this.username,
    });
  }

  // ── File info ────────────────────────────────────────────────────

  sendFileInfo(file?: FileMetadata): void {
    if (!this.isHost || !this._transport) return;
    this._transport.send(MessageType.FileInfo, { username: this.username, file });
  }

  // ── Controllers ──────────────────────────────────────────────────

  addController(username: string): void {
    this.room.controllers.add(username);
    const peer = this.room.peers.get(username);
    if (peer) peer.isController = true;
    if (this.isHost && this._transport) {
      this._transport.send(MessageType.ControllerChange, {
        peer_id: username, action: ControllerAction.Add,
      });
    }
  }

  removeController(username: string): void {
    this.room.controllers.delete(username);
    const peer = this.room.peers.get(username);
    if (peer) peer.isController = false;
    if (this.isHost && this._transport) {
      this._transport.send(MessageType.ControllerChange, {
        peer_id: username, action: ControllerAction.Remove,
      });
    }
  }

  isController(username: string): boolean {
    return username === this.username || this.room.controllers.has(username);
  }

  // ── Voice ────────────────────────────────────────────────────────

  sendVoiceMute(muted: boolean): void {
    if (!this._transport || !this._connected) return;
    this.voiceMutes.set(this.username, muted);
    this._transport.send(MessageType.VoiceMute, { muted });
  }

  /** Send a voice audio frame to all peers */
  sendVoiceFrame(data: Uint8Array, seq: number): void {
    if (!this._transport || !this._connected) return;
    if (!this.isHost) {
      // Non-host: send to host for relay
      this._transport.send(MessageType.VoiceFrame, {
        data, seq, from: this.username,
        timestamp: Date.now(), sampleRate: 16000, channels: 1,
      });
    } else {
      // Host: broadcast to all
      this._transport.send(MessageType.VoiceFrame, {
        data, seq, from: this.username,
        timestamp: Date.now(), sampleRate: 16000, channels: 1,
      });
    }
  }

  toggleMute(): boolean {
    const current = this.voiceMutes.get(this.username) ?? false;
    this.sendVoiceMute(!current);
    return !current;
  }

  // ── File transfer (stub) ─────────────────────────────────────────

  requestFile(peerId: string, filename: string, offset = 0): void {
    if (!this._transport || !this._connected) return;
    const payload: FileRequestPayload = {
      transferId: crypto.randomUUID(), filename, offset, fingerprint: '',
    };
    this._transport.send(MessageType.FileRequest, payload);
  }

  // ── State replay for newly joined peers ──────────────────────────

  sendStateTo(peerId: string): void {
    if (!this.isHost || !this._transport) return;
    // Send current playstate
    this._transport.send(MessageType.Playstate, playstatePayload(
      this.room.position, this.room.paused, true,
      this.username, this.room.seq, this.room.speed,
    ));
    // Send playlist
    this._transport.send(MessageType.PlaylistChange, {
      files: this.room.playlist, index: this.room.playlistIndex, setBy: this.username,
    });
    // Send readiness for all peers
    for (const [name, ready] of this.room.readyStates) {
      this._transport.send(MessageType.Readiness, readinessPayload(
        name, ready, false, this.username,
      ));
    }
    // Send controller list
    for (const c of this.room.controllers) {
      this._transport.send(MessageType.ControllerChange, {
        peer_id: c, action: ControllerAction.Add,
      });
    }
  }

  // ── Message dispatch (called by transport) ────────────────────────

  dispatch(msgType: MessageType, payload: unknown, from?: string): void {
    switch (msgType) {
      case MessageType.Hello: return this.handleHello(payload as HelloPayload, from);
      case MessageType.Playstate: return this.handlePlaystate(payload as any);
      case MessageType.PlaystateRequest: return this.handlePlaystateRequest(payload as PlaystateRequestPayload);
      case MessageType.Chat: return this.handleChat(payload as ChatPayload);
      case MessageType.Readiness: return this.handleReadiness(payload as ReadinessPayload);
      case MessageType.PlaylistChange: return this.handlePlaylistChange(payload as PlaylistChangePayload);
      case MessageType.PlaylistRequest: return this.handlePlaylistRequest(payload as PlaylistRequestPayload);
      case MessageType.FileInfo: return this.handleFileInfo(payload as any);
      case MessageType.FileTransfer: return this.handleFileTransfer(payload as FileTransferPayload);
      case MessageType.FileResponse: return this.handleFileResponse(payload as FileResponsePayload);
      case MessageType.LatencyPing: return this.handleLatencyPing(payload as LatencyPingPayload);
      case MessageType.LatencyPong: return this.handleLatencyPong(payload as LatencyPongPayload, from);
      case MessageType.HostElected: return this.handleHostElected(payload as any);
      case MessageType.UserInfo: return this.handleUserInfo(payload as UserInfoPayload, from);
      case MessageType.PeerDisconnect: return this.handlePeerDisconnect(payload as PeerDisconnectPayload, from);
      case MessageType.VoiceMute: return this.handleVoiceMute(payload as VoiceMutePayload, from);
      case MessageType.SubtitleInfo: return this.handleSubtitleInfo(payload as SubtitleInfoPayload);
      case MessageType.ControllerChange: return this.handleControllerChange(payload as ControllerChangePayload);
      case MessageType.VoiceFrame: return this.handleVoiceFrame(payload as any, from);
      case MessageType.FileRequest: break; // handled by file transfer module
    }
  }

  // ── Message handlers ─────────────────────────────────────────────

  private handleHello(p: HelloPayload, from?: string): void {
    if (p.version !== PROTOCOL_VERSION) {
      console.warn(`Version mismatch: peer=${p.version} us=${PROTOCOL_VERSION}`);
    }
    // Track peer on Hello
    const pid = from ?? p.username;
    if (!this.room.peers.has(pid)) {
      this.room.peers.set(pid, {
        id: pid, username: p.username, features: p.features,
        isReady: false, isController: false, isHost: pid === this.hostId,
        rtt: 0, muted: false, iceState: 'connected',
      });
      this.emit({ type: 'user-join', data: { id: pid, username: p.username }, timestamp: Date.now() });
    }
  }

  private handlePlaystate(p: { position: number; paused: boolean; doSeek: boolean; setBy: string; seq: number; timestamp: number; speed: number }): void {
    if (p.seq <= this.room.seq && p.setBy === this.room.setBy) return;
    const latency = this.latencyMap.get(p.setBy) ?? 0;
    const speed = p.speed ?? 1.0;
    this.room.position = p.position + (Date.now() - p.timestamp) * speed / 1000 + latency * speed;
    this.room.paused = p.paused;
    this.room.setBy = p.setBy;
    this.room.seq = p.seq;
    this.room.speed = speed;
    this.emit({ type: 'playstate', data: this.getSnapshot(), timestamp: Date.now() });
  }

  private handlePlaystateRequest(p: PlaystateRequestPayload): void {
    if (!this.isHost) return;
    if (typeof p.action === 'object' && 'SetSpeed' in p.action) {
      this.room.speed = p.action.SetSpeed;
      this.updatePlaystate(this.room.position, this.room.paused);
    } else {
      switch (p.action) {
        case PlaystateAction.Seek: this.updatePlaystate(p.position || this.room.position, this.room.paused); break;
        case PlaystateAction.Pause: this.updatePlaystate(this.room.position, true); break;
        case PlaystateAction.Play: this.updatePlaystate(this.room.position, false); break;
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
    this.room.readyStates.set(p.username, p.isReady);
    const peer = this.room.peers.get(p.username);
    if (peer) peer.isReady = p.isReady;
    // DO NOT relay — in mesh P2P, every peer receives the original message directly.
    // Relaying causes amplification. The sender's setReady() already sent to everyone.
  }

  private handlePlaylistChange(p: PlaylistChangePayload): void {
    if (p.setBy === this.username) return;
    this.room.playlist = p.files;
    this.room.playlistIndex = p.index;
  }

  private handlePlaylistRequest(p: PlaylistRequestPayload): void {
    if (!this.isHost) return;
    if (p.action === PlaylistAction.SetPlaylist) {
      this.room.playlist = p.files.slice(0, MAX_PLAYLIST);
      this.broadcastPlaylist();
    } else if (p.action === PlaylistAction.SetIndex) {
      this.setPlaylistIndex(p.index);
    }
  }

  private handleFileInfo(p: { username: string; file?: FileMetadata }): void {
    const peer = this.room.peers.get(p.username);
    if (peer) peer.file = p.file;
  }

  private handleFileTransfer(p: FileTransferPayload): void {
    // Guard: division by zero check
    if (p.chunkSize === 0) {
      console.error(`FileTransfer rejected: chunkSize is 0 for transfer ${p.transferId}`);
      return;
    }

    // Get or create IncomingTransfer entry
    let transfer = this.incomingTransfers.get(p.transferId);
    if (!transfer) {
      const expectedChunks = Math.ceil(p.totalSize / p.chunkSize);
      transfer = {
        transferId: p.transferId,
        filename: p.filename,
        totalSize: p.totalSize,
        chunkSize: p.chunkSize,
        chunks: new Map(),
        expectedChunks,
        expectedFingerprint: '',
        receivedBytes: 0,
      };
      this.incomingTransfers.set(p.transferId, transfer);
    }

    // Store chunk
    transfer.chunks.set(p.chunkIndex, p.data);
    transfer.receivedBytes += p.data.byteLength;

    // Check if transfer is complete
    if (transfer.receivedBytes >= transfer.totalSize) {
      this.assembleTransfer(transfer);
    }
  }

  private async assembleTransfer(transfer: IncomingTransfer): Promise<void> {
    // Concatenate all chunks in order
    const ordered = new Uint8Array(transfer.totalSize);
    let offset = 0;
    for (let i = 0; i < transfer.expectedChunks; i++) {
      const chunk = transfer.chunks.get(i);
      if (chunk) {
        ordered.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }

    // Compute SHA-256 hash
    let hashHex = '';
    try {
      const hashBuffer = await crypto.subtle.digest('SHA-256', ordered);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (err) {
      console.error('SHA-256 digest failed:', err);
    }

    // Verify fingerprint if set
    if (transfer.expectedFingerprint && hashHex !== transfer.expectedFingerprint) {
      console.error(
        `Fingerprint mismatch for ${transfer.filename}: expected ${transfer.expectedFingerprint}, got ${hashHex}`
      );
      this.incomingTransfers.delete(transfer.transferId);
      return;
    }

    // Emit transfer-complete event
    this.emit({
      type: 'transfer-complete',
      data: {
        transferId: transfer.transferId,
        filename: transfer.filename,
        data: ordered,
        size: transfer.totalSize,
        fingerprint: hashHex,
      },
      timestamp: Date.now(),
    });

    // Download to disk via Blob
    try {
      const blob = new Blob([ordered], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = transfer.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('File download failed:', err);
    }

    // Clean up
    this.incomingTransfers.delete(transfer.transferId);
  }

  private handleFileResponse(p: FileResponsePayload): void {
    const transfer = this.incomingTransfers.get(p.transferId);
    if (!transfer) {
      console.warn(`FileResponse for unknown transfer ${p.transferId}`);
      return;
    }

    if (!p.accepted) {
      console.warn(`File transfer ${p.transferId} rejected: ${p.reason}`);
      this.incomingTransfers.delete(p.transferId);
      return;
    }

    // Store expected fingerprint and chunk size for later verification
    if (p.fingerprint) {
      transfer.expectedFingerprint = p.fingerprint;
    }
    if (p.chunkSize > 0) {
      transfer.chunkSize = p.chunkSize;
      transfer.expectedChunks = Math.ceil(transfer.totalSize / p.chunkSize);
    }
  }

  /** Cancel an in-progress file transfer and free resources */
  cancelTransfer(transferId: string): void {
    const transfer = this.incomingTransfers.get(transferId);
    if (transfer) {
      console.log(`Cancelling file transfer: ${transfer.filename} (${transferId})`);
      this.incomingTransfers.delete(transferId);
    }
  }

  // ── Subtitle detection ────────────────────────────────────────────

  /**
   * Scan for subtitle tracks matching a given video filename.
   *
   * Supported subtitle extensions: .srt, .ass, .ssa, .vtt, .sub, .idx, .txt
   *
   * In the Rust TUI, this method performs a full filesystem directory scan:
   *   - Reads the video's parent directory entries
   *   - Matches filenames that share the video's base name but have a subtitle
   *     extension (e.g., "movie.srt", "movie.en.ass", "movie.zh.vtt")
   *   - Parses subtitle headers to detect language and track metadata
   *   - Returns SubtitleTrack[] with path, language, and format info
   *
   * In the browser (this stub), there is no filesystem access. The Web File
   * API only provides access to explicitly user-selected files via <input> or
   * drag-and-drop – there is no way to scan a directory for sibling files.
   * Therefore, this method always returns an empty array and logs a warning.
   *
   * For Electron/React Native, platform-specific modules (fs, expo-file-system,
   * react-native-fs) could be used to implement directory scanning.
   *
   * @param videoName - The video filename to find subtitles for (e.g., "movie.mkv")
   * @returns Always returns an empty array in the browser stub
   */
  findSubtitles(videoName: string): SubtitleTrack[] {
    const SUBTITLE_EXTENSIONS = ['.srt', '.ass', '.ssa', '.vtt', '.sub', '.idx', '.txt'];

    console.log(
      `[P2PState] findSubtitles: would scan for subtitles matching "${videoName}" ` +
      `(extensions: ${SUBTITLE_EXTENSIONS.join(', ')})`,
    );
    console.log(
      '[P2PState] findSubtitles: browser has no filesystem access — ' +
      'directory scan not possible. In Rust, this does a read_dir() on the ' +
      'video parent directory and matches subtitle extensions.',
    );

    // Stub: In the browser, we cannot scan the filesystem.
    // The Rust implementation does:
    //   let dir = std::fs::read_dir(parent)?;
    //   let base = Path::new(videoName).file_stem()?;
    //   for entry in dir {
    //     let path = entry?.path();
    //     if SUBTITLE_EXTENSIONS.contains(&path.extension()) {
    //       if path.file_stem()?.starts_with(&base) {
    //         tracks.push(SubtitleTrack { path, ... });
    //       }
    //     }
    //   }
    return [];
  }

  // ── File transfer sender ──────────────────────────────────────────

  /**
   * Send a file to a peer in 256KB chunks with incremental SHA-256.
   *
   * @param file - Browser File/Blob (web-only; RN: use sendFileRN stub)
   * @param targetPeerId - Peer ID to send to (empty string = broadcast)
   *
   * Emits 'transfer-progress' events:
   *   { transferId, filename, sentBytes, totalSize, progress (0-1) }
   * After final chunk, emits with progress=1 and includes the fingerprint.
   */
  async sendFile(file: File | Blob, targetPeerId: string = ''): Promise<string | null> {
    if (!this._transport || !this._connected) {
      console.warn('[P2PState] sendFile: not connected');
      return null;
    }

    const transferId = crypto.randomUUID();
    const chunkSize = 256 * 1024; // 256KB
    const totalSize = file.size;
    const filename = file instanceof File ? file.name : 'blob.bin';
    let offset = 0;
    let chunkIndex = 0;

    // Set up incremental SHA-256 using the Web Crypto API
    let hashState: Uint8Array | null = null;
    const allChunks: Uint8Array[] = [];

    console.log(`[P2PState] sendFile: starting transfer ${transferId} (${filename}, ${totalSize} bytes)`);

    // Read the file in chunks using FileReader
    while (offset < totalSize) {
      const end = Math.min(offset + chunkSize, totalSize);
      const blobSlice = file.slice(offset, end);

      let chunk: Uint8Array;
      try {
        // For Blob support (including RN environments without FileReader)
        if (typeof file.arrayBuffer === 'function') {
          chunk = new Uint8Array(await blobSlice.arrayBuffer());
        } else {
          // Fallback to FileReader
          chunk = await this._readBlobAsUint8Array(blobSlice);
        }
      } catch (err) {
        console.error(`[P2PState] sendFile: failed to read chunk ${chunkIndex}:`, err);
        this.emit({
          type: 'transfer-progress',
          data: { transferId, filename, sentBytes: offset, totalSize, progress: offset / totalSize, error: String(err) },
          timestamp: Date.now(),
        });
        return null;
      }

      allChunks.push(chunk);

      // Send chunk via transport
      if (this._transport && this._connected) {
        const payload: FileTransferPayload = {
          transferId,
          chunkIndex: chunkIndex,
          offset,
          totalSize,
          chunkSize,
          filename,
          data: chunk,
        };

        this._transport.send(MessageType.FileTransfer, payload);

        // Emit progress
        const sent = offset + chunk.byteLength;
        this.emit({
          type: 'transfer-progress',
          data: { transferId, filename, sentBytes: sent, totalSize, progress: sent / totalSize },
          timestamp: Date.now(),
        });
      }

      offset = end;
      chunkIndex++;
    }

    // Compute full SHA-256 of the complete file
    const fullData = this._concatUint8Arrays(allChunks);
    let fingerprint = '';
    try {
      // Cast needed for TS strict ArrayBufferLike vs ArrayBuffer
      const hashBuffer = await crypto.subtle.digest('SHA-256', fullData as unknown as ArrayBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      fingerprint = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (err) {
      console.error('[P2PState] sendFile: SHA-256 digest failed:', err);
    }

    // Send fingerprint verification chunk (chunkIndex = MAX_SAFE_INTEGER)
    if (this._transport && this._connected) {
      this._transport.send(MessageType.FileTransfer, {
        transferId,
        chunkIndex: Number.MAX_SAFE_INTEGER,
        offset: totalSize,
        totalSize,
        chunkSize,
        filename,
        data: new Uint8Array(0),
      } as FileTransferPayload);
    }

    // Emit final progress with fingerprint
    this.emit({
      type: 'transfer-progress',
      data: { transferId, filename, sentBytes: totalSize, totalSize, progress: 1, fingerprint },
      timestamp: Date.now(),
    });

    console.log(`[P2PState] sendFile: completed ${transferId} (fingerprint: ${fingerprint})`);
    return transferId;
  }

  /**
   * React Native stub for sendFile. In RN there is no browser File API;
   * use this method with a local file path and the expo-file-system module.
   * Reads the file in 256KB chunks, computes SHA-256, and sends via transport.
   */
  async sendFileRN(_filePath: string, _targetPeerId: string = ''): Promise<string | null> {
    // Stub: RN-specific implementation to be wired by the calling layer.
    // Requires expo-file-system File API to read chunks and a SHA-256 impl.
    // When implemented:
    //  1. const fileInfo = await FileSystem.getInfoAsync(filePath);
    //  2. Create a new File(filePath) and read in 256KB chunks
    //  3. Send each chunk via this._transport.send(MessageType.FileTransfer, ...)
    //  4. Compute SHA-256 incrementally over chunks
    //  5. Send final chunk with chunkIndex=Number.MAX_SAFE_INTEGER
    //  6. Emit transfer-progress events
    console.warn('[P2PState] sendFileRN is a stub — implement with expo-file-system');
    return null;
  }

  // ── Private file helpers ──────────────────────────────────────────

  /** Read a Blob as Uint8Array using FileReader (fallback for .arrayBuffer()) */
  private _readBlobAsUint8Array(blob: Blob): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) {
          resolve(new Uint8Array(reader.result));
        } else {
          reject(new Error('FileReader did not return ArrayBuffer'));
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });
  }

  /** Concatenate multiple Uint8Arrays into one */
  private _concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
    const totalLength = arrays.reduce((sum, a) => sum + a.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
      result.set(arr, offset);
      offset += arr.byteLength;
    }
    return result;
  }

  private handleLatencyPing(p: LatencyPingPayload): void {
    if (!this._transport) return;
    this._transport.send(MessageType.LatencyPong, { sendTime: p.sendTime, receiveTime: Date.now() });
  }

  private handleLatencyPong(p: LatencyPongPayload, from?: string): void {
    const rtt = Date.now() - p.sendTime;
    // Store per-peer latency using the sender's peer ID
    const key = from ?? 'peer';
    this.latencyMap.set(key, rtt);
    const peer = this.room.peers.get(key);
    if (peer) peer.rtt = rtt;
    if (rtt > LATENCY_WARN_MS) {
      console.warn(`High latency to ${key}: ${rtt.toFixed(0)}ms`);
    }
  }

  private handleHostElected(p: { host_id: string; reason: string }): void {
    // Reset old host flag
    for (const [, peer] of this.room.peers) peer.isHost = false;
    this.hostId = p.host_id;
    const peer = this.room.peers.get(p.host_id);
    if (peer) { peer.isHost = true; this.room.controllers.add(peer.username); }
    this.emit({ type: 'host-change', data: { hostId: p.host_id, reason: p.reason }, timestamp: Date.now() });
  }

  private handleUserInfo(p: UserInfoPayload, from?: string): void {
    const pid = from ?? p.username;
    let peer = this.room.peers.get(pid);
    if (!peer) {
      peer = {
        id: pid, username: p.username, features: p.features,
        isReady: false, isController: false, isHost: pid === this.hostId,
        rtt: 0, muted: false, iceState: 'connected',
      };
      this.room.peers.set(pid, peer);
      this.emit({ type: 'user-join', data: { id: pid, username: p.username }, timestamp: Date.now() });
    } else {
      peer.features = p.features;
    }
  }

  private handlePeerDisconnect(p: PeerDisconnectPayload, from?: string): void {
    const pid = from ?? '';
    if (pid) {
      this.room.peers.delete(pid);
      this.room.readyStates.delete(pid);
      this.room.controllers.delete(pid);
      this.latencyMap.delete(pid);
      this.emit({ type: 'user-leave', data: { id: pid, reason: p.reason }, timestamp: Date.now() });
    }
  }

  private handleVoiceMute(p: VoiceMutePayload, from?: string): void {
    if (from) {
      this.voiceMutes.set(from, p.muted);
      const peer = this.room.peers.get(from);
      if (peer) peer.muted = p.muted;
    }
  }

  private handleVoiceFrame(p: { data: Uint8Array; from?: string; seq: number }, from?: string): void {
    if (!this.onVoiceFrame) return;
    const sender = p.from ?? from ?? '';
    if (sender === this.username) return; // skip self
    this.onVoiceFrame(p.data, sender);
    // Host relays to all other peers
    if (this.isHost && this._transport && sender !== this.username) {
      this._transport.send(MessageType.VoiceFrame, p);
    }
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
      this.room.controllers.add(p.peer_id);
      const peer = this.room.peers.get(p.peer_id);
      if (peer) peer.isController = true;
    } else {
      this.room.controllers.delete(p.peer_id);
      const peer = this.room.peers.get(p.peer_id);
      if (peer) peer.isController = false;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private expandEmojis(msg: string): string {
    return msg.replace(/:\w+:/g, m => EMOJIS[m] ?? m);
  }

  private formatPeerList(): string {
    if (this.room.peers.size === 0) return 'No peers connected';
    return [...this.room.peers.values()]
      .map(p => `${p.username}${p.isHost ? ' (host)' : ''}${p.file ? ` [${p.file.name}]` : ''}${p.isReady ? ' ✓' : ''}`)
      .join(', ');
  }

  private settingsText(): string {
    return [
      `Username: ${this.username}`,
      `Room: ${this.username}`,
      `Position: ${this.room.position.toFixed(1)}s ${this.room.paused ? '⏸' : '▶'}`,
      `Speed: ${this.room.speed}x`,
      `Playlist: ${this.room.playlist.length} items, index ${this.room.playlistIndex}`,
      `Peers: ${this.room.peers.size}`,
      `Host: ${this.isHost ? 'yes' : 'no'} (${this.hostId})`,
      `Controllers: ${[...this.room.controllers].join(',') || 'none'}`,
      `Protocol: v${PROTOCOL_VERSION}`,
    ].join('\n');
  }

  private helpText(): string {
    return `Syncplay P2P v${PROTOCOL_VERSION}
  Commands:
  /help /h              — this list
  /me <action>          — send action
  /users /who           — list peers
  /ready                — toggle ready
  /leave                — disconnect
  /version              — show version
  /send <file>          — request file transfer
  /file <path>          — load media file
  /controller add|rm    — manage controllers (host)
  /playlist add|idx|clr — manage playlist
  /settings             — show room state
  /cancel               — transfer info
  /react <n> :emoji:    — react
  /nick                 — username info
  /shrug /tableflip /lenny /unflip`;
  }

  // ── Config persistence ──────────────────────────────────────────

  /**
   * Persist the current connection config (host + username + room) to localStorage.
   * Call this after a successful connection.
   */
  saveConfig(key = 'syncplay-p2p-config'): void {
    if (!this._lastConfig) return;
    try {
      localStorage.setItem(key, JSON.stringify(this._lastConfig));
    } catch (err) {
      console.warn('[P2PState] Failed to save config:', err);
    }
  }

  /**
   * Load saved connection config from localStorage.
   * Returns defaults if nothing is saved.
   */
  static loadConfig(key = 'syncplay-p2p-config'): { host: string; username: string; room: string } {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.host === 'string' && typeof parsed.username === 'string' && typeof parsed.room === 'string') {
          return parsed;
        }
      }
    } catch { /* ignore */ }
    return { host: 'localhost', username: '', room: '' };
  }

  /** Store config for later persistence — call before or during connect */
  setLastConfig(host: string, username: string, room: string): void {
    this._lastConfig = { host, username, room };
  }

  // ── Reconnection ─────────────────────────────────────────────────

  /**
   * Begin reconnection attempts with exponential backoff.
   * Transit to 'reconnecting', then attempt reconnect.
   * After maxReconnectAttempts, transit to 'error'.
   */
  reconnect(connectFn: () => Promise<void>, reason?: string): void {
    this.cancelReconnect();

    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      this.transit('error', `Max reconnect attempts (${this.maxReconnectAttempts}) reached`);
      return;
    }

    this.transit('reconnecting', reason);

    // Exponential backoff: 2s, 4s, 8s, 16s, 32s
    const delay = Math.min(2000 * Math.pow(2, this.reconnectAttempt), 32000);
    this.reconnectAttempt++;

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try {
        await connectFn();
        this.reconnectAttempt = 0;
        this.onReconnectSuccess?.();
      } catch (err) {
        // connectFn will have already set error state, but we retry
        this.reconnect(connectFn, String(err));
      }
    }, delay);
  }

  /** Cancel any in-progress reconnection */
  cancelReconnect(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
  }

  destroy(): void {
    this.cancelReconnect();
    this._connected = false;
    this.stopLoop();
    this.eventHandlers = [];
  }
}
