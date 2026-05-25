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
const MAGIC = 'SPFT';

export function encodeTransferConnect(args: TransferConnectArgs): string {
  return `${JSON.stringify({ TransferConnect: args })}\r\n`;
}

export function encodeTransferFrame(frame: TransferFrame): Uint8Array {
  const payload = Buffer.from(frame.payload);
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
  if (buffer.toString('ascii', 0, 4) !== MAGIC) {
    throw new Error('Bad transfer frame magic');
  }
  const version = buffer.readUInt16BE(4);
  if (version !== 1) {
    throw new Error(`Unsupported transfer frame version: ${version}`);
  }
  const payloadLength = buffer.readUInt32BE(16);
  const expectedCrc = headerCrc(buffer.subarray(0, HEADER_LENGTH - 4));
  if (buffer.readUInt32BE(20) !== expectedCrc) {
    throw new Error('Bad transfer frame header crc');
  }
  const end = HEADER_LENGTH + payloadLength;
  if (buffer.length < end) {
    throw new Error('Incomplete transfer frame');
  }

  return {
    frame: {
      frameType: buffer.readUInt16BE(6),
      offset: readUInt64BE(buffer, 8),
      payload: new Uint8Array(buffer.subarray(HEADER_LENGTH, end))
    },
    remaining: new Uint8Array(buffer.subarray(end))
  };
}

export class TransferSocket {
  private buffer = Buffer.alloc(0);
  private completedPath: string | null = null;

  constructor(
    private socket: TransferSocketLike,
    private sink: TransferFileSink
  ) {}

  connect(args: TransferConnectArgs): void {
    this.socket.write(encodeTransferConnect(args));
  }

  handleData(chunk: Uint8Array): void {
    this.buffer = Buffer.from(concat(this.buffer, chunk));
    while (this.buffer.length >= HEADER_LENGTH) {
      const payloadLength = this.buffer.readUInt32BE(16);
      if (this.buffer.length < HEADER_LENGTH + payloadLength) {
        break;
      }
      const decoded = decodeTransferFrame(this.buffer);
      if (decoded.frame.frameType === 1) {
        this.sink.write(decoded.frame.payload);
      }
      if (decoded.frame.frameType === 3) {
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

  resume(transferId: string, token: string, role: 'sender' | 'receiver', offset: number): void {
    this.connect({ transferId, token, role, offset });
  }

  async upload(transferId: string, source: TransferFileSource, offset = 0, chunkSize = 262144): Promise<number> {
    let position = Math.max(0, offset);
    while (true) {
      const chunk = await source.read(position, chunkSize);
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
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a);
  result.set(b, a.length);
  return result;
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
