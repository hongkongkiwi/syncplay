// Syncplay P2P v2.0.0 WebRTC connection for web client
// Uses P2PStateManager for all protocol logic; connection handles signaling + transport

import {
  P2PStateManager,
  MessageType,
  encode,
  decode,
  encodeDisconnect,
  type P2PTransport,
  type SyncEvent,
  type PeerState,
} from 'syncplay-p2p-client';

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

export type ConnectionConfig = {
  host: string;
  username: string;
  room: string;
  password?: string;
  turnUrl?: string;
  sfu?: boolean;
  secure?: boolean;
};

// ── Error UX ────────────────────────────────────────────────────────

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
 * All onStatus callbacks should pass raw errors through this function
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

// ── Signaling message shapes ──────────────────────────────────────

interface SignalingMessage {
  type: 'create' | 'join' | 'signal' | 'host_changed' | 'peer_joined' | 'peer_left' | 'error' | 'welcome';
  room?: string;
  password?: string;
  username?: string;
  features?: string[];
  peerId?: string;
  hostId?: string;
  peers?: Array<{ peerId: string; username: string }>;
  from?: string;
  to?: string;
  payload?: SignalPayload;
  hostId_new?: string;
  message?: string;
}

interface SignalPayload {
  kind: 'offer' | 'answer' | 'ice-candidate';
  sdp?: string;
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

// ── Connection class ──────────────────────────────────────────────

export class SyncplayP2PConnection {
  private stateManager: P2PStateManager;
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private peerId = '';
  private hostId = '';
  private username = '';
  private room = '';
  private features: string[];
  private _transport: P2PTransport | null = null;
  private lastConfig: ConnectionConfig | null = null;
  private _intentionalDisconnect = false;
  private _sfuMode = false;
  private _webrtcTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onStatus: (status: ConnectionStatus, error?: string | null) => void,
    private readonly onMessage: (event: SyncEvent) => void,
  ) {
    this.features = ['chat', 'readiness', 'playlist'];
    this.stateManager = new P2PStateManager('', this.features);

    // Wire up StateManager events to our onMessage callback
    this.stateManager.onSyncEvent((event) => {
      this.onMessage(event);
    });

    // Wire up transport sender: when StateManager wants to send, push through data channel
    this.stateManager.onSendTransport = (msgType, payload) => {
      this.sendRaw(encode(msgType, payload as any));
    };
  }

  get isHost(): boolean {
    return this.stateManager.isHost;
  }

  get manager(): P2PStateManager {
    return this.stateManager;
  }

  // ── Connect ──────────────────────────────────────────────────────

  async connect(config: ConnectionConfig): Promise<void> {
    this.disconnect();
    this.lastConfig = config;
    this.username = config.username;
    this.room = config.room;
    this.features = ['chat', 'readiness', 'playlist'];

    // Re-create StateManager with actual username
    this.stateManager = new P2PStateManager(config.username, this.features);
    this.stateManager.onSyncEvent((event) => {
      this.onMessage(event);
    });
    this.stateManager.onSendTransport = (msgType, payload) => {
      this.sendRaw(encode(msgType, payload as any));
    };
    this.stateManager.onReconnectSuccess = () => {
      this._intentionalDisconnect = false;
    };

    this.stateManager.setLastConfig(config.host, config.username, config.room);
    this.stateManager.transit('connecting');
    this.onStatus('connecting');
    this._sfuMode = config.sfu ?? false;

    try {
      // 1. Connect WebSocket to signaling server
      const isLocal = config.host.startsWith('localhost') || config.host.startsWith('127.');
      const protocol = config.secure === true ? 'wss' : config.secure === false ? 'ws' : isLocal ? 'ws' : 'wss';
      const wsUrl = `${protocol}://${config.host}:8998`;
      this.ws = new WebSocket(wsUrl);

      await new Promise<void>((resolve, reject) => {
        if (!this.ws) return reject(new Error('WebSocket was null'));
        const onOpen = () => {
          this.ws!.removeEventListener('error', onError);
          resolve();
        };
        const onError = () => {
          this.ws!.removeEventListener('open', onOpen);
          reject(new Error('Signaling server unreachable'));
        };
        this.ws!.addEventListener('open', onOpen);
        this.ws!.addEventListener('error', onError);
      });

      // 2. Send create/join message — try 'create' first, fall back to 'join' if room exists
      let joinType: 'create' | 'join' = 'create';
      let parsed: SignalingMessage;

      for (let attempt = 0; attempt < 2; attempt++) {
        this.ws.send(JSON.stringify({
          type: joinType,
          room: config.room,
          password: config.password ?? '',
          username: config.username,
          features: this.features,
        } satisfies SignalingMessage));

        // 3. Wait for welcome response
        const rawResp = await new Promise<string>((resolve, reject) => {
          if (!this.ws) return reject(new Error('WebSocket was null'));
          const onMsg = (e: MessageEvent) => {
            this.ws!.removeEventListener('error', onErr);
            resolve(e.data as string);
          };
          const onErr = () => {
            this.ws!.removeEventListener('message', onMsg);
            reject(new Error('Signaling handshake failed'));
          };
          this.ws!.addEventListener('message', onMsg, { once: true });
          this.ws!.addEventListener('error', onErr, { once: true });
        });

        parsed = JSON.parse(rawResp) as SignalingMessage;

        // If 'create' failed because room already exists, retry with 'join'
        if (parsed.type === 'error' && joinType === 'create') {
          const code = (parsed as any).code as string | undefined;
          if (code === 'room_exists' || (parsed.message ?? '').toLowerCase().includes('already exists')) {
            joinType = 'join';
            continue; // retry
          }
        }
        break; // success or non-retryable error
      }

      if (parsed!.type === 'error') {
        throw new Error(parsed!.message ?? 'Server rejected connection');
      }
      this.peerId = parsed!.peerId ?? '';
      this.hostId = parsed!.hostId ?? '';

      // 4. Listen for further signaling messages
      this.ws.addEventListener('message', (e) => {
        this.handleSignal(JSON.parse(e.data as string) as SignalingMessage);
      });

      // 5. Set up WebRTC
      const iceServers: RTCIceServer[] = [
        { urls: 'stun:stun.l.google.com:19302' },
      ];
      if (config.turnUrl) {
        // Parse turn URL: turn:user:pass@host:port or turns:user:pass@host:port
        const turnMatch = config.turnUrl.match(
          /^(turns?):([^:@]+):([^@]+)@([^:]+)(?::(\d+))?$/,
        );
        if (turnMatch) {
          iceServers.push({
            urls: `${turnMatch[1]}:${turnMatch[4]}:${turnMatch[5] ?? '3478'}`,
            username: turnMatch[2],
            credential: turnMatch[3],
          });
        } else {
          // Assume bare URL
          iceServers.push({ urls: config.turnUrl });
        }
      }
      this.pc = new RTCPeerConnection({
        iceServers,
      });

      // ── ICE connection state tracking ──────────────────────────
      let iceTimeout: ReturnType<typeof setTimeout> | null = null;

      this.pc.addEventListener('iceconnectionstatechange', () => {
        if (!this.pc) return;
        const iceState = this.pc.iceConnectionState as RTCIceConnectionState;
        // Map RTCIceConnectionState to PeerState.iceState values
        const mapped = iceState as PeerState['iceState'];
        // Call stateManager to update all known peers' ICE state
        for (const stat of this.stateManager.getPeerStats()) {
          this.stateManager.updateIceState(stat.peerId, mapped);
        }

        // ICE connection timeout warning (30s in checking/new)
        if (iceState === 'checking' || iceState === 'new') {
          if (!iceTimeout) {
            iceTimeout = setTimeout(() => {
              console.warn('[P2P] ICE connection still in ' + iceState + ' after 30s');
            }, 30000);
          }
        } else {
          if (iceTimeout) {
            clearTimeout(iceTimeout);
            iceTimeout = null;
          }
        }
      });

      // ── WebRTC connection timeout (30s) ────────────────────────
      this._webrtcTimeout = setTimeout(() => {
        if (this.dc?.readyState !== 'open') {
          const msg = 'Connection timed out — could not establish media channel. Check your network or try TURN relay.';
          this.stateManager.transit('error', msg);
          this.onStatus('error', msg);
        }
      }, 30000);

      // ICE candidate → signaling server
      this.pc.addEventListener('icecandidate', (e) => {
        if (e.candidate && this.ws) {
          const signal: any = {
            type: 'signal',
            payload: {
              kind: 'ice-candidate',
              candidate: e.candidate.candidate,
              sdpMid: e.candidate.sdpMid,
              sdpMLineIndex: e.candidate.sdpMLineIndex,
            },
          };
          if (this._sfuMode) signal.target = '_server';
          this.ws.send(JSON.stringify(signal));
        }
      });

      // Incoming data channel (receiving side or SFU server-created)
      this.pc.addEventListener('datachannel', (e) => {
        this.dc = e.channel;
        this.setupDC();
      });

      // 6. Create and send offer
      if (this._sfuMode) {
        // SFU mode: let server create the data channel, we just send offer
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        this.ws.send(JSON.stringify({
          type: 'signal',
          target: '_server',
          payload: { kind: 'offer', sdp: offer.sdp },
        }));
      } else {
        // P2P mode: create data channel and send offer
        this.dc = this.pc.createDataChannel('syncplay-v2');
        this.setupDC();

        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        this.ws.send(JSON.stringify({
          type: 'signal',
          payload: { kind: 'offer', sdp: offer.sdp },
        } satisfies SignalingMessage));
      }

      this.stateManager.transit('handshaking');

    } catch (e) {
      if (this._webrtcTimeout) {
        clearTimeout(this._webrtcTimeout);
        this._webrtcTimeout = null;
      }
      const { message } = humanReadableError(String(e));
      this.stateManager.transit('error', message);
      this.onStatus('error', message);
    }
  }

  // ── Data channel setup ────────────────────────────────────────────

  private setupDC(): void {
    if (!this.dc) return;

    const onOpen = () => {
      // Clear the WebRTC connection timeout
      if (this._webrtcTimeout) {
        clearTimeout(this._webrtcTimeout);
        this._webrtcTimeout = null;
      }

      // Transport bridge: DataChannel → StateManager
      this._transport = {
        send: (msgType: MessageType, payload: unknown) => {
          if (this.dc && this.dc.readyState === 'open') {
            this.sendRaw(encode(msgType, payload as any));
          }
        },
      };

      // Notify StateManager we're connected
      this.stateManager.onConnected(this.peerId, this.hostId, this._transport);
      this.saveConfig();
      this.onStatus('connected');

      // Send Hello via StateManager's transport
      this._transport.send(MessageType.Hello, {
        username: this.username,
        version: '2.0.0',
        room: this.room,
        features: this.features,
      });
    };

    const onMsg = (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) {
        try {
          const [msgType, payload] = decode(new Uint8Array(e.data));
          this.stateManager.dispatch(msgType, payload);
        } catch (err) {
          console.warn('[P2P] decode error:', err);
        }
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

    // Bind when open
    this.dc.addEventListener('open', onOpen, { once: true });

    // If already open (e.g. when receiving an incoming channel), fire immediately
    if (this.dc.readyState === 'open') {
      onOpen();
    }

    this.dc.addEventListener('message', onMsg);
    this.dc.addEventListener('close', onClose);
  }

  // ── Signaling handler ─────────────────────────────────────────────

  private async handleSignal(msg: SignalingMessage): Promise<void> {
    switch (msg.type) {
      case 'signal': {
        if (!this.pc || !msg.payload) return;
        const p = msg.payload;
        try {
          if (p.kind === 'answer' && typeof p.sdp === 'string') {
            await this.pc.setRemoteDescription(new RTCSessionDescription({
              type: 'answer',
              sdp: p.sdp,
            }));
          }
          if (p.kind === 'ice-candidate' && typeof p.candidate === 'string') {
            await this.pc.addIceCandidate(new RTCIceCandidate({
              candidate: p.candidate,
              sdpMid: p.sdpMid ?? undefined,
              sdpMLineIndex: p.sdpMLineIndex ?? undefined,
            }));
          }
        } catch (err) {
          console.warn('[P2P] signal error:', err);
        }
        break;
      }

      case 'host_changed': {
        const newHost = msg.hostId_new ?? msg.hostId ?? this.hostId;
        this.hostId = newHost;
        // StateManager handles HostElected via data channel; this is a signaling-layer update
        break;
      }

      case 'peer_joined': {
        // Handled by StateManager when peer Hello arrives on data channel
        break;
      }

      case 'peer_left': {
        // StateManager handles PeerDisconnect via data channel
        break;
      }
    }
  }

  // ── Raw send helper ───────────────────────────────────────────────

  private sendRaw(data: Uint8Array): void {
    if (!this.dc || this.dc.readyState !== 'open') return;
    // @ts-expect-error — RTCDataChannel.send() accepts ArrayBufferView but TS 5.x
    // is strict about ArrayBuffer vs ArrayBufferLike when msgpack returns the latter.
    this.dc.send(data);
  }

  // ── Public API — delegate to StateManager ─────────────────────────

  sendChat(text: string): void {
    this.stateManager.sendChat(text);
  }

  sendReady(isReady: boolean): void {
    this.stateManager.setReady(isReady);
  }

  sendPlaystate(position: number, paused: boolean, doSeek: boolean, speed = 1.0): void {
    this.stateManager.updatePlaystate(position, paused, speed);
  }

  toggleReady(): boolean {
    const snap = this.stateManager.getSnapshot();
    const current = snap.readyStates[this.username] ?? false;
    this.stateManager.setReady(!current);
    return !current;
  }

  sendSlashCommand(cmd: string): string | null {
    return this.stateManager.sendSlashCommand(cmd);
  }

  sendFileInfo(file?: { name: string; duration: number; size: number; checksum?: string }): void {
    this.stateManager.sendFileInfo(file);
  }

  addToPlaylist(files: string[]): void {
    this.stateManager.addToPlaylist(files);
  }

  setPlaylistIndex(idx: number): void {
    this.stateManager.setPlaylistIndex(idx);
  }

  clearPlaylist(): void {
    this.stateManager.clearPlaylist();
  }

  addController(username: string): void {
    this.stateManager.addController(username);
  }

  removeController(username: string): void {
    this.stateManager.removeController(username);
  }

  isController(username: string): boolean {
    return this.stateManager.isController(username);
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

  sendVoiceMute(muted: boolean): void {
    this.stateManager.sendVoiceMute(muted);
  }

  toggleMute(): boolean {
    return this.stateManager.toggleMute();
  }

  requestFile(peerId: string, filename: string, offset = 0): void {
    this.stateManager.requestFile(peerId, filename, offset);
  }

  // ── Config persistence ────────────────────────────────────────────

  saveConfig(): void {
    this.stateManager.saveConfig('syncplay-p2p-config');
  }

  static loadConfig(): { host: string; username: string; room: string } {
    return P2PStateManager.loadConfig('syncplay-p2p-config');
  }

  // ── Reconnection ──────────────────────────────────────────────────

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
    this._transport = null;
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

  // ── Disconnect ────────────────────────────────────────────────────

  disconnect(): void {
    this._intentionalDisconnect = true;

    // Clear WebRTC timeout
    if (this._webrtcTimeout) {
      clearTimeout(this._webrtcTimeout);
      this._webrtcTimeout = null;
    }

    // Send PeerDisconnect if data channel is open
    if (this.dc?.readyState === 'open') {
      try {
        this.sendRaw(encodeDisconnect('user quit'));
      } catch { /* ignore */ }
    }

    this.stateManager.destroy();

    this.dc?.close();
    this.pc?.close();
    this.ws?.close();

    this.dc = null;
    this.pc = null;
    this.ws = null;
    this._transport = null;
    this.peerId = '';
    this.hostId = '';

    // Re-create a fresh manager for next connect
    this.stateManager = new P2PStateManager(this.username, this.features);
    this.stateManager.onSyncEvent((event) => {
      this.onMessage(event);
    });
    this.stateManager.onSendTransport = (msgType, payload) => {
      this.sendRaw(encode(msgType, payload as any));
    };
    this.stateManager.onReconnectSuccess = () => {
      this._intentionalDisconnect = false;
    };

    this.onStatus('disconnected');
  }
}
