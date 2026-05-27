import { Buffer } from 'buffer';

export type TransferConnectArgs = {
  transferId: string;
  token: string;
  role: 'sender' | 'receiver';
  offset?: number;
};

export type TransferFrame = {
  frameType: number;
  offset: number;
  payload: Uint8Array;
};

export type TransferSocketLike = {
  write(data: string | Uint8Array): boolean;
  destroy(): void;
};

export type TransferFileSink = {
  write(chunk: Uint8Array): void;
  finalize?(): string | null | void;
};

export type TransferFileSource = {
  read(offset: number, length: number): Uint8Array | Promise<Uint8Array>;
};

const HEADER_LENGTH = 24;
const MAX_PAYLOAD_LENGTH = 262144;
const MAGIC = 'SPFT';

export function encodeTransferConnect(args: TransferConnectArgs): string {
  return `${JSON.stringify({ TransferConnect: args })}\r\n`;
}

export function encodeTransferFrame(frame: TransferFrame): Uint8Array {
  const payload = Buffer.from(frame.payload);
  if (payload.length > MAX_PAYLOAD_LENGTH) {
    throw new Error('Transfer frame payload is too large');
  }
  const buffer = Buffer.alloc(HEADER_LENGTH + payload.length);
  buffer.write(MAGIC, 0, 4, 'ascii');
  buffer.writeUInt16BE(1, 4);
  buffer.writeUInt16BE(frame.frameType, 6);
  writeUInt64BE(buffer, frame.offset, 8);
  buffer.writeUInt32BE(payload.length, 16);
  buffer.writeUInt32BE(headerCrc(buffer.subarray(0, HEADER_LENGTH - 4)), 20);
  payload.copy(buffer, HEADER_LENGTH);
  return new Uint8Array(buffer);
}

export function decodeTransferFrame(bufferLike: Uint8Array): { frame: TransferFrame; remaining: Uint8Array } {
  const buffer = Buffer.from(bufferLike);
  if (buffer.length < HEADER_LENGTH) {
    throw new Error('Incomplete transfer frame');
  }
  const payloadLength = readValidatedPayloadLength(buffer);
  const end = HEADER_LENGTH + payloadLength;
  if (buffer.length < end) {
    throw new Error('Incomplete transfer frame');
  }
  const frameType = buffer.readUInt16BE(6);
  if (![1, 2, 3].includes(frameType)) {
    throw new Error(`Unsupported transfer frame type: ${frameType}`);
  }

  return {
    frame: {
      frameType,
      offset: readUInt64BE(buffer, 8),
      payload: new Uint8Array(buffer.subarray(HEADER_LENGTH, end))
    },
    remaining: new Uint8Array(buffer.subarray(end))
  };
}

export class TransferSocket {
  private buffer = Buffer.alloc(0);
  private completedPath: string | null = null;
  private expectedReceiveOffset = 0;

  constructor(
    private socket: TransferSocketLike,
    private sink: TransferFileSink,
    private onControl?: (message: string) => void,
    private expectedSize?: number | null
  ) {}

  connect(args: TransferConnectArgs): void {
    this.expectedReceiveOffset = Math.max(0, args.offset ?? 0);
    this.socket.write(encodeTransferConnect(args));
  }

  handleData(chunk: Uint8Array): void {
    this.buffer = Buffer.from(concat(this.buffer, chunk));
    while (this.buffer.length >= HEADER_LENGTH) {
      const payloadLength = readValidatedPayloadLength(this.buffer);
      if (this.buffer.length < HEADER_LENGTH + payloadLength) {
        break;
      }
      const decoded = decodeTransferFrame(this.buffer);
      if (decoded.frame.frameType === 1) {
        this.assertExpectedOffset(decoded.frame.offset);
        this.assertWithinExpectedSize(decoded.frame.offset + decoded.frame.payload.length);
        this.sink.write(decoded.frame.payload);
        this.expectedReceiveOffset += decoded.frame.payload.length;
      }
      if (decoded.frame.frameType === 2) {
        this.onControl?.(Buffer.from(decoded.frame.payload).toString('utf8'));
      }
      if (decoded.frame.frameType === 3) {
        this.assertExpectedOffset(decoded.frame.offset);
        this.assertWithinExpectedSize(decoded.frame.offset);
        if (typeof this.expectedSize === 'number' && decoded.frame.offset !== this.expectedSize) {
          throw new Error(`Transfer completed at ${decoded.frame.offset} bytes, expected ${this.expectedSize}`);
        }
        const destinationPath = this.sink.finalize?.();
        this.completedPath = typeof destinationPath === 'string' ? destinationPath : null;
      }
      this.buffer = Buffer.from(decoded.remaining);
      if (!this.buffer.length) {
        break;
      }
    }
  }

  pause(): void {
    this.socket.destroy();
  }

  resume(_transferId: string, _token: string, _role: 'sender' | 'receiver', _offset: number): void {
    throw new Error('Paused transfer sockets cannot be reused. Open a new transfer socket to resume.');
  }

  async upload(transferId: string, source: TransferFileSource, offset = 0, chunkSize = 262144): Promise<number> {
    let position = Math.max(0, offset);
    const safeChunkSize = normalizeChunkSize(chunkSize);
    while (true) {
      const chunk = await source.read(position, safeChunkSize);
      if (!chunk.length) {
        break;
      }
      this.socket.write(encodeTransferFrame({
        frameType: 1,
        offset: position,
        payload: chunk
      }));
      position += chunk.length;
    }
    this.socket.write(encodeTransferFrame({ frameType: 3, offset: position, payload: new Uint8Array() }));
    return position;
  }

  getCompletedPath(): string | null {
    return this.completedPath;
  }

  private assertExpectedOffset(offset: number): void {
    if (offset !== this.expectedReceiveOffset) {
      throw new Error(`Unexpected transfer frame offset: ${offset}, expected ${this.expectedReceiveOffset}`);
    }
  }

  private assertWithinExpectedSize(offset: number): void {
    if (typeof this.expectedSize === 'number' && offset > this.expectedSize) {
      throw new Error(`Transfer frame exceeds expected size: ${offset} > ${this.expectedSize}`);
    }
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a);
  result.set(b, a.length);
  return result;
}

function normalizeChunkSize(chunkSize: number): number {
  if (!Number.isFinite(chunkSize) || chunkSize < 1) {
    return MAX_PAYLOAD_LENGTH;
  }
  return Math.min(MAX_PAYLOAD_LENGTH, Math.floor(chunkSize));
}

function writeUInt64BE(buffer: Buffer, value: number, offset: number): void {
  const high = Math.floor(value / 0x100000000);
  const low = value >>> 0;
  buffer.writeUInt32BE(high, offset);
  buffer.writeUInt32BE(low, offset + 4);
}

function readUInt64BE(buffer: Buffer, offset: number): number {
  return buffer.readUInt32BE(offset) * 0x100000000 + buffer.readUInt32BE(offset + 4);
}

function readValidatedPayloadLength(buffer: Buffer): number {
  if (buffer.toString('ascii', 0, 4) !== MAGIC) {
    throw new Error('Bad transfer frame magic');
  }
  const version = buffer.readUInt16BE(4);
  if (version !== 1) {
    throw new Error(`Unsupported transfer frame version: ${version}`);
  }
  const expectedCrc = headerCrc(buffer.subarray(0, HEADER_LENGTH - 4));
  if (buffer.readUInt32BE(20) !== expectedCrc) {
    throw new Error('Bad transfer frame header crc');
  }
  const payloadLength = buffer.readUInt32BE(16);
  if (payloadLength > MAX_PAYLOAD_LENGTH) {
    throw new Error('Transfer frame payload is too large');
  }
  return payloadLength;
}

function headerCrc(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
