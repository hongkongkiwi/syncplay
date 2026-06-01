// Syncplay P2P v2.0.0 WebRTC connection for React Native
// Self-contained — no workspace dependency needed
// To link the shared library: add react-native to pnpm-workspace.yaml, then
// `pnpm install && npx jest` and adjust transformIgnorePatterns for ESM.

import { encode as msgpackEncode, decode as msgpackDecode } from "@msgpack/msgpack";

// ── Message types (mirrors packages/p2p-client/src/messages.ts) ─────────────

export enum MessageType {
  Hello = 0,
  Playstate = 1,
  Chat = 2,
  Readiness = 3,
  PlaylistAdd = 4,
  PlaylistRemove = 5,
  PlaylistChange = 6,
  FileTransferRequest = 7,
  FileTransferAccept = 8,
  FileTransferReject = 9,
  FileTransferChunk = 10,
  FileTransferComplete = 11,
  FileTransferCancel = 12,
  PeerDisconnect = 13,
  UserJoin = 14,
  UserLeave = 15,
  UserInfo = 16,
  Ping = 17,
  Pong = 18,
  Error = 19,
  SFUOffer = 20,
  SFUAnswer = 21,
}

export interface PlaystatePayload {
  position: number;
  paused: boolean;
  doSeek: boolean;
  setBy: string;
  timestamp: number;
  speed: number;
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

export interface HelloPayload {
  username: string;
  version: string;
  room: string;
  features: string[];
}

export interface UserInfoPayload {
  username: string;
  room: string;
}

export interface FileEntry {
  name: string;
  duration: number;
  size: number;
}

// ── Wire encoding (mirrors packages/p2p-client/src/wire.ts) ─────────────────

const HEADER_SIZE = 8;
const MAX_PAYLOAD = 10 * 1024 * 1024;

export function encode<T>(msgType: MessageType, payload: T): Uint8Array {
  const body = msgpackEncode(payload);
  const bodyLen = body.byteLength;
  if (bodyLen > MAX_PAYLOAD) throw new Error(`Payload too large: ${bodyLen}`);
  const totalLen = HEADER_SIZE + bodyLen;
  const frameBuf = new ArrayBuffer(totalLen);
  const frame = new Uint8Array(frameBuf);
  const view = new DataView(frameBuf);
  view.setUint32(0, msgType, false);
  view.setUint32(4, bodyLen, false);
  for (let i = 0; i < bodyLen; i++) frame[HEADER_SIZE + i] = body[i]!;
  return frame;
}

export function decode<T>(buf: Uint8Array): [MessageType, T] {
  if (buf.byteLength < HEADER_SIZE) throw new Error("Incomplete header");
  const bufArr = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const view = new DataView(bufArr);
  const rawType = view.getUint32(0, false);
  const payloadLen = view.getUint32(4, false);
  if (payloadLen > MAX_PAYLOAD) throw new Error(`Oversized: ${payloadLen}`);
  const body = buf.slice(HEADER_SIZE, HEADER_SIZE + payloadLen);
  return [rawType as MessageType, msgpackDecode(body) as T];
}

// ── Payload builders ────────────────────────────────────────────────────────

export function helloPayload(username: string, version: string, room: string, features: string[]): HelloPayload {
  return { username, version, room, features };
}

export function playstatePayload(position: number, paused: boolean, doSeek: boolean, setBy: string, timestamp: number, speed: number): PlaystatePayload {
  return { position, paused, doSeek, setBy, timestamp, speed };
}

// ── WebRTC connection ───────────────────────────────────────────────────────

// Use react-native-webrtc in RN, built-in WebRTC in web
let RTCPeerConnectionImpl: typeof RTCPeerConnection;
let RTCSessionDescriptionImpl: typeof RTCSessionDescription;
let RTCIceCandidateImpl: typeof RTCIceCandidate;

try {
  const rnWebrtc = require('react-native-webrtc');
  RTCPeerConnectionImpl = rnWebrtc.RTCPeerConnection;
  RTCSessionDescriptionImpl = rnWebrtc.RTCSessionDescription;
  RTCIceCandidateImpl = rnWebrtc.RTCIceCandidate;
} catch {
  RTCPeerConnectionImpl = RTCPeerConnection;
  RTCSessionDescriptionImpl = RTCSessionDescription;
  RTCIceCandidateImpl = RTCIceCandidate;
}

export interface P2PConnectionConfig {
  signalingUrl: string;
  username: string;
  room: string;
  password?: string;
  sfu?: boolean;
}

export type ConnectionState =
  | 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

export class P2PConnection {
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private peerId = '';
  private hostId = '';
  private _state: ConnectionState = 'idle';
  private username = '';

  constructor(
    private readonly onStateChange: (state: ConnectionState) => void,
    private readonly onMessage: (type: MessageType, payload: unknown) => void,
  ) {}

  get state(): ConnectionState { return this._state; }
  get isHost(): boolean { return this.peerId !== '' && this.peerId === this.hostId; }

  async connect(config: P2PConnectionConfig): Promise<void> {
    this.disconnect();
    this.username = config.username;
    this._state = 'connecting';
    this.onStateChange('connecting');

    try {
      this.ws = new WebSocket(config.signalingUrl);
      await new Promise<void>((resolve, reject) => {
        this.ws!.onopen = () => resolve();
        this.ws!.onerror = () => reject(new Error('Signaling failed'));
      });

      this.ws.send(JSON.stringify({
        type: 'create', room: config.room, password: config.password ?? '',
        username: config.username, features: ['chat', 'readiness', 'playlist'],
      }));

      const resp = await new Promise<Record<string, unknown>>((resolve) => {
        this.ws!.onmessage = (e) => resolve(JSON.parse(e.data as string));
      });
      if (resp.type === 'error') throw new Error(`${resp.code ?? 'unknown'}: ${resp.message ?? 'error'}`);

      this.peerId = (resp.peerId as string) ?? '';
      this.hostId = (resp.hostId as string) ?? '';

      this.ws.onmessage = (e) => this.handleSignal(JSON.parse(e.data as string));

      this.pc = new RTCPeerConnectionImpl({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });

      this.pc.onicecandidate = (e: RTCPeerConnectionIceEvent) => {
        if (e.candidate) {
          this.ws?.send(JSON.stringify({
            type: 'signal', target: config.sfu ? '_server' : '',
            payload: { kind: 'ice-candidate', candidate: e.candidate.candidate,
              sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex },
          }));
        }
      };

      this.pc.ondatachannel = (e: RTCDataChannelEvent) => { this.dc = e.channel; this.setupDC(); };
      this.dc = this.pc.createDataChannel('syncplay-v2');
      this.setupDC();

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      if (config.sfu) {
        this.ws.send(JSON.stringify({
          type: 'signal', target: '_server', payload: { kind: 'offer', sdp: offer.sdp },
        }));
      }

      this._state = 'connected';
      this.onStateChange('connected');
    } catch (e) {
      this._state = 'error';
      this.onStateChange('error');
      throw e;
    }
  }

  private setupDC(): void {
    if (!this.dc) return;
    this.dc.onmessage = (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) {
        try {
          const [msgType, payload] = decode(new Uint8Array(e.data));
          this.onMessage(msgType, payload);
        } catch (err) { console.warn('[P2P] decode:', err); }
      }
    };
  }

  private async handleSignal(msg: Record<string, unknown>): Promise<void> {
    if (msg.type === 'signal' && this.pc) {
      const p = msg.payload as Record<string, unknown>;
      if (p.kind === 'answer' && typeof p.sdp === 'string')
        await this.pc.setRemoteDescription(new RTCSessionDescriptionImpl({ type: 'answer', sdp: p.sdp }));
      if (p.kind === 'ice-candidate' && typeof p.candidate === 'string')
        await this.pc.addIceCandidate(new RTCIceCandidateImpl({
          candidate: p.candidate, sdpMid: p.sdpMid as string, sdpMLineIndex: p.sdpMLineIndex as number,
        }));
    }
    if (msg.type === 'host_changed') this.hostId = (msg.hostId as string) ?? this.hostId;
  }

  send(messageType: MessageType, payload: unknown): void {
    if (!this.dc || this.dc.readyState !== 'open') return;
    this.dc.send(encode(messageType, payload));
  }

  sendChat(text: string): void {
    if (!this.dc || this.dc.readyState !== 'open') return;
    this.send(MessageType.Chat, { from: this.username, message: text, timestamp: Date.now() });
  }

  sendReadiness(isReady: boolean): void {
    if (!this.dc || this.dc.readyState !== 'open') return;
    this.send(MessageType.Readiness, { username: this.username, isReady, manuallyInitiated: true, setBy: this.username });
  }

  sendPlaystate(position: number, paused: boolean, doSeek: boolean, speed = 1.0): void {
    if (!this.dc || this.dc.readyState !== 'open') return;
    this.send(MessageType.Playstate, playstatePayload(position, paused, doSeek, this.username, Date.now(), speed));
  }

  disconnect(): void {
    if (this.dc?.readyState === 'open') this.send(MessageType.PeerDisconnect, { reason: 'user quit' });
    this.dc?.close();
    this.pc?.close();
    this.ws?.close();
    this.dc = null; this.pc = null; this.ws = null;
    this._state = 'disconnected';
    this.onStateChange('disconnected');
  }
}
