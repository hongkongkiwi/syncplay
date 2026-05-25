import md5 from 'blueimp-md5';
import TcpSocket from 'react-native-tcp-socket';

import {
  LineDecoder,
  buildControlledRoomMessage,
  buildFileMessage,
  buildHelloMessage,
  buildPlaylistIndexMessage,
  buildPlaylistMessage,
  buildReadyMessage,
  buildRoomMessage,
  buildStateMessage,
  buildTransferCancelMessage,
  buildTransferDecisionMessage,
  buildTransferPauseMessage,
  buildTransferRequestMessage,
  buildTransferResumeMessage,
  buildUserReadyMessage,
  encodeMessage,
  type ClientMessage,
  type SyncplayFile,
  type SyncplayServerMessage
} from './protocol';
import type { ConnectionStatus } from './state';

type SocketLike = {
  write(data: string, encoding?: 'utf8'): boolean;
  destroy(): void;
  removeAllListeners?(): void;
  on(event: 'data', handler: (data: string | Uint8Array) => void): void;
  on(event: 'error', handler: (error: Error) => void): void;
  on(event: 'close', handler: () => void): void;
};

export type PlaybackSnapshot = {
  position: number | null;
  paused: boolean | null;
};

export type ConnectionConfig = {
  host: string;
  port: number;
  username: string;
  room: string;
  tls?: boolean;
  password?: string;
};

export class SyncplayConnection {
  private socket: SocketLike | null = null;
  private decoder = new LineDecoder();
  private connected = false;
  private lastLatencyTimestamp = 0;
  private rtt = 0;

  constructor(
    private readonly onStatus: (status: ConnectionStatus, error?: string | null) => void,
    private readonly onMessage: (message: SyncplayServerMessage) => void,
    private readonly getPlayback: () => PlaybackSnapshot
  ) {}

  connect(config: ConnectionConfig): void {
    this.disconnect();
    this.onStatus('connecting');

    const options = {
      host: config.host.trim(),
      port: config.port,
      rejectUnauthorized: true
    };
    const onConnect = () => {
      this.connected = true;
      this.send(
        buildHelloMessage({
          username: config.username,
          room: config.room,
          ...(config.password ? { passwordHash: md5(config.password) } : {})
        })
      );
    };
    const socket = (config.tls
      ? TcpSocket.connectTLS(options, onConnect)
      : TcpSocket.createConnection(options, onConnect)) as SocketLike;

    socket.on('data', data => this.handleData(data));
    socket.on('error', error => {
      this.connected = false;
      this.cleanupSocket(socket);
      this.onStatus('error', error.message);
    });
    socket.on('close', () => {
      if (this.socket !== socket) {
        return;
      }
      this.connected = false;
      this.socket = null;
      this.onStatus('disconnected');
    });

    this.socket = socket;
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
  }

  sendChat(text: string): void {
    const trimmed = text.trim();
    if (trimmed) {
      this.send({ Chat: trimmed });
    }
  }

  sendRoom(room: string): void {
    if (room.trim()) {
      this.send(buildRoomMessage(room));
    }
  }

  sendFile(file: SyncplayFile): void {
    this.send(buildFileMessage(file));
    this.send({ List: null });
  }

  sendReady(isReady: boolean): void {
    this.send(buildReadyMessage(isReady));
  }

  sendUserReady(username: string, isReady: boolean): void {
    this.send(buildUserReadyMessage(username, isReady));
  }

  requestControlledRoom(room: string, password: string): void {
    this.send(buildControlledRoomMessage(room, password));
  }

  sendPlaylist(files: string[]): void {
    this.send(buildPlaylistMessage(files));
  }

  sendPlaylistIndex(index: number): void {
    this.send(buildPlaylistIndexMessage(index));
  }

  requestTransfer(source: string, offset = 0): void {
    this.send(buildTransferRequestMessage(source, offset));
  }

  sendTransferDecision(args: {
    transferId: string;
    accepted: boolean;
    reason?: string;
    fingerprint?: string;
    chunkSize?: number;
  }): void {
    this.send(buildTransferDecisionMessage(args));
  }

  pauseTransfer(transferId: string, reason: string): void {
    this.send(buildTransferPauseMessage(transferId, reason));
  }

  resumeTransfer(transferId: string, offset: number): void {
    this.send(buildTransferResumeMessage(transferId, offset));
  }

  cancelTransfer(transferId: string, reason: string): void {
    this.send(buildTransferCancelMessage(transferId, reason));
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

  private handleData(data: string | Uint8Array): void {
    const messages = this.decoder.push(data);

    for (const message of messages) {
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

    this.lastLatencyTimestamp = timestamp;
    this.send(
      buildStateMessage({
        position: playback.position,
        paused: playback.paused,
        ...(typeof serverPing?.latencyCalculation === 'number'
          ? { latencyCalculation: serverPing.latencyCalculation }
          : {}),
        clientLatencyCalculation: this.lastLatencyTimestamp,
        clientRtt: this.rtt
      })
    );
  }

  private send(message: ClientMessage): void {
    if (!this.socket || (!this.connected && !('Hello' in message))) {
      return;
    }

    this.socket.write(encodeMessage(message), 'utf8');
  }

  private cleanupSocket(socket: SocketLike): void {
    if (this.socket !== socket) {
      return;
    }

    this.socket = null;
    socket.removeAllListeners?.();
    socket.destroy();
  }
}
