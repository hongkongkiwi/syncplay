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
  type FileInfoPayload,
  type FileMetadata,
  type FileRequestPayload,
  type FileResponsePayload,
  type FileTransferPayload,
  type HelloPayload,
  type HostElectedPayload,
  type LatencyPingPayload,
  type LatencyPongPayload,
  type MessageRecallPayload,
  type MessageReactionPayload,
  type MessageReplyPayload,
  type PeerDisconnectPayload,
  type PlaylistChangePayload,
  type PlaylistRequestPayload,
  type PlaystatePayload,
  type PlaystateRequestPayload,
  type ReadinessPayload,
  type StatusUpdatePayload,
  type SubtitleInfoPayload,
  type SubtitleTrack,
  type UserInfoPayload,
  type VoiceFramePayload,
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
  doSeek: boolean;
  playlist: FileEntry[];
  playlistIndex: number;
  controllers: string[];
  readyStates: Record<string, boolean>;
  peers: PeerState[];
  avatars: Record<string, { presetId: string; customUrl: string; accent: string }>;
  statuses: Record<string, { statusText: string; timestamp: number }>;
}

export type ConnectionState = 'offline' | 'connecting' | 'handshaking' | 'connecting_peers' | 'ready' | 'reconnecting' | 'error';
export type SyncEventType = 'chat' | 'playstate' | 'user-join' | 'user-leave' | 'host-change' | 'error' | 'transfer-complete' | 'transfer-progress' | 'file-request';

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
  cancelled?: boolean;
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
  private avatarMap = new Map<string, { presetId: string; customUrl: string; accent: string }>();
  private statusMap = new Map<string, { statusText: string; timestamp: number }>();
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
  private _subtitleTracks: SubtitleTrack[] = [];

  // Configurable callbacks for the connection layer
  onSendTransport: ((msgType: MessageType, payload: unknown) => void) | null = null;

  /** Voice frame handler — set by VoiceChat to receive incoming audio */
  onVoiceFrame: ((data: Uint8Array, from: string) => void) | null = null;

  /** File transfer warning — set by RN app to warn about large downloads on cellular.
   *  Return true to proceed with download, false to cancel. */
  onFileTransferWarning: ((filename: string, sizeBytes: number) => Promise<boolean>) | null = null;
  onReconnectSuccess: (() => void) | null = null;

  /**
   * RN-only: chunked file reader for sendFileRN.
   * Set by the RN layer to use expo-file-system for reading file chunks.
   * Signature: (filePath, offset, length) => Promise<Uint8Array>
   */
  public fileReader: ((path: string, offset: number, length: number) => Promise<Uint8Array>) | null = null;

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
      doSeek: (this.room as any)._lastDoSeek ?? false,
      playlist: [...this.room.playlist],
      playlistIndex: this.room.playlistIndex,
      controllers: [...this.room.controllers],
      readyStates: Object.fromEntries(this.room.readyStates),
      peers: [...this.room.peers.values()].map(p => ({ ...p })),
      avatars: Object.fromEntries(this.avatarMap),
      statuses: Object.fromEntries(this.statusMap),
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
      offline: ['connecting', 'reconnecting'],
      connecting: ['handshaking', 'reconnecting'],
      handshaking: ['ready', 'connecting_peers', 'reconnecting'],
      connecting_peers: ['ready'],
      ready: ['reconnecting'],
      reconnecting: ['ready', 'offline', 'handshaking', 'connecting_peers'],
    };

    return allowed[from]?.includes(to) ?? false;
  }

  /** Called by transport when signaling handshake completes */
  onConnected(peerId: string, hostId: string, transport: P2PTransport): void {
    this.peerId = peerId;
    this.hostId = hostId;
    this._transport = transport;
    this._connected = true;
    if (this._connectionState === 'handshaking') {
      this.transit('ready');
    } else if (this._connectionState === 'connecting_peers') {
      this.transit('ready');
    } else if (this._connectionState === 'reconnecting') {
      this.transit('ready');
      this.reconnectAttempt = 0;
    } else {
      console.warn(`[P2PState] onConnected called in unexpected state: ${this._connectionState}`);
    }
    // Restore voice mute preference from localStorage on reconnect
    try {
      const saved = localStorage.getItem('syncplay-voice-mute');
      if (saved !== null) {
        const muted = JSON.parse(saved) as boolean;
        this.voiceMutes.set(this.username, muted);
        if (muted) {
          this._transport.send(MessageType.VoiceMute, { muted: true });
        }
      }
    } catch { /* storage unavailable */ }
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
    this.avatarMap.clear();
    this.statusMap.clear();
    this.incomingTransfers.clear();
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

  /** Deregister an event handler previously registered with onSyncEvent. */
  offSyncEvent(handler: EventHandler): void {
    const idx = this.eventHandlers.indexOf(handler);
    if (idx !== -1) this.eventHandlers.splice(idx, 1);
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
    if (!this.isHost || !this._connected) return;
    const transport = this._transport;
    if (!transport) return;
    transport.send(MessageType.Playstate, playstatePayload(
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

  /** Minimal slash commands — everything else has a button */
  sendSlashCommand(cmd: string): string | null {
    const parts = cmd.slice(1).split(/\s+/);
    const name = (parts[0] ?? '').toLowerCase();
    const args = parts.slice(1);

    switch (name) {
      case 'me': return `* ${this.username} ${args.join(' ')}`;
      case 'shrug': return '¯\\_(ツ)_/¯';
      case 'tableflip': case 'flip': return '(╯°□°）╯︵ ┻━┻';
      case 'unflip': return '┬─┬ ノ( ゜-゜ノ)';
      case 'lenny': return '( ͡° ͜ʖ ͡°)';
      default: return null;
    }
  }

  /** Send a reply to a specific message */
  sendMessageReply(messageId: string, originalMessage: string, originalAuthor: string, replyText: string): void {
    if (!this._transport || !this._connected) return;
    this._transport.send(MessageType.MessageReply, {
      messageId, originalMessage, originalAuthor, replyText, timestamp: Date.now(),
    });
  }

  /** Send a reaction to a specific message */
  sendMessageReaction(messageId: string, emoji: string): void {
    if (!this._transport || !this._connected) return;
    this._transport.send(MessageType.MessageReaction, {
      messageId, emoji, from: this.username,
    });
  }

  /** Recall (delete) a message — only own messages within 2 min */
  sendMessageRecall(messageId: string): void {
    if (!this._transport || !this._connected) return;
    this._transport.send(MessageType.MessageRecall, {
      messageId, from: this.username, timestamp: Date.now(),
    });
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
    this.sendSubtitleInfo();
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

  // ── Avatar & Status ─────────────────────────────────────────────

  setAvatar(presetId: string, customUrl: string, accent: string): void {
    if (!this._transport || !this._connected) return;
    this.avatarMap.set(this.username, { presetId, customUrl, accent });
    this._transport.send(MessageType.AvatarSet, { username: this.username, preset_id: presetId, custom_url: customUrl, accent });
  }

  setStatus(statusText: string): void {
    if (!this._transport || !this._connected) return;
    this.statusMap.set(this.username, { statusText, timestamp: Date.now() });
    this._transport.send(MessageType.StatusUpdate, { username: this.username, status_text: statusText, timestamp: Date.now() });
  }

  // ── Voice ────────────────────────────────────────────────────────

  sendVoiceMute(muted: boolean): void {
    if (!this._transport || !this._connected) return;
    this.voiceMutes.set(this.username, muted);
    // Persist mute preference to localStorage for reconnection
    try { localStorage.setItem('syncplay-voice-mute', JSON.stringify(muted)); } catch (err) { console.warn('[P2PState] Failed to persist voice mute:', err); }
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

  // ── File transfer ────────────────────────────────────────────────

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
    // Send avatars
    for (const [username, avatar] of this.avatarMap) {
      this._transport.send(MessageType.AvatarSet, { username, preset_id: avatar.presetId, custom_url: avatar.customUrl, accent: avatar.accent });
    }
    // Send statuses
    for (const [username, status] of this.statusMap) {
      this._transport.send(MessageType.StatusUpdate, { username, status_text: status.statusText, timestamp: status.timestamp });
    }
    // Send subtitle info if host has loaded subtitles
    if (this._subtitleTracks.length > 0) {
      this._transport.send(MessageType.SubtitleInfo, {
        subtitles: this._subtitleTracks,
      });
    }
  }

  // ── Message dispatch (called by transport) ────────────────────────

  dispatch(msgType: MessageType, payload: unknown, from?: string): void {
    switch (msgType) {
      case MessageType.Hello: return this.handleHello(payload as HelloPayload, from);
      case MessageType.Playstate: return this.handlePlaystate(payload as PlaystatePayload);
      case MessageType.PlaystateRequest: return this.handlePlaystateRequest(payload as PlaystateRequestPayload, from);
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
      case MessageType.UserInfo: return this.handleUserInfo(payload as UserInfoPayload, from);
      case MessageType.PeerDisconnect: return this.handlePeerDisconnect(payload as PeerDisconnectPayload, from);
      case MessageType.VoiceMute: return this.handleVoiceMute(payload as VoiceMutePayload, from);
      case MessageType.SubtitleInfo: return this.handleSubtitleInfo(payload as SubtitleInfoPayload);
      case MessageType.ControllerChange: return this.handleControllerChange(payload as ControllerChangePayload);
      case MessageType.AvatarSet: return this.handleAvatarSet(payload as AvatarSetPayload);
      case MessageType.StatusUpdate: return this.handleStatusUpdate(payload as StatusUpdatePayload);
      case MessageType.VoiceFrame: return this.handleVoiceFrame(payload as VoiceFramePayload, from);
      case MessageType.MessageReply: return this.handleMessageReply(payload as MessageReplyPayload);
      case MessageType.MessageReaction: return this.handleMessageReaction(payload as MessageReactionPayload);
      case MessageType.MessageRecall: return this.handleMessageRecall(payload as MessageRecallPayload);
      case MessageType.FileRequest:
        this.emit({ type: 'file-request', data: payload, timestamp: Date.now() });
        break;
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
    // Store doSeek flag so it survives through getSnapshot() to the UI sync correction
    (this.room as any)._lastDoSeek = p.doSeek;
    this.emit({ type: 'playstate', data: this.getSnapshot(), timestamp: Date.now() });
  }

  private handlePlaystateRequest(p: PlaystateRequestPayload, from?: string): void {
    if (!this.isHost) return;
    // Controller validation: only peers granted Controller status can send playstate requests
    const requester = from ?? p.requestId;
    if (!this.isController(requester)) {
      console.warn(`[P2PState] PlaystateRequest denied — ${requester} is not a controller`);
      return;
    }
    if (typeof p.action === 'object' && 'setspeed' in p.action) {
      this.room.speed = (p.action as { setspeed: number }).setspeed;
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
    if (peer) {
      if (p.file !== undefined) peer.file = p.file;
      else delete (peer as unknown as Record<string, unknown>).file;
    }
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
        filename: (p as any).filename ?? 'unknown',
        totalSize: p.totalSize,
        chunkSize: p.chunkSize,
        chunks: new Map(),
        expectedChunks,
        expectedFingerprint: '',
        receivedBytes: 0,
      };
      this.incomingTransfers.set(p.transferId, transfer);

      // Warn about large files on cellular (mobile clients)
      if (this.onFileTransferWarning && p.totalSize > 5_000_000 && p.chunkIndex === 0) {
        const tid = p.transferId;
        const fn = transfer.filename;
        const sz = p.totalSize;
        // Fire-and-forget: if user cancels, mark transfer as cancelled
        this.onFileTransferWarning(fn, sz).then(proceed => {
          if (!proceed) {
            transfer!.cancelled = true;
            this.incomingTransfers.delete(tid);
            console.log(`[P2PState] File transfer ${tid} cancelled by user`);
          }
        }).catch((err) => {
          console.warn(`[P2PState] onFileTransferWarning callback failed: ${err}`);
        });
      }
    }

    // Skip chunks for cancelled transfers
    if ((transfer as any).cancelled) return;

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

  /** Cancel an in-progress file transfer and free resources.
   *  FIXABLE GAP: cancelTransfer exists but is never wired to any UI (web/RN).
   *  Clients can call this directly when implementing a transfer manager UI
   *  that shows active downloads with cancel buttons. */
  cancelTransfer(transferId: string): void {
    const transfer = this.incomingTransfers.get(transferId);
    if (transfer) {
      console.log(`Cancelling file transfer: ${transfer.filename} (${transferId})`);
      this.incomingTransfers.delete(transferId);
    }
  }

  // ── Subtitle detection ────────────────────────────────────────────

  /** Subtitle file extensions recognized by the matcher */
  private static readonly SUBTITLE_EXTENSIONS: ReadonlySet<string> = new Set([
    '.srt', '.ass', '.ssa', '.vtt', '.sub', '.idx', '.txt',
  ]);

  /** Map common 3-letter language codes to ISO 639-1 2-letter codes */
  private static readonly LANG_CODE_MAP: Record<string, string> = {
    eng: 'en', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de',
    spa: 'es', ita: 'it', por: 'pt', rus: 'ru', jpn: 'ja',
    kor: 'ko', ara: 'ar', zho: 'zh', chi: 'zh', nld: 'nl',
    dut: 'nl', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi',
    pol: 'pl', tur: 'tr', heb: 'he', hin: 'hi', tha: 'th',
    vie: 'vi', ukr: 'uk', ces: 'cs', cze: 'cs', ron: 'ro',
    hun: 'hu', ell: 'el', gre: 'el', bul: 'bg', cat: 'ca',
    eus: 'eu', baq: 'eu', glg: 'gl', slv: 'sl', slo: 'sk',
    srp: 'sr', hrv: 'hr', msa: 'ms', may: 'ms', fil: 'tl',
    ind: 'id', fas: 'fa', per: 'fa', lit: 'lt', lav: 'lv',
    est: 'et', isl: 'is', ice: 'is', mar: 'mr', ben: 'bn',
    tam: 'ta', tel: 'te', mal: 'ml', kan: 'kn', guj: 'gu',
  };

  /**
   * Extract a language code from a subtitle filename stem.
   *
   * Common patterns:
   *   "movie.en"       → "en" (2-letter ISO 639-1)
   *   "movie.eng"      → "en" (3-letter ISO 639-2 → mapped)
   *   "movie.en.sdh"   → "en" (2-letter + hearing-impaired suffix)
   *   "movie.eng.forced" → "en" (3-letter + forced flag)
   *
   * Falls back to undefined if no language code is detected.
   */
  static detectSubtitleLanguage(filename: string): string | undefined {
    const stem = filename.replace(/\.[^.]+$/, ''); // drop extension
    const parts = stem.split(/[._-]/);

    // Walk parts from right to left looking for a language code
    for (let i = parts.length - 1; i >= 0; i--) {
      const token = parts[i]!.toLowerCase();

      // Skip known non-language suffixes
      if (token === 'forced' || token === 'sdh' || token === 'hi' ||
          token === 'cc' || token === 'commentary' || token === 'stereo' ||
          token === 'surround' || token === 'dub' || token === 'sub') {
        continue;
      }

      // Exact 2-letter code
      if (/^[a-z]{2}$/.test(token)) {
        return token;
      }

      // 3-letter code — map to 2-letter if known
      if (/^[a-z]{3}$/.test(token)) {
        return P2PStateManager.LANG_CODE_MAP[token] ?? token;
      }
    }

    return undefined;
  }

  /**
   * Find subtitle tracks matching a given video filename from a list of
   * browser file-like objects.
   *
   * In the browser, the user selects files via `<input multiple>` or
   * drag-and-drop. This method filters those files for subtitle tracks
   * whose stem matches the video's stem.
   *
   * Supported subtitle extensions: .srt, .ass, .ssa, .vtt, .sub, .idx, .txt
   *
   * Matching rules:
   *   - video "movie.mkv"  → matches "movie.srt", "movie.en.ass", "movie.en.sdh.vtt"
   *   - video "episode.mkv" → matches "episode.fr.srt", "episode_EN.vtt" (case-insensitive)
   *
   * @param files   - Array of file-like objects (at minimum {name, size}).
   * @param videoName - The video filename to match against (e.g., "movie.mkv").
   * @returns SubtitleTrack[] with filename, size, and detected language.
   */
  findSubtitles(
    files: ReadonlyArray<{ name: string; size?: number }>,
    videoName: string,
  ): SubtitleTrack[] {
    const videoStem = videoName.replace(/\.[^.]+$/, '').toLowerCase();
    if (!videoStem) return [];

    const tracks: SubtitleTrack[] = [];

    for (const f of files) {
      const name = f.name;
      const extDot = name.lastIndexOf('.');
      if (extDot === -1) continue;

      const ext = name.slice(extDot).toLowerCase();
      if (!P2PStateManager.SUBTITLE_EXTENSIONS.has(ext)) continue;

      // Check if the stem starts with the video stem (case-insensitive)
      const stem = name.slice(0, extDot).toLowerCase();
      if (!stem.startsWith(videoStem)) continue;

      // The suffix after the video stem should be a language code or empty
      const suffix = stem.slice(videoStem.length);

      // Allow optional separator and language/flag suffix
      if (suffix.length > 0) {
        // Must start with a separator (. _ -) followed by a language indicator
        if (!/^[._-]/.test(suffix)) continue;

        const langCandidate = suffix.slice(1);
        // Allow flags like "forced", "sdh", "cc", "hi"
        const isLangOrFlag = /^[a-z]{2,3}([._-](forced|sdh|hi|cc|commentary|stereo|surround|dub|sub))?$/i.test(langCandidate);
        if (!isLangOrFlag) continue;
      }

      const lang = P2PStateManager.detectSubtitleLanguage(name);
      const track: SubtitleTrack = {
        filename: name,
        size: f.size ?? 0,
      };
      if (lang) track.language = lang;
      tracks.push(track);
    }

    return tracks;
  }

  /**
   * Send subtitle information to all connected peers.
   * Called after findSubtitles when the user loads media with bundled subtitles.
   */
  sendSubtitleInfo(): void {
    if (!this._transport || !this._connected) return;
    if (this._subtitleTracks.length === 0) return;

    this._transport.send(MessageType.SubtitleInfo, {
      subtitles: this._subtitleTracks,
    } satisfies SubtitleInfoPayload);
  }

  /**
   * Store detected subtitle tracks so they can be replayed
   * to late-joining peers via sendStateTo().
   */
  setSubtitleTracks(tracks: SubtitleTrack[]): void {
    this._subtitleTracks = tracks;
  }

  // ── File transfer sender ──────────────────────────────────────────

  /**
   * Send a file to a peer in 256KB chunks with incremental SHA-256.
   *
   * @param file - Browser File/Blob (web-client; RN uses sendFileRN with fileReader callback)
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
    // Contains the SHA-256 hex string as UTF-8 bytes, matching Rust behavior.
    // Receivers compare this against their own computed hash for integrity.
    if (this._transport && this._connected) {
      const fpBytes = new TextEncoder().encode(fingerprint);
      this._transport.send(MessageType.FileTransfer, {
        transferId,
        chunkIndex: Number.MAX_SAFE_INTEGER,
        offset: totalSize,
        totalSize,
        chunkSize: fpBytes.byteLength,
        data: fpBytes,
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
   * React Native implementation of file sending. Uses the fileReader callback
   * (set by the RN layer) to read file chunks, typically via expo-file-system.
   *
   * Reads the file in 256KB chunks, computes SHA-256, and sends via transport.
   * Emits 'transfer-progress' events, and sends a final fingerprint verification
   * chunk with chunkIndex=Number.MAX_SAFE_INTEGER.
   *
   * Returns the transferId on success, or null if fileReader is not set or an
   * error occurs during transfer.
   */
  async sendFileRN(filePath: string, targetPeerId: string = ''): Promise<string | null> {
    if (!this._transport || !this._connected) {
      console.warn('[P2PState] sendFileRN: not connected');
      return null;
    }

    if (!this.fileReader) {
      console.warn('[P2PState] sendFileRN: fileReader not set — wire it with expo-file-system');
      return null;
    }

    const transferId = crypto.randomUUID();
    const chunkSize = 256 * 1024; // 256KB

    // Extract filename from path
    const pathParts = filePath.split(/[\\/]/);
    const filename = pathParts[pathParts.length - 1] || 'file.bin';

    // We don't have expo-file-system directly here, so we use fileReader
    // to also get the file size. The RN layer's fileReader can return the
    // full file as first call (offset=0, length=0 means "get info only").
    // Instead, we'll have the RN layer pass file size separately, OR we
    // infer it by reading until the fileReader returns a smaller chunk.

    // Strategy: read the first chunk to get started, then read remaining chunks.
    // But we need totalSize upfront for the FileTransferPayload.
    // Workaround: read the file in chunks and collect them. We'll determine
    // totalSize after reading all chunks.

    console.log(`[P2PState] sendFileRN: starting transfer ${transferId} (${filename})`);

    let offset = 0;
    let chunkIndex = 0;
    const allChunks: Uint8Array[] = [];
    let totalSize = 0;

    try {
      // Read all chunks
      while (true) {
        const chunk = await this.fileReader(filePath, offset, chunkSize);

        if (!chunk || chunk.byteLength === 0) {
          // No more data — we've read the whole file
          break;
        }

        allChunks.push(chunk);
        totalSize += chunk.byteLength;

        // Send chunk via transport
        if (this._transport && this._connected) {
          const payload: FileTransferPayload = {
            transferId,
            chunkIndex,
            offset,
            totalSize, // Will be updated on final chunk
            chunkSize,
            data: chunk,
          };

          this._transport.send(MessageType.FileTransfer, payload);

          // Emit intermediate progress. NOTE: totalSize and progress are unknown
          // until all chunks are read — sendFileRN reads the full file into memory
          // before the final emission with correct totals. Emit sent-so-far as totalSize.
          this.emit({
            type: 'transfer-progress',
            data: {
              transferId,
              filename,
              sentBytes: totalSize,
              totalSize: totalSize, // best-effort: unknown until full file read
              progress: 0, // unknown until final totalSize determined
            },
            timestamp: Date.now(),
          });
        }

        // If chunk is smaller than chunkSize, we've reached EOF
        if (chunk.byteLength < chunkSize) {
          break;
        }

        offset += chunk.byteLength;
        chunkIndex++;
      }
    } catch (err) {
      console.error(`[P2PState] sendFileRN: failed to read chunk ${chunkIndex}:`, err);
      this.emit({
        type: 'transfer-progress',
        data: {
          transferId,
          filename,
          sentBytes: totalSize,
          totalSize,
          progress: totalSize > 0 ? 1 : 0,
          error: String(err),
        },
        timestamp: Date.now(),
      });
      return null;
    }

    if (totalSize === 0) {
      console.warn('[P2PState] sendFileRN: file is empty');
      this.emit({
        type: 'transfer-progress',
        data: { transferId, filename, sentBytes: 0, totalSize: 0, progress: 1 },
        timestamp: Date.now(),
      });
      return null;
    }

    // Now we know totalSize — re-emit progress for all chunks with correct totalSize
    // (not strictly necessary but improves accuracy for the receiver)

    // Compute full SHA-256 of the complete file
    const fullData = this._concatUint8Arrays(allChunks);
    let fingerprint = '';
    try {
      const hashBuffer = await crypto.subtle.digest('SHA-256', fullData as unknown as ArrayBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      fingerprint = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (err) {
      console.error('[P2PState] sendFileRN: SHA-256 digest failed:', err);
    }

    // Send fingerprint verification chunk (chunkIndex = MAX_SAFE_INTEGER)
    // Contains the SHA-256 hex string as UTF-8 bytes, matching Rust behavior.
    // Receivers compare this against their own computed hash for integrity.
    if (this._transport && this._connected) {
      const fpBytes = new TextEncoder().encode(fingerprint);
      this._transport.send(MessageType.FileTransfer, {
        transferId,
        chunkIndex: Number.MAX_SAFE_INTEGER,
        offset: totalSize,
        totalSize,
        chunkSize: fpBytes.byteLength,
        data: fpBytes,
      } as FileTransferPayload);
    }

    // Emit final progress with fingerprint
    this.emit({
      type: 'transfer-progress',
      data: { transferId, filename, sentBytes: totalSize, totalSize, progress: 1, fingerprint },
      timestamp: Date.now(),
    });

    console.log(`[P2PState] sendFileRN: completed ${transferId} (${totalSize} bytes, fingerprint: ${fingerprint})`);
    return transferId;
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

  private handleHostElected(p: HostElectedPayload): void {
    // Reset old host flag
    for (const [, peer] of this.room.peers) peer.isHost = false;
    this.hostId = p.hostId;
    const peer = this.room.peers.get(p.hostId);
    if (peer) { peer.isHost = true; this.room.controllers.add(peer.username); }
    this.emit({ type: 'host-change', data: { hostId: p.hostId, reason: p.reason }, timestamp: Date.now() });
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

  private handleAvatarSet(p: { username: string; preset_id: string; custom_url: string; accent: string }): void {
    this.avatarMap.set(p.username, { presetId: p.preset_id, customUrl: p.custom_url, accent: p.accent });
  }

  private handleStatusUpdate(p: { username: string; status_text: string; timestamp: number }): void {
    this.statusMap.set(p.username, { statusText: p.status_text, timestamp: p.timestamp });
  }

  private handleMessageReply(p: MessageReplyPayload): void {
    this.emit({
      type: 'chat' as SyncEventType,
      data: {
        from: 'system',
        message: `↳ replying to @${p.originalAuthor}: ${p.originalMessage}`,
        reply: { messageId: p.messageId, text: p.replyText, originalMessage: p.originalMessage, originalAuthor: p.originalAuthor },
        timestamp: p.timestamp,
      },
      timestamp: Date.now(),
    });
  }

  private handleMessageReaction(p: MessageReactionPayload): void {
    this.emit({
      type: 'chat' as SyncEventType,
      data: {
        from: 'system',
        message: `${p.emoji} @${p.from}`,
        reaction: { messageId: p.messageId, emoji: p.emoji, from: p.from },
        timestamp: Date.now(),
      },
      timestamp: Date.now(),
    });
  }

  private handleMessageRecall(p: MessageRecallPayload): void {
    this.emit({
      type: 'chat' as SyncEventType,
      data: {
        from: 'system',
        message: `@${p.from} recalled a message`,
        recall: { messageId: p.messageId, from: p.from, timestamp: p.timestamp },
        timestamp: p.timestamp,
      },
      timestamp: Date.now(),
    });
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
    const roomName = this._lastConfig?.room ?? '(unknown)';
    return [
      `Username: ${this.username}`,
      `Room: ${roomName}`,
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
    } catch (err) {
      console.warn('[P2PState] Failed to load config from localStorage:', err);
    }
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
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      this.transit('error', `Max reconnect attempts (${this.maxReconnectAttempts}) reached`);
      return;
    }

    this.transit('reconnecting', reason);

    // Exponential backoff: 2.5s, 5s, 10s, 20s, 30s
    const delay = Math.min(2500 * Math.pow(2, this.reconnectAttempt), 30000);
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
