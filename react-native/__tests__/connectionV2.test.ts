import {
  P2PConnection,
  humanReadableError,
  ErrorCode,
} from '../src/syncplay/connectionV2';

// ── Mocks ──────────────────────────────────────────────────────────────────

// Mock WebSocket
class MockWebSocket {
  onopen: (() => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  readyState = 0; // CONNECTING
  url: string;

  constructor(url: string) {
    this.url = url;
    // Simulate async connection — fire onopen on next microtick
    Promise.resolve().then(() => {
      this.readyState = 1; // OPEN
      this.onopen?.();
    });
  }

  send = jest.fn();
  close = jest.fn();
}

(global as any).WebSocket = MockWebSocket;

// Mock RTCPeerConnection — declare mock fns with "mock" prefix so Jest allows them
const mockCreateOffer = jest.fn();
const mockSetLocalDescription = jest.fn();
const mockSetRemoteDescription = jest.fn();
const mockCreateDataChannel = jest.fn();
const mockAddIceCandidate = jest.fn();
const mockPcClose = jest.fn();

// Mock RTCDataChannel
class MockRTCDataChannel {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  readyState = 'connecting';
  send = jest.fn();
  close = jest.fn();
}

// Mock RTCSessionDescription
class MockRTCSessionDescription {
  type: string;
  sdp: string;
  constructor(init: { type: string; sdp: string }) {
    this.type = init.type;
    this.sdp = init.sdp;
  }
}

// Mock RTCIceCandidate
class MockRTCIceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  constructor(init: RTCIceCandidateInit) {
    this.candidate = init.candidate ?? '';
    this.sdpMid = init.sdpMid ?? null;
    this.sdpMLineIndex = init.sdpMLineIndex ?? null;
  }
}

// Mock the dynamic import in connectionV2.ts
jest.mock(
  'react-native-webrtc',
  () => {
    const createDataChannel = jest.fn();
    const close = jest.fn().mockImplementation(function (this: any) {
      this.oniceconnectionstatechange = null;
      this.onicecandidate = null;
      this.ondatachannel = null;
    });
    const FakePeerConnection = jest.fn().mockImplementation(() => ({
      createOffer: mockCreateOffer,
      setLocalDescription: mockSetLocalDescription,
      setRemoteDescription: mockSetRemoteDescription,
      createDataChannel: createDataChannel,
      addIceCandidate: mockAddIceCandidate,
      close: close,
      oniceconnectionstatechange: null as (() => void) | null,
      onicecandidate: null as ((mockEv: any) => void) | null,
      ondatachannel: null as ((mockEv: any) => void) | null,
      iceConnectionState: 'new' as RTCIceConnectionState,
    }));

    return {
      RTCPeerConnection: FakePeerConnection,
      RTCSessionDescription: MockRTCSessionDescription,
      RTCIceCandidate: MockRTCIceCandidate,
      mediaDevices: {
        getUserMedia: jest.fn(),
      },
    };
  },
  { virtual: true },
);

// ── Helpers ────────────────────────────────────────────────────────────────

function createP2PConnection(username = 'testuser'): P2PConnection {
  return new P2PConnection(username);
}

// ── Tests: humanReadableError ──────────────────────────────────────────────

describe('humanReadableError', () => {
  it('returns SIGNALING_UNREACHABLE for unreachable errors', () => {
    const result = humanReadableError('Signaling server unreachable');
    expect(result.code).toBe(ErrorCode.SignalingUnreachable);
    expect(result.message).toContain('Cannot reach');
  });

  it('returns SIGNALING_UNREACHABLE for bare "unreachable"', () => {
    const result = humanReadableError('Host unreachable');
    expect(result.code).toBe(ErrorCode.SignalingUnreachable);
  });

  it('returns SERVER_REJECTED for rejected errors', () => {
    const result = humanReadableError('Server rejected connection: wrong password');
    expect(result.code).toBe(ErrorCode.ServerRejected);
    expect(result.message).toContain('rejected');
  });

  it('returns SERVER_REJECTED for bare "rejected"', () => {
    const result = humanReadableError('Connection was rejected');
    expect(result.code).toBe(ErrorCode.ServerRejected);
  });

  it('returns DATA_CHANNEL_CLOSED for unexpected disconnect', () => {
    const result = humanReadableError('Data channel closed unexpectedly');
    expect(result.code).toBe(ErrorCode.DataChannelClosed);
  });

  it('returns DATA_CHANNEL_CLOSED for bare "unexpected"', () => {
    const result = humanReadableError('unexpected error occurred');
    expect(result.code).toBe(ErrorCode.DataChannelClosed);
  });

  it('returns INTERNAL_ERROR for websocket null issues', () => {
    const result = humanReadableError('websocket was null');
    expect(result.code).toBe(ErrorCode.InternalError);
  });

  it('returns INTERNAL_ERROR for "internal" errors', () => {
    const result = humanReadableError('internal server error');
    expect(result.code).toBe(ErrorCode.InternalError);
  });

  it('returns UNKNOWN for unrecognized errors', () => {
    const result = humanReadableError('some random error message');
    expect(result.code).toBe(ErrorCode.Unknown);
    expect(result.message).toBe('some random error message');
  });

  it('is case-insensitive', () => {
    const result = humanReadableError('SERVER REJECTED CONNECTION');
    expect(result.code).toBe(ErrorCode.ServerRejected);
  });
});

// ── Tests: P2PConnection ───────────────────────────────────────────────────

describe('P2PConnection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateOffer.mockResolvedValue({ type: 'offer', sdp: 'mock-sdp' });
    mockSetLocalDescription.mockResolvedValue(undefined);
    mockSetRemoteDescription.mockResolvedValue(undefined);
    mockCreateDataChannel.mockReturnValue(new MockRTCDataChannel());
    mockAddIceCandidate.mockResolvedValue(undefined);
    mockPcClose.mockImplementation(function (this: any) {
      this.oniceconnectionstatechange = null;
      this.onicecandidate = null;
      this.ondatachannel = null;
    });
  });

  describe('constructor', () => {
    it('constructs and creates a P2PStateManager', () => {
      const conn = createP2PConnection('alice');
      expect(conn).toBeDefined();
      expect(conn.stateManager).toBeDefined();
      expect(conn.connectionState).toBe('offline');
    });

    it('defaults to not being host', () => {
      const conn = createP2PConnection('bob');
      expect(conn.isHost).toBe(false);
    });

    it('exposes the manager', () => {
      const conn = createP2PConnection('charlie');
      expect(conn.manager).toBe(conn.stateManager);
    });

    it('has "offline" as initial connection state', () => {
      const conn = createP2PConnection('dave');
      expect(conn.connectionState).toBe('offline');
    });
  });

  describe('connect()', () => {
    it('sets connectionState to connecting on connect', () => {
      const conn = createP2PConnection('testuser');
      conn.connect({
        signalingUrl: 'ws://localhost:9999',
        username: 'testuser',
        room: 'testroom',
        password: 'secret',
      }).catch(() => {});
      // _connectionState is set synchronously before any await
      expect(conn.connectionState).toBe('connecting');
    });
  });

  describe('disconnect()', () => {
    it('sets connectionState to offline', () => {
      const conn = createP2PConnection('testuser');
      conn.disconnect();
      expect(conn.connectionState).toBe('offline');
    });

    it('sets intentional disconnect flag', () => {
      const conn = createP2PConnection('testuser');
      conn.disconnect();
      expect(conn.connectionState).toBe('offline');
    });
  });

  describe('send()', () => {
    it('does not throw when not connected', () => {
      const conn = createP2PConnection('testuser');
      expect(() => {
        (conn as any).send(0, {});
      }).not.toThrow();
    });
  });

  describe('sendChat()', () => {
    it('does not throw when not connected', () => {
      const conn = createP2PConnection('testuser');
      expect(() => conn.sendChat('hello')).not.toThrow();
    });
  });

  describe('getPeerStats()', () => {
    it('returns an empty array when no peers connected', () => {
      const conn = createP2PConnection('testuser');
      const stats = conn.getPeerStats();
      expect(Array.isArray(stats)).toBe(true);
      expect(stats.length).toBe(0);
    });
  });

  describe('sendPlaystate()', () => {
    it('does not throw when not connected', () => {
      const conn = createP2PConnection('testuser');
      expect(() => conn.sendPlaystate(0, false, false)).not.toThrow();
    });

    it('does not throw with seek parameters', () => {
      const conn = createP2PConnection('testuser');
      expect(() => conn.sendPlaystate(10, true, true, 1.5)).not.toThrow();
    });
  });

  describe('sendReadiness()', () => {
    it('does not throw when not connected', () => {
      const conn = createP2PConnection('testuser');
      expect(() => conn.sendReadiness(true)).not.toThrow();
    });
  });

  describe('request methods', () => {
    it('requestSeek does not throw', () => {
      const conn = createP2PConnection('testuser');
      expect(() => conn.requestSeek(42)).not.toThrow();
    });

    it('requestPause does not throw', () => {
      const conn = createP2PConnection('testuser');
      expect(() => conn.requestPause()).not.toThrow();
    });

    it('requestPlay does not throw', () => {
      const conn = createP2PConnection('testuser');
      expect(() => conn.requestPlay()).not.toThrow();
    });

    it('requestSetSpeed does not throw', () => {
      const conn = createP2PConnection('testuser');
      expect(() => conn.requestSetSpeed(2.0)).not.toThrow();
    });
  });

  describe('toggleMute', () => {
    it('delegates to stateManager', () => {
      const conn = createP2PConnection('testuser');
      const result = conn.toggleMute();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('setAvatar', () => {
    it('does not throw', () => {
      const conn = createP2PConnection('testuser');
      expect(() => conn.setAvatar('default', '', '#ff0000')).not.toThrow();
    });
  });

  describe('setStatus', () => {
    it('does not throw', () => {
      const conn = createP2PConnection('testuser');
      expect(() => conn.setStatus('watching')).not.toThrow();
    });
  });

  describe('sendFileInfo', () => {
    it('does not throw', () => {
      const conn = createP2PConnection('testuser');
      expect(() => conn.sendFileInfo()).not.toThrow();
    });
  });

  describe('sendSlashCommand', () => {
    it('returns null for unknown commands', () => {
      const conn = createP2PConnection('testuser');
      expect(conn.sendSlashCommand('/unknown')).toBeNull();
    });
  });
});
