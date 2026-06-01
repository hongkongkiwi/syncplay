// P2P v2.0.0 State Manager — mirrors Rust SyncManager
// Handles all 20 message types, peer tracking, host election,
// latency per-peer, controllers, speed sync, state replay, chat relay

import {
  MessageType,
  PlaystateAction,
  PlaylistAction,
  ControllerAction,
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
  type SubtitleInfoPayload,
  type UserInfoPayload,
  type VoiceMutePayload,
  chatPayload,
  playstatePayload,
  playstateRequestPause,
  playstateRequestPlay,
  playstateRequestSeek,
  playstateRequestSetSpeed,
  readinessPayload,
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
export type SyncEventType = 'chat' | 'playstate' | 'user-join' | 'user-leave' | 'host-change' | 'error';

export interface SyncEvent {
  type: SyncEventType;
  data?: unknown;
  timestamp: number;
}

type EventHandler = (event: SyncEvent) => void;

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
  private eventHandlers: EventHandler[] = [];
  private syncIntervalId: ReturnType<typeof setInterval> | null = null;
  private pingIntervalId: ReturnType<typeof setInterval> | null = null;
  private syncIntervalMs = DEF_SYNC_INTERVAL;
  private pingIntervalMs = DEF_PING_INTERVAL;
  private _connectionState: ConnectionState = 'offline';
  private _transport: P2PTransport | null = null;
  private _connected = false;

  // Configurable callbacks for the connection layer
  onSendTransport: ((msgType: MessageType, payload: unknown) => void) | null = null;

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

  setConnectionState(s: ConnectionState, error?: string): void {
    this._connectionState = s;
    if (s === 'error') this.emit({ type: 'error', data: error ?? 'Connection error', timestamp: Date.now() });
  }

  /** Called by transport when signaling handshake completes */
  onConnected(peerId: string, hostId: string, transport: P2PTransport): void {
    this.peerId = peerId;
    this.hostId = hostId;
    this._transport = transport;
    this._connected = true;
    this.setConnectionState('ready');
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
    this.setConnectionState('offline');
  }

  // ── Event system ─────────────────────────────────────────────────

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

  // ── Readiness ────────────────────────────────────────────────────

  setReady(isReady: boolean): void {
    if (!this._transport || !this._connected) return;
    this.room.readyStates.set(this.username, isReady);
    this._transport.send(MessageType.Readiness, readinessPayload(
      this.username, isReady, true, this.username,
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
    console.log(`FileTransfer chunk ${p.chunkIndex}/${Math.ceil(p.totalSize / Math.max(p.chunkSize, 1))} from ${p.transferId}`);
    // TODO: chunk assembly, SHA-256 verify, save to disk
  }

  private handleFileResponse(p: FileResponsePayload): void {
    console.log(`File transfer ${p.transferId}: ${p.accepted ? 'accepted' : 'rejected'} (${p.reason})`);
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

  destroy(): void {
    this._connected = false;
    this.stopLoop();
    this.eventHandlers = [];
  }
}
