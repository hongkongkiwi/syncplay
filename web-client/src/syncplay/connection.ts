import {
  LineDecoder,
  buildFileMessage,
  buildHelloMessage,
  buildReadyMessage,
  buildRoomMessage,
  buildStateMessage,
  encodeMessage,
  type ClientMessage,
  type SyncplayFile,
  type SyncplayServerMessage
} from './protocol';
import type { ConnectionStatus } from './state';

export type ConnectionConfig = {
  proxyUrl: string;
  host: string;
  port: number;
  tls: boolean;
  username: string;
  room: string;
  password?: string;
};

export type PlaybackSnapshot = {
  position: number | null;
  paused: boolean | null;
};

export class SyncplayWebConnection {
  private socket: WebSocket | null = null;
  private decoder = new LineDecoder();
  private rtt = 0;

  constructor(
    private readonly onStatus: (status: ConnectionStatus, error?: string | null) => void,
    private readonly onMessage: (message: SyncplayServerMessage) => void,
    private readonly getPlayback: () => PlaybackSnapshot
  ) {}

  connect(config: ConnectionConfig): void {
    this.disconnect();
    this.onStatus('connecting');

    const socket = new WebSocket(createProxyUrl(config));
    socket.addEventListener('open', () => {
      this.send(
        buildHelloMessage({
          username: config.username,
          room: config.room,
          password: config.password
        })
      );
      this.send({ List: null });
    });
    socket.addEventListener('message', event => this.handleData(String(event.data)));
    socket.addEventListener('error', () => {
      this.onStatus('error', 'WebSocket connection failed.');
    });
    socket.addEventListener('close', event => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;
      if (event.code === 1000) {
        this.onStatus('disconnected');
      } else {
        this.onStatus('error', event.reason || `Connection closed (${event.code}).`);
      }
    });

    this.socket = socket;
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.close(1000, 'Client disconnected');
      this.socket = null;
    }
  }

  sendChat(text: string): void {
    const trimmed = text.trim();
    if (trimmed) {
      this.send({ Chat: trimmed });
    }
  }

  sendFile(file: SyncplayFile): void {
    this.send(buildFileMessage(file));
    this.send({ List: null });
  }

  sendRoom(room: string): void {
    if (room.trim()) {
      this.send(buildRoomMessage(room));
      this.send({ List: null });
    }
  }

  sendReady(isReady: boolean): void {
    this.send(buildReadyMessage(isReady));
  }

  sendPlayback(position: number, paused: boolean, doSeek = false): void {
    this.send(
      buildStateMessage({
        position,
        paused,
        doSeek,
        clientLatencyCalculation: Date.now() / 1000,
        clientRtt: this.rtt
      })
    );
  }

  private handleData(data: string): void {
    for (const message of this.decoder.push(data)) {
      this.onMessage(message);
      if (message.State) {
        this.replyToState(message);
      }
    }
  }

  private replyToState(message: SyncplayServerMessage): void {
    const playback = this.getPlayback();
    const serverPing = message.State?.ping;
    const timestamp = Date.now() / 1000;

    if (typeof serverPing?.clientLatencyCalculation === 'number') {
      this.rtt = timestamp - serverPing.clientLatencyCalculation;
    }

    this.send(
      buildStateMessage({
        position: playback.position,
        paused: playback.paused,
        ...(typeof serverPing?.latencyCalculation === 'number'
          ? { latencyCalculation: serverPing.latencyCalculation }
          : {}),
        clientLatencyCalculation: timestamp,
        clientRtt: this.rtt
      })
    );
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(encodeMessage(message));
  }
}

function createProxyUrl(config: ConnectionConfig): string {
  const base = new URL(config.proxyUrl || '/syncplay-proxy', window.location.href);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.searchParams.set('host', config.host.trim());
  base.searchParams.set('port', String(config.port));
  base.searchParams.set('tls', config.tls ? '1' : '0');
  return base.toString();
}
