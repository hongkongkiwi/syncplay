import TcpSocket from 'react-native-tcp-socket';

import { SyncplayConnection } from '../src/syncplay/connection';
import { encodeTransferFrame } from '../src/syncplay/transferSocket';

jest.mock('react-native-tcp-socket', () => ({
  __esModule: true,
  default: {
    createConnection: jest.fn(),
    connectTLS: jest.fn()
  }
}));

type SocketHandlers = {
  data?: (data: string | Uint8Array) => void;
  error?: (error: Error) => void;
  close?: () => void;
};

function createMockSocket() {
  const handlers: SocketHandlers = {};
  const socket = {
    write: jest.fn<boolean, [string, 'utf8'?]>(() => true),
    destroy: jest.fn(),
    on: jest.fn((event: keyof SocketHandlers, handler: SocketHandlers[keyof SocketHandlers]) => {
      handlers[event] = handler as never;
    })
  };

  return { socket, handlers };
}

function getWritePayload(socket: ReturnType<typeof createMockSocket>['socket'], index = 0): unknown {
  const payload = socket.write.mock.calls[index]?.[0];
  if (!payload) {
    throw new Error(`Missing socket write at index ${index}`);
  }

  return JSON.parse(payload);
}

describe('SyncplayConnection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('opens a TCP socket and sends the hello message after connect', () => {
    const { socket } = createMockSocket();
    let onConnect: () => void = () => undefined;
    jest.mocked(TcpSocket.connectTLS).mockImplementation((options, callback) => {
      onConnect = callback ?? (() => undefined);
      expect(options).toEqual({ host: 'syncplay.pl', port: 8999, rejectUnauthorized: true });
      return socket as never;
    });

    const statuses: unknown[] = [];
    const connection = new SyncplayConnection(
      status => statuses.push(status),
      jest.fn(),
      () => ({ position: null, paused: true })
    );

    connection.connect({
      host: ' syncplay.pl ',
      port: 8999,
      username: 'Mobile',
      room: 'default',
      tls: true,
      password: 'secret'
    });
    onConnect();

    expect(statuses).toEqual(['connecting']);
    expect(getWritePayload(socket)).toMatchObject({
      Hello: {
        username: 'Mobile',
        password: '5ebe2294ecd0e0f08eab7690d2a6ee69',
        room: { name: 'default' }
      }
    });
  });

  it('does not send non-hello messages before the socket is connected', () => {
    const { socket } = createMockSocket();
    jest.mocked(TcpSocket.createConnection).mockImplementation(() => socket as never);
    const connection = new SyncplayConnection(jest.fn(), jest.fn(), () => ({
      position: null,
      paused: true
    }));

    connection.connect({ host: 'syncplay.pl', port: 8999, username: 'Mobile', room: 'default' });
    connection.sendChat('hello');

    expect(socket.write).not.toHaveBeenCalled();
  });

  it('trims chat messages and ignores blank chat', () => {
    const { socket } = createMockSocket();
    let onConnect: () => void = () => undefined;
    jest.mocked(TcpSocket.createConnection).mockImplementation((options, callback) => {
      onConnect = callback;
      return socket as never;
    });
    const connection = new SyncplayConnection(jest.fn(), jest.fn(), () => ({
      position: null,
      paused: true
    }));

    connection.connect({ host: 'syncplay.pl', port: 8999, username: 'Mobile', room: 'default' });
    onConnect();
    socket.write.mockClear();
    connection.sendChat('  hello room  ');
    connection.sendChat('   ');

    expect(socket.write).toHaveBeenCalledTimes(1);
    expect(getWritePayload(socket)).toEqual({ Chat: 'hello room' });
  });

  it('sends room, file, readiness, managed-room, playlist, and playback messages', () => {
    const { socket } = createMockSocket();
    let onConnect: () => void = () => undefined;
    jest.mocked(TcpSocket.createConnection).mockImplementation((options, callback) => {
      onConnect = callback;
      return socket as never;
    });
    jest.spyOn(Date, 'now').mockReturnValue(250000);
    const connection = new SyncplayConnection(jest.fn(), jest.fn(), () => ({
      position: null,
      paused: true
    }));

    connection.connect({ host: 'syncplay.pl', port: 8999, username: 'Mobile', room: 'default' });
    onConnect();
    socket.write.mockClear();
    connection.sendRoom('  film-room  ');
    connection.sendRoom('   ');
    connection.sendFile({ name: 'movie.mkv', duration: 12, size: 34 });
    connection.sendReady(true);
    connection.sendUserReady('Aki', false);
    connection.requestControlledRoom('film-room', 'ab-123-456');
    connection.sendPlaylist(['movie.mkv']);
    connection.sendPlaylistIndex(0);
    connection.sendPlayback(10, false, true);

    expect(socket.write).toHaveBeenCalledTimes(9);
    expect(socket.write.mock.calls.map(call => JSON.parse(call[0]))).toEqual([
      { Set: { room: { name: 'film-room' } } },
      { Set: { file: { name: 'movie.mkv', duration: 12, size: 34 } } },
      { List: null },
      { Set: { ready: { isReady: true, manuallyInitiated: true } } },
      { Set: { ready: { username: 'Aki', isReady: false, manuallyInitiated: true } } },
      { Set: { controllerAuth: { room: 'film-room', password: 'AB-123-456' } } },
      { Set: { playlistChange: { files: ['movie.mkv'] } } },
      { Set: { playlistIndex: { index: 0 } } },
      {
        State: {
          playstate: { position: 10, paused: false, doSeek: true },
          ping: { clientLatencyCalculation: 250, clientRtt: 0 }
        }
      }
    ]);
  });

  it('sends transfer request, decision, pause, resume, and cancel messages', () => {
    const { socket } = createMockSocket();
    let onConnect: () => void = () => undefined;
    jest.mocked(TcpSocket.createConnection).mockImplementation((options, callback) => {
      onConnect = callback;
      return socket as never;
    });
    const connection = new SyncplayConnection(jest.fn(), jest.fn(), () => ({
      position: null,
      paused: true
    }));

    connection.connect({ host: 'syncplay.pl', port: 8999, username: 'Mobile', room: 'default' });
    onConnect();
    socket.write.mockClear();
    connection.requestTransfer('Aki', 10);
    connection.sendTransferDecision({ transferId: 'tx1', accepted: true, fingerprint: 'fp' });
    connection.pauseTransfer('tx1', 'receiver');
    connection.resumeTransfer('tx1', 20, 'fp');
    connection.cancelTransfer('tx1', 'receiver');

    expect(socket.write.mock.calls.map(call => JSON.parse(call[0]))).toEqual([
      { Transfer: { request: { source: 'Aki', offset: 10 } } },
      { Transfer: { decision: { transferId: 'tx1', accepted: true, fingerprint: 'fp' } } },
      { Transfer: { pause: { transferId: 'tx1', reason: 'receiver' } } },
      { Transfer: { resume: { transferId: 'tx1', offset: 20, fingerprint: 'fp' } } },
      { Transfer: { cancel: { transferId: 'tx1', reason: 'receiver' } } }
    ]);
  });

  it('opens a receiver transfer socket and writes frames to the sink', () => {
    const { socket, handlers } = createMockSocket();
    let onConnect: () => void = () => undefined;
    jest.mocked(TcpSocket.createConnection).mockImplementation((options, callback) => {
      onConnect = callback;
      expect(options).toEqual({ host: 'syncplay.pl', port: 8999, rejectUnauthorized: true });
      return socket as never;
    });
    const sink = {
      write: jest.fn(),
      finalize: jest.fn(() => '/downloads/movie.mkv')
    };
    const completed: string[] = [];
    const connection = new SyncplayConnection(jest.fn(), jest.fn(), () => ({
      position: null,
      paused: true
    }));

    connection.openTransferSocket(
      {
        transferId: 'tx1',
        token: 'secret',
        role: 'receiver',
        host: 'syncplay.pl',
        port: 8999,
        offset: 0
      },
      sink,
      path => completed.push(path)
    );
    onConnect();
    handlers.data?.(encodeTransferFrame({ frameType: 1, offset: 0, payload: new Uint8Array([7]) }));
    handlers.data?.(encodeTransferFrame({ frameType: 3, offset: 1, payload: new Uint8Array() }));

    expect(socket.write).toHaveBeenCalledWith(
      '{"TransferConnect":{"transferId":"tx1","token":"secret","role":"receiver","offset":0}}\r\n'
    );
    expect(sink.write).toHaveBeenCalledWith(new Uint8Array([7]));
    expect(completed).toEqual(['/downloads/movie.mkv']);
  });

  it('replies to server state pings with current playback and latency', () => {
    const { socket, handlers } = createMockSocket();
    let onConnect: () => void = () => undefined;
    jest.mocked(TcpSocket.createConnection).mockImplementation((options, callback) => {
      onConnect = callback;
      return socket as never;
    });
    jest.spyOn(Date, 'now').mockReturnValue(101000);
    const onMessage = jest.fn();
    const connection = new SyncplayConnection(
      jest.fn(),
      onMessage,
      () => ({ position: 42, paused: false })
    );

    connection.connect({ host: 'syncplay.pl', port: 8999, username: 'Mobile', room: 'default' });
    onConnect();
    socket.write.mockClear();
    handlers.data?.('{"State":{"ping":{"latencyCalculation":77,"clientLatencyCalculation":100}}}\r\n');

    expect(onMessage).toHaveBeenCalledWith({
      State: {
        ping: {
          latencyCalculation: 77,
          clientLatencyCalculation: 100
        }
      }
    });
    expect(getWritePayload(socket)).toEqual({
      State: {
        playstate: {
          position: 42,
          paused: false
        },
        ping: {
          latencyCalculation: 77,
          clientLatencyCalculation: 101,
          clientRtt: 1
        }
      }
    });
  });

  it('reports socket errors and destroys sockets on disconnect', () => {
    const { socket, handlers } = createMockSocket();
    jest.mocked(TcpSocket.createConnection).mockImplementation(() => socket as never);
    const statuses: Array<[string, string | null | undefined]> = [];
    const connection = new SyncplayConnection(
      (status, error) => statuses.push([status, error]),
      jest.fn(),
      () => ({ position: null, paused: true })
    );

    connection.connect({ host: 'syncplay.pl', port: 8999, username: 'Mobile', room: 'default' });
    handlers.error?.(new Error('refused'));
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    connection.sendChat('stale socket');
    handlers.close?.();
    connection.disconnect();

    expect(statuses).toEqual([
      ['connecting', undefined],
      ['error', 'refused']
    ]);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(socket.write).not.toHaveBeenCalled();
  });
});
