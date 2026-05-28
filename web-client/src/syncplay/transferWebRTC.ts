/**
 * TransferWebRTC — WebRTC DataChannel-based P2P file transfer module.
 *
 * Mirrors the React Native TransferSocket class but uses browser APIs
 * (RTCPeerConnection / RTCDataChannel) instead of a raw TCP socket.
 *
 * SPFT framing (encodeTransferFrame / decodeTransferFrame) is ported from
 * react-native/src/syncplay/transferSocket.ts using DataView + ArrayBuffer
 * instead of Node's Buffer.
 */

// ── SPFT framing constants ────────────────────────────────────────────────

const HEADER_LENGTH = 24;
const MAX_PAYLOAD_LENGTH = 262144; // 256 KiB
const MAGIC = 'SPFT';

// ── Types (mirror react-native/src/syncplay/transferSocket.ts) ────────────

export type TransferConnectArgs = {
  transferId: string;
  token: string;
  role: 'sender' | 'receiver';
  offset?: number;
};

export type TransferFrame = {
  frameType: number; // 1 = data, 2 = control, 3 = completion
  offset: number;
  payload: Uint8Array;
};

export type TransferFileSink = {
  write(chunk: Uint8Array): void;
  finalize?(): string | null | void;
};

export type TransferFileSource = {
  read(offset: number, length: number): Uint8Array | Promise<Uint8Array>;
};

// ── SPFT helpers (browser-native, no Node.js Buffer) ──────────────────────

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function headerCrc(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a);
  result.set(b, a.length);
  return result as unknown as Uint8Array;
}

function normalizeChunkSize(chunkSize: number): number {
  if (!Number.isFinite(chunkSize) || chunkSize < 1) {
    return MAX_PAYLOAD_LENGTH;
  }
  return Math.min(MAX_PAYLOAD_LENGTH, Math.floor(chunkSize));
}

export function encodeTransferConnect(args: TransferConnectArgs): string {
  return `${JSON.stringify({ TransferConnect: args })}\r\n`;
}

export function encodeTransferFrame(frame: TransferFrame): Uint8Array {
  const { payload } = frame;
  if (payload.length > MAX_PAYLOAD_LENGTH) {
    throw new Error('Transfer frame payload is too large');
  }

  const buf = new ArrayBuffer(HEADER_LENGTH + payload.length);
  const view = new DataView(buf);
  const magic = textEncoder.encode(MAGIC);
  const u8 = new Uint8Array(buf);

  u8.set(magic, 0);                             // 0-3: magic
  view.setUint16(4, 1);                          // 4-5: version = 1
  view.setUint16(6, frame.frameType);            // 6-7: frame type
  writeUInt64BE(view, frame.offset, 8);          // 8-15: offset (BigInt-based)

  view.setUint32(16, payload.length);            // 16-19: payload length

  // CRC over first 20 bytes
  const crc = headerCrc(new Uint8Array(buf, 0, 20));
  view.setUint32(20, crc);                       // 20-23: header CRC

  u8.set(payload, HEADER_LENGTH);                // 24+: payload

  return u8;
}

export function decodeTransferFrame(bufferLike: Uint8Array): {
  frame: TransferFrame;
  remaining: Uint8Array;
} {
  if (bufferLike.length < HEADER_LENGTH) {
    throw new Error('Incomplete transfer frame');
  }

  const magicStr = textDecoder.decode(bufferLike.subarray(0, 4));
  if (magicStr !== MAGIC) {
    throw new Error('Bad transfer frame magic');
  }

  const view = new DataView(bufferLike.buffer, bufferLike.byteOffset, bufferLike.byteLength);

  const version = view.getUint16(4);
  if (version !== 1) {
    throw new Error(`Unsupported transfer frame version: ${version}`);
  }

  const expectedCrc = headerCrc(bufferLike.subarray(0, 20));
  const storedCrc = view.getUint32(20);
  if (storedCrc !== expectedCrc) {
    throw new Error('Bad transfer frame header crc');
  }

  const payloadLength = view.getUint32(16);
  if (payloadLength > MAX_PAYLOAD_LENGTH) {
    throw new Error('Transfer frame payload is too large');
  }

  const end = HEADER_LENGTH + payloadLength;
  if (bufferLike.length < end) {
    throw new Error('Incomplete transfer frame');
  }

  const frameType = view.getUint16(6);
  if (![1, 2, 3].includes(frameType)) {
    throw new Error(`Unsupported transfer frame type: ${frameType}`);
  }

  return {
    frame: {
      frameType,
      offset: readUInt64BE(view, 8),
      payload: bufferLike.subarray(HEADER_LENGTH, end),
    },
    remaining: bufferLike.subarray(end),
  };
}

function writeUInt64BE(view: DataView, value: number, offset: number): void {
  // Use BigInt for correct 64-bit representation
  const big = BigInt(Math.trunc(value));
  const high = Number(big >> 32n) >>> 0;
  const low = Number(big & 0xffffffffn) >>> 0;
  view.setUint32(offset, high);
  view.setUint32(offset + 4, low);
}

function readUInt64BE(view: DataView, offset: number): number {
  const high = view.getUint32(offset);
  const low = view.getUint32(offset + 4);
  return high * 0x100000000 + low;
}

// ── TransferWebRTC ────────────────────────────────────────────────────────

type PendingIce = RTCIceCandidateInit[];

export class TransferWebRTC {
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private buffer: Uint8Array = new Uint8Array(0);
  private completedPath: string | null = null;
  private expectedReceiveOffset = 0;
  private pendingIce: PendingIce = [];
  private connectArgs: TransferConnectArgs | null = null;
  private isChannelOpen = false;

  constructor(
    private rtcConfig: RTCConfiguration,
    private onSignal: (message: {
      sdp?: RTCSessionDescriptionInit;
      ice?: RTCIceCandidateInit;
    }) => void,
    private sink: TransferFileSink,
    private onControl?: (message: string) => void,
    private expectedSize?: number | null,
  ) {}

  // ── lifecycle ────────────────────────────────────────────────────────

  connect(args: TransferConnectArgs): void {
    this.connectArgs = args;
    this.expectedReceiveOffset = Math.max(0, args.offset ?? 0);
    this.isChannelOpen = false;

    this.pc = new RTCPeerConnection(this.rtcConfig);

    this.pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate) {
        const ice = event.candidate.toJSON();
        if (this.pc?.remoteDescription) {
          this.onSignal({ ice });
        } else {
          this.pendingIce.push(ice);
        }
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      if (this.pc?.iceConnectionState === 'failed') {
        this.onControl?.('ICE connection failed');
      }
    };

    if (args.role === 'sender') {
      this.createDataChannel();
      this.createOffer();
    }
  }

  private createDataChannel(): void {
    if (!this.pc) return;

    this.channel = this.pc.createDataChannel('syncplay-transfer', {
      ordered: true,
    });

    this.channel.binaryType = 'arraybuffer';

    this.channel.onopen = () => {
      this.isChannelOpen = true;
      this.onControl?.('DataChannel opened');
      // Flush any pending ice
      for (const ice of this.pendingIce) {
        this.onSignal({ ice });
      }
      this.pendingIce = [];

      // Send connect handshake
      if (this.channel && this.connectArgs) {
        this.channel.send(encodeTransferConnect(this.connectArgs));
      }
    };

    this.channel.onmessage = (event: MessageEvent) => {
      const data = event.data;
      if (data instanceof ArrayBuffer) {
        this.handleData(new Uint8Array(data));
      }
    };

    this.channel.onclose = () => {
      this.onControl?.('DataChannel closed');
      this.isChannelOpen = false;
    };

    this.channel.onerror = () => {
      this.onControl?.('DataChannel error');
    };
  }

  private async createOffer(): Promise<void> {
    if (!this.pc) return;
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    if (this.pc.localDescription) {
      this.onSignal({
        sdp: {
          type: this.pc.localDescription.type,
          sdp: this.pc.localDescription.sdp,
        },
      });
    }
  }

  async handleSignal(message: {
    sdp?: RTCSessionDescriptionInit;
    ice?: RTCIceCandidateInit;
  }): Promise<void> {
    if (message.ice) {
      if (this.pc) {
        try {
          await this.pc.addIceCandidate(new RTCIceCandidate(message.ice));
        } catch {
          // Candidates may arrive before remote description; ignore transient errors
        }
      }
      return;
    }

    if (message.sdp) {
      if (!this.pc) {
        // Receiver: create PC when we get an offer
        this.pc = new RTCPeerConnection(this.rtcConfig);

        this.pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
          if (event.candidate) {
            const ice = event.candidate.toJSON();
            if (this.pc?.remoteDescription) {
              this.onSignal({ ice });
            } else {
              this.pendingIce.push(ice);
            }
          }
        };

        this.pc.oniceconnectionstatechange = () => {
          if (this.pc?.iceConnectionState === 'failed') {
            this.onControl?.('ICE connection failed');
          }
        };

        this.pc.ondatachannel = (event: RTCDataChannelEvent) => {
          this.channel = event.channel;
          this.channel.binaryType = 'arraybuffer';

          this.channel.onopen = () => {
            this.isChannelOpen = true;
            this.onControl?.('DataChannel opened');
            for (const ice of this.pendingIce) {
              this.onSignal({ ice });
            }
            this.pendingIce = [];
          };

          this.channel.onmessage = (msg: MessageEvent) => {
            const data = msg.data;
            if (data instanceof ArrayBuffer) {
              this.handleData(new Uint8Array(data));
            }
          };

          this.channel.onclose = () => {
            this.onControl?.('DataChannel closed');
            this.isChannelOpen = false;
          };

          this.channel.onerror = () => {
            this.onControl?.('DataChannel error');
          };
        };
      }

      await this.pc.setRemoteDescription(
        new RTCSessionDescription(message.sdp),
      );

      // Flush pending candidates now that we have remote description
      for (const ice of this.pendingIce) {
        this.onSignal({ ice });
      }
      this.pendingIce = [];

      if (message.sdp.type === 'offer') {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        if (this.pc.localDescription) {
          this.onSignal({
            sdp: {
              type: this.pc.localDescription.type,
              sdp: this.pc.localDescription.sdp,
            },
          });
        }
      }
    }
  }

  // ── data handling ────────────────────────────────────────────────────

  handleData(chunk: Uint8Array): void {
    this.buffer = concat(this.buffer, chunk);

    while (this.buffer.length >= HEADER_LENGTH) {
      let payloadLength: number;
      try {
        const view = new DataView(
          this.buffer.buffer,
          this.buffer.byteOffset,
          this.buffer.byteLength,
        );
        const magic = textDecoder.decode(this.buffer.subarray(0, 4));
        if (magic !== MAGIC) {
          throw new Error('Bad transfer frame magic');
        }
        payloadLength = view.getUint32(16);
        if (payloadLength > MAX_PAYLOAD_LENGTH) {
          throw new Error('Transfer frame payload is too large');
        }
      } catch {
        break;
      }

      if (this.buffer.length < HEADER_LENGTH + payloadLength) {
        break;
      }

      try {
        const decoded = decodeTransferFrame(this.buffer);

        if (decoded.frame.frameType === 1) {
          this.assertExpectedOffset(decoded.frame.offset);
          this.assertWithinExpectedSize(
            decoded.frame.offset + decoded.frame.payload.length,
          );
          this.sink.write(decoded.frame.payload);
          this.expectedReceiveOffset += decoded.frame.payload.length;
        }

        if (decoded.frame.frameType === 2) {
          this.onControl?.(
            textDecoder.decode(decoded.frame.payload),
          );
        }

        if (decoded.frame.frameType === 3) {
          this.assertExpectedOffset(decoded.frame.offset);
          this.assertWithinExpectedSize(decoded.frame.offset);
          if (
            typeof this.expectedSize === 'number' &&
            decoded.frame.offset !== this.expectedSize
          ) {
            throw new Error(
              `Transfer completed at ${decoded.frame.offset} bytes, expected ${this.expectedSize}`,
            );
          }
          const destinationPath = this.sink.finalize?.();
          this.completedPath =
            typeof destinationPath === 'string' ? destinationPath : null;
        }

        this.buffer = decoded.remaining as Uint8Array;
        if (!this.buffer.length) {
          break;
        }
      } catch (err) {
        this.onControl?.(
          `Transfer frame error: ${err instanceof Error ? err.message : String(err)}`,
        );
        break;
      }
    }
  }

  // ── upload (sender API) ──────────────────────────────────────────────

  async upload(
    transferId: string,
    source: TransferFileSource,
    offset = 0,
    chunkSize = 262144,
  ): Promise<number> {
    let position = Math.max(0, offset);
    const safeChunkSize = normalizeChunkSize(chunkSize);

    while (true) {
      const chunk = await source.read(position, safeChunkSize);
      if (!chunk.length) {
        break;
      }
      this.sendFrame({
        frameType: 1,
        offset: position,
        payload: chunk,
      });
      position += chunk.length;
    }

    this.sendFrame({
      frameType: 3,
      offset: position,
      payload: new Uint8Array(),
    });

    return position;
  }

  private sendFrame(frame: TransferFrame): void {
    if (!this.channel || this.channel.readyState !== 'open') {
      throw new Error('DataChannel is not open');
    }
    const encoded = encodeTransferFrame(frame);
    // Send the ArrayBuffer — DataChannel.send accepts it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.channel.send(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as any);
  }

  // ── control ──────────────────────────────────────────────────────────

  pause(): void {
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    this.isChannelOpen = false;
  }

  resume(
    _transferId: string,
    _token: string,
    _role: 'sender' | 'receiver',
    _offset: number,
  ): void {
    throw new Error(
      'Paused transfer cannot be resumed. Create a new TransferWebRTC to restart.',
    );
  }

  getCompletedPath(): string | null {
    return this.completedPath;
  }

  isOpen(): boolean {
    return this.isChannelOpen && (this.channel?.readyState === 'open');
  }

  // ── assertions ───────────────────────────────────────────────────────

  private assertExpectedOffset(offset: number): void {
    if (offset !== this.expectedReceiveOffset) {
      throw new Error(
        `Unexpected transfer frame offset: ${offset}, expected ${this.expectedReceiveOffset}`,
      );
    }
  }

  private assertWithinExpectedSize(offset: number): void {
    if (typeof this.expectedSize === 'number' && offset > this.expectedSize) {
      throw new Error(
        `Transfer frame exceeds expected size: ${offset} > ${this.expectedSize}`,
      );
    }
  }
}
