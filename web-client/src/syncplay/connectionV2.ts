// Syncplay P2P v2.0.0 WebRTC connection for web client
// Emits parsed messages — state management stays in existing reducer

import {
  MessageType,
  decode,
  encode,
  encodeChat,
  encodeDisconnect,
  encodeReadiness,
  helloPayload,
  playstatePayload,
} from 'syncplay-p2p-client';

import type { ConnectionConfig } from './connection.ts';
import type { ConnectionStatus } from './state.ts';

export interface P2PMessage {
  type: MessageType;
  payload: Record<string, unknown>;
}

export class SyncplayP2PConnection {
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private peerId = '';
  private hostId = '';
  private username = '';
  private room = '';

  constructor(
    private readonly onStatus: (status: ConnectionStatus, error?: string | null) => void,
    private readonly onMessage: (msg: P2PMessage) => void,
  ) {}

  get isHost(): boolean {
    return this.peerId !== '' && this.peerId === this.hostId;
  }

  async connect(config: ConnectionConfig): Promise<void> {
    this.disconnect();
    this.username = config.username;
    this.room = config.room;
    this.onStatus('connecting');

    try {
      const wsUrl = `ws://${config.host}:8998`;
      this.ws = new WebSocket(wsUrl);

      await new Promise<void>((resolve, reject) => {
        this.ws!.addEventListener('open', () => resolve());
        this.ws!.addEventListener('error', () => reject(new Error('Signaling failed')));
      });

      this.ws.send(JSON.stringify({
        type: 'create', room: config.room, password: config.password ?? '',
        username: config.username, features: ['chat', 'readiness', 'playlist'],
      }));

      const resp = await new Promise<string>((resolve) => {
        this.ws!.addEventListener('message', (e) => resolve(e.data), { once: true });
      });
      const parsed = JSON.parse(resp);
      if (parsed.type === 'error') throw new Error(parsed.message ?? 'Server error');
      this.peerId = parsed.peerId ?? '';
      this.hostId = parsed.hostId ?? '';

      this.ws.addEventListener('message', (e) => this.handleSignal(JSON.parse(e.data)));

      this.pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });

      this.pc.addEventListener('icecandidate', (e) => {
        if (e.candidate) {
          this.ws?.send(JSON.stringify({
            type: 'signal', target: '_server',
            payload: { kind: 'ice-candidate', candidate: e.candidate.candidate,
              sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex },
          }));
        }
      });

      this.pc.addEventListener('datachannel', (e) => { this.dc = e.channel; this.setupDC(); });
      this.dc = this.pc.createDataChannel('syncplay-v2');
      this.setupDC();

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.ws.send(JSON.stringify({
        type: 'signal', target: '_server', payload: { kind: 'offer', sdp: offer.sdp },
      }));

      this.onStatus('connected');
      this.sendHello();
    } catch (e) {
      this.onStatus('error', String(e));
    }
  }

  private setupDC(): void {
    if (!this.dc) return;
    this.dc.addEventListener('message', (e) => {
      if (e.data instanceof ArrayBuffer) {
        try {
          const [msgType, payload] = decode(new Uint8Array(e.data));
          this.onMessage({ type: msgType, payload: payload as Record<string, unknown> });
        } catch (err) { console.warn('[P2P] decode:', err); }
      }
    });
  }

  private async handleSignal(msg: Record<string, unknown>): Promise<void> {
    if (msg.type === 'signal' && this.pc) {
      const p = msg.payload as Record<string, unknown>;
      if (p.kind === 'answer' && typeof p.sdp === 'string')
        await this.pc.setRemoteDescription({ type: 'answer', sdp: p.sdp });
      if (p.kind === 'ice-candidate' && typeof p.candidate === 'string')
        await this.pc.addIceCandidate({
          candidate: p.candidate,
          sdpMid: p.sdpMid as string,
          sdpMLineIndex: p.sdpMLineIndex as number,
        });
    }
    if (msg.type === 'host_changed') {
      this.hostId = (msg.hostId as string) ?? this.hostId;
    }
  }

  /** Send raw bytes to the data channel, bridging Uint8Array→ArrayBuffer for TS compatibility */
  private sendRaw(data: Uint8Array): void {
    // @ts-expect-error -- RTCDataChannel.send() accepts ArrayBufferView but TS 5.x
    // is strict about ArrayBuffer vs ArrayBufferLike when msgpack returns the latter.
    this.dc!.send(data);
  }

  private sendHello(): void {
    if (!this.dc || this.dc.readyState !== 'open') {
      setTimeout(() => this.sendHello(), 200);
      return;
    }
    this.sendRaw(encode(
      MessageType.Hello,
      helloPayload(this.username, '2.0.0', this.room, ['chat', 'readiness', 'playlist']),
    ));
  }

  sendChat(text: string): void {
    if (!this.dc || this.dc.readyState !== 'open') return;
    this.sendRaw(encodeChat(this.username, text));
  }

  sendReadiness(isReady: boolean): void {
    if (!this.dc || this.dc.readyState !== 'open') return;
    this.sendRaw(encodeReadiness(this.username, isReady));
  }

  sendPlaystate(position: number, paused: boolean, doSeek: boolean, speed = 1.0): void {
    if (!this.dc || this.dc.readyState !== 'open') return;
    this.sendRaw(encode(
      MessageType.Playstate,
      playstatePayload(position, paused, doSeek, this.username, Date.now(), speed),
    ));
  }

  disconnect(): void {
    if (this.dc?.readyState === 'open') this.sendRaw(encodeDisconnect('user quit'));
    this.dc?.close();
    this.pc?.close();
    this.ws?.close();
    this.dc = null;
    this.pc = null;
    this.ws = null;
    this.onStatus('disconnected');
  }
}
