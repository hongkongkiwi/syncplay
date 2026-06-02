// Syncplay P2P v2.0.0 — React Native transport layer
// Wire protocol: [4B type u32 BE][4B len u32 BE][N bytes msgpack]
//
// Uses shared syncplay-p2p-client library for:
//   - Message types, payloads, builders (messages.ts)
//   - Wire encode/decode (wire.ts)
//   - P2PStateManager with all 20 message handlers (state.ts)
//
// This file contains ONLY the React Native transport layer:
//   - P2PConnection (WebSocket signaling → RTCPeerConnection + DataChannel)
//   - ErrorCode / humanReadableError
//   - Re-exports for App.tsx compatibility

import {
  // Protocol types
  MessageType,
  type HelloPayload,
  type ChatPayload,
  type PlaystatePayload,
  type PlaystateAction,
  type PlaystateRequestPayload,
  type ReadinessPayload,
  type FileEntry,
  type FileMetadata,
  type FileInfoPayload,
  type FileTransferPayload,
  type FileRequestPayload,
  type FileResponsePayload,
  type PlaylistAction,
  type PlaylistChangePayload,
  type PlaylistRequestPayload,
  type LatencyPingPayload,
  type LatencyPongPayload,
  type HostElectedPayload,
  type UserInfoPayload,
  type PeerDisconnectPayload,
  type VoiceMutePayload,
  type SubtitleTrack,
  type SubtitleInfoPayload,
  type ControllerAction,
  type ControllerChangePayload,
  type AvatarPreset,
  type AvatarSetPayload,
  type StatusUpdatePayload,
  type VoiceFramePayload,

  // Payload builders
  helloPayload,
  playstatePayload,
  chatPayload,
  readinessPayload,
  playstateRequestSeek,
  playstateRequestPause,
  playstateRequestPlay,
  playstateRequestSetSpeed,
  peerDisconnectPayload,
  avatarSetPayload,
  avatarSetPayloadClear,
  statusUpdatePayload,
  voiceFramePayload,

  // Constants
  AVATAR_PRESETS,
  STATUS_PRESETS,
  PAYLOAD_BY_TYPE,

  // Wire
  encode,
  decode,
  decodeHeader,

  // State manager
  P2PStateManager,
  type P2PTransport,
  type PeerState,
  type RoomStateSnapshot,
  type ConnectionState,
  type SyncEventType,
  type SyncEvent,
  type IncomingTransfer,

  // Discovery
  PeerDiscovery,
  type DiscoveredPeer,
  type DiscoveredRoom,
  type PeerFoundCallback,
} from 'syncplay-p2p-client';

// ══════════════════════════════════════════════════════════════════════════════
// Re-exports (so App.tsx still compiles)
// ══════════════════════════════════════════════════════════════════════════════

export {
  // Protocol types
  MessageType,
  type HelloPayload,
  type ChatPayload,
  type PlaystatePayload,
  type PlaystateAction,
  type PlaystateRequestPayload,
  type ReadinessPayload,
  type FileEntry,
  type FileMetadata,
  type FileInfoPayload,
  type FileTransferPayload,
  type FileRequestPayload,
  type FileResponsePayload,
  type PlaylistAction,
  type PlaylistChangePayload,
  type PlaylistRequestPayload,
  type LatencyPingPayload,
  type LatencyPongPayload,
  type HostElectedPayload,
  type UserInfoPayload,
  type PeerDisconnectPayload,
  type VoiceMutePayload,
  type SubtitleTrack,
  type SubtitleInfoPayload,
  type ControllerAction,
  type ControllerChangePayload,
  type AvatarPreset,
  type AvatarSetPayload,
  type StatusUpdatePayload,
  type VoiceFramePayload,

  // Payload builders
  helloPayload,
  playstatePayload,
  chatPayload,
  readinessPayload,
  playstateRequestSeek,
  playstateRequestPause,
  playstateRequestPlay,
  playstateRequestSetSpeed,
  peerDisconnectPayload,
  avatarSetPayload,
  avatarSetPayloadClear,
  statusUpdatePayload,
  voiceFramePayload,

  // Constants
  AVATAR_PRESETS,
  STATUS_PRESETS,
  PAYLOAD_BY_TYPE,

  // Wire
  encode,
  decode,
  decodeHeader,

  // State manager
  P2PStateManager,
  type P2PTransport,
  type PeerState,
  type RoomStateSnapshot,
  type ConnectionState,
  type SyncEventType,
  type SyncEvent,
  type IncomingTransfer,

  // Discovery
  PeerDiscovery,
  type DiscoveredPeer,
  type DiscoveredRoom,
  type PeerFoundCallback,
};

// ══════════════════════════════════════════════════════════════════════════════
// Error UX
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
// P2PConnection — WebSocket signaling → RTCPeerConnection + DataChannel
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
  get manager(): P2PStateManager { return this.stateManager; }

  // ── Connect ───────────────────────────────────────────────────────────────

  async connect(config: P2PConnectionConfig): Promise<void> {
    this.disconnect();
    this._intentionalDisconnect = false;
    this.username = config.username;
    this.lastConfig = config;
    this._sfuMode = config.sfu ?? false;

    this._connectionState = 'connecting';
    this.stateManager.transit('connecting');
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

      // 2. Create room / join via signaling — try 'create' first, fall back to 'join' if room exists
      let joinType: 'create' | 'join' = 'create';
      let resp: Record<string, unknown>;

      for (let attempt = 0; attempt < 2; attempt++) {
        this.ws.send(JSON.stringify({
          type: joinType,
          room: config.room,
          password: config.password ?? '',
          username: config.username,
          features: ['chat', 'readiness', 'playlist'],
        }));

        resp = await new Promise<Record<string, unknown>>((resolve) => {
          this.ws!.onmessage = (e) => resolve(JSON.parse(e.data as string));
        });

        // If 'create' failed because room already exists, retry with 'join'
        if (resp.type === 'error' && joinType === 'create') {
          const code = resp.code as string | undefined;
          if (code === 'room_exists' || (resp.message as string ?? '').toLowerCase().includes('already exists')) {
            joinType = 'join';
            continue; // retry
          }
        }
        break; // success or non-retryable error
      }

      if (resp!.type === 'error') {
        throw new Error(`${resp!.code ?? 'unknown'}: ${resp!.message ?? 'Signaling error'}`);
      }

      this.peerId = (resp!.peerId as string) ?? '';
      this.hostId = (resp!.hostId as string) ?? '';

      // Now handle further signaling messages
      this.ws.onmessage = (e: MessageEvent) => this.handleSignal(JSON.parse(e.data as string));

      this._connectionState = 'handshaking';
      this.stateManager.transit('handshaking');

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
        const rawState = this.pc.iceConnectionState;
        // Map RTCIceConnectionState to PeerState.iceState values
        const mapped = rawState as PeerState['iceState'];
        // Update all known peers' ICE state
        for (const stat of this.stateManager.getPeerStats()) {
          this.stateManager.updateIceState(stat.peerId, mapped);
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
          const msg = 'Connection timed out — could not establish media channel. Check your network or try TURN relay.';
          this.stateManager.transit('error', msg);
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
      this.stateManager.transit('error', message);
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
    if (!this.stateManager.connected) return;
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
    if (!this.stateManager.connected) return;
    if (!this.dc || this.dc.readyState !== 'open') return;
    // doSeek: when true, signals other peers to seek to this position (seeked event).
    // When false, this is a timeupdate-driven sync pulse (gradual correction).
    if (doSeek) {
      this.stateManager.requestSeek(position);
    } else {
      this.stateManager.updatePlaystate(position, paused, speed);
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

  sendFileInfo(file?: FileMetadata): void {
    this.stateManager.sendFileInfo(file);
  }

  toggleMute(): boolean {
    return this.stateManager.toggleMute();
  }

  setAvatar(presetId: string, customUrl: string, accent: string): void {
    this.stateManager.setAvatar(presetId, customUrl, accent);
  }

  setStatus(statusText: string): void {
    this.stateManager.setStatus(statusText);
  }

  // ── Peer stats ────────────────────────────────────────────────────────

  getPeerStats(): PeerState[] {
    // Adapt: shared lib returns Array<{peerId, username, ...}>, convert to PeerState[]
    return this.stateManager.getPeerStats().map(stat => ({
      id: stat.peerId,
      username: stat.username,
      features: [],
      isReady: stat.isReady,
      isController: false,
      isHost: false,
      rtt: stat.rtt,
      muted: stat.muted,
      iceState: stat.iceState as PeerState['iceState'],
    }));
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
