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
    transfer.resume('tx1', 'secret', 'receiver', 2);

    expect(sink.chunks).toEqual([new Uint8Array([5, 6])]);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(writes.at(-1)).toBe(
      '{"TransferConnect":{"transferId":"tx1","token":"secret","role":"receiver","offset":2}}\r\n'
    );
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
});
