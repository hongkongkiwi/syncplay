import { Buffer } from 'buffer';

import {
  TransferSocket,
  decodeTransferFrame,
  encodeTransferConnect,
  encodeTransferFrame
} from '../src/syncplay/transferSocket';

class Sink {
  chunks: Uint8Array[] = [];
  finalized = false;
  destinationPath = '/downloads/movie.mkv';

  write(chunk: Uint8Array) {
    this.chunks.push(chunk);
  }

  finalize() {
    this.finalized = true;
    return this.destinationPath;
  }
}

describe('TransferSocket', () => {
  it('encodes transfer connect handshake', () => {
    expect(encodeTransferConnect({ transferId: 'tx1', token: 'secret', role: 'receiver' })).toBe(
      '{"TransferConnect":{"transferId":"tx1","token":"secret","role":"receiver"}}\r\n'
    );
  });

  it('encodes and decodes data frames', () => {
    const encoded = encodeTransferFrame({ frameType: 1, offset: 12, payload: new Uint8Array([1, 2, 3]) });

    const decoded = decodeTransferFrame(encoded);

    expect(decoded.frame).toEqual({ frameType: 1, offset: 12, payload: new Uint8Array([1, 2, 3]) });
    expect(decoded.remaining).toHaveLength(0);
  });

  it('rejects data frames above the payload limit before writing them', () => {
    expect(() => encodeTransferFrame({
      frameType: 1,
      offset: 0,
      payload: new Uint8Array(262145)
    })).toThrow('Transfer frame payload is too large');
  });

  it('rejects unsupported frame types', () => {
    const encoded = encodeTransferFrame({ frameType: 99, offset: 0, payload: new Uint8Array() });

    expect(() => decodeTransferFrame(encoded)).toThrow('Unsupported transfer frame type');
  });

  it('writes file chunks to sink and supports pause/resume offsets', () => {
    const sink = new Sink();
    const writes: Array<string | Uint8Array> = [];
    const socket = {
      write: jest.fn((data: string | Uint8Array) => {
        writes.push(data);
        return true;
      }),
      destroy: jest.fn()
    };
    const transfer = new TransferSocket(socket, sink);

    transfer.connect({ transferId: 'tx1', token: 'secret', role: 'receiver' });
    transfer.handleData(encodeTransferFrame({ frameType: 1, offset: 0, payload: new Uint8Array([5, 6]) }));
    transfer.pause();

    expect(sink.chunks).toEqual([new Uint8Array([5, 6])]);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(() => transfer.resume('tx1', 'secret', 'receiver', 2)).toThrow('Open a new transfer socket');
  });

  it('reports ready control frames', () => {
    const socket = { write: jest.fn(() => true), destroy: jest.fn() };
    const controls: string[] = [];
    const transfer = new TransferSocket(socket, new Sink(), message => controls.push(message));

    transfer.handleData(encodeTransferFrame({ frameType: 2, offset: 0, payload: Buffer.from('ready') }));

    expect(controls).toEqual(['ready']);
  });

  it('records the completed destination path after the complete frame', () => {
    const sink = new Sink();
    const socket = {
      write: jest.fn(() => true),
      destroy: jest.fn()
    };
    const transfer = new TransferSocket(socket, sink);

    transfer.handleData(encodeTransferFrame({ frameType: 3, offset: 0, payload: new Uint8Array() }));

    expect(sink.finalized).toBe(true);
    expect(transfer.getCompletedPath()).toBe('/downloads/movie.mkv');
  });

  it('rejects out-of-order data frames', () => {
    const sink = new Sink();
    const socket = {
      write: jest.fn(() => true),
      destroy: jest.fn()
    };
    const transfer = new TransferSocket(socket, sink);

    expect(() => transfer.handleData(encodeTransferFrame({ frameType: 1, offset: 4, payload: new Uint8Array([1]) })))
      .toThrow('Unexpected transfer frame offset');
    expect(sink.chunks).toEqual([]);
  });

  it('rejects completion before the expected file size is received', () => {
    const sink = new Sink();
    const socket = {
      write: jest.fn(() => true),
      destroy: jest.fn()
    };
    const transfer = new TransferSocket(socket, sink, undefined, 4);

    transfer.handleData(encodeTransferFrame({ frameType: 1, offset: 0, payload: new Uint8Array([1, 2]) }));

    expect(() => transfer.handleData(encodeTransferFrame({ frameType: 3, offset: 2, payload: new Uint8Array() })))
      .toThrow('Transfer completed at 2 bytes, expected 4');
    expect(sink.finalized).toBe(false);
  });

  it('rejects frames that exceed the expected file size', () => {
    const sink = new Sink();
    const socket = {
      write: jest.fn(() => true),
      destroy: jest.fn()
    };
    const transfer = new TransferSocket(socket, sink, undefined, 1);

    expect(() => transfer.handleData(encodeTransferFrame({ frameType: 1, offset: 0, payload: new Uint8Array([1, 2]) })))
      .toThrow('Transfer frame exceeds expected size');
    expect(sink.chunks).toEqual([]);
  });

  it('buffers partial data frames until the payload arrives', () => {
    const sink = new Sink();
    const socket = {
      write: jest.fn(() => true),
      destroy: jest.fn()
    };
    const transfer = new TransferSocket(socket, sink);
    const encoded = encodeTransferFrame({ frameType: 1, offset: 0, payload: new Uint8Array([1, 2, 3]) });

    transfer.handleData(encoded.slice(0, 25));
    transfer.handleData(encoded.slice(25));

    expect(sink.chunks).toEqual([new Uint8Array([1, 2, 3])]);
  });

  it('uploads source bytes as data frames followed by complete', async () => {
    const sink = new Sink();
    const writes: Array<string | Uint8Array> = [];
    const socket = {
      write: jest.fn((data: string | Uint8Array) => {
        writes.push(data);
        return true;
      }),
      destroy: jest.fn()
    };
    const transfer = new TransferSocket(socket, sink);

    const bytes = new Uint8Array([1, 2, 3, 4]);
    await transfer.upload('tx1', { read: (offset, length) => bytes.slice(offset, offset + length) }, 1, 2);

    expect(decodeTransferFrame(writes[0] as Uint8Array).frame).toEqual({
      frameType: 1,
      offset: 1,
      payload: new Uint8Array([2, 3])
    });
    expect(decodeTransferFrame(writes[1] as Uint8Array).frame).toEqual({
      frameType: 1,
      offset: 3,
      payload: new Uint8Array([4])
    });
    expect(decodeTransferFrame(writes[2] as Uint8Array).frame).toMatchObject({
      frameType: 3,
      offset: 4
    });
  });

  it('caps upload chunks at the transfer frame payload limit', async () => {
    const sink = new Sink();
    const writes: Array<string | Uint8Array> = [];
    const socket = {
      write: jest.fn((data: string | Uint8Array) => {
        writes.push(data);
        return true;
      }),
      destroy: jest.fn()
    };
    const transfer = new TransferSocket(socket, sink);
    const bytes = new Uint8Array(262145);
    bytes[262144] = 9;

    await transfer.upload('tx1', { read: (offset, length) => bytes.slice(offset, offset + length) }, 0, 999999);

    expect(decodeTransferFrame(writes[0] as Uint8Array).frame.payload).toHaveLength(262144);
    expect(decodeTransferFrame(writes[1] as Uint8Array).frame).toEqual({
      frameType: 1,
      offset: 262144,
      payload: new Uint8Array([9])
    });
    expect(decodeTransferFrame(writes[2] as Uint8Array).frame).toMatchObject({
      frameType: 3,
      offset: 262145
    });
  });
});
