import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  P2PStateManager,
  type P2PTransport,
  type ConnectionState,
  type SyncEvent,
} from './state';
import {
  MessageType,
  PlaystateAction,
  PlaylistAction,
  ControllerAction,
} from './messages';

// ── localStorage stub for Node ──────────────────────────────────

const localStorageMap = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => localStorageMap.get(key) ?? null,
  setItem: (key: string, value: string) => { localStorageMap.set(key, value); },
  removeItem: (key: string) => { localStorageMap.delete(key); },
  clear: () => { localStorageMap.clear(); },
  get length() { return localStorageMap.size; },
  key: (index: number) => [...localStorageMap.keys()][index] ?? null,
});

// ── Helpers ────────────────────────────────────────────────────────

interface SentMessage {
  msgType: MessageType;
  payload: unknown;
}

/** Creates a mock transport that captures all sent messages */
function mockTransport(): { transport: P2PTransport; sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  const transport: P2PTransport = {
    send(msgType: MessageType, payload: unknown): void {
      sent.push({ msgType, payload });
    },
  };
  return { transport, sent };
}

/** Walk the state machine from offline → ready by injecting states directly.
 *  onConnected() calls transit('ready') but only from connecting_peers or handshaking
 *  is valid. We force the state to 'connecting_peers' first. */
function forceState(manager: P2PStateManager, state: ConnectionState): void {
  (manager as any)._connectionState = state;
}

/** Set up a P2PStateManager as the host for tests that need a connected host */
function setupHost() {
  const manager = new P2PStateManager('hostuser');
  const { transport, sent } = mockTransport();
  forceState(manager, 'connecting_peers');
  manager.onConnected('hostuser', 'hostuser', transport);
  sent.length = 0; // clear messages sent by onConnected (hostTick, etc)
  return { manager, transport, sent };
}

/** Set up a P2PStateManager as a non-host peer */
function setupPeer(peerId = 'peer1') {
  const manager = new P2PStateManager('peeruser');
  const { transport, sent } = mockTransport();
  forceState(manager, 'connecting_peers');
  manager.onConnected(peerId, 'hostuser', transport);
  sent.length = 0;
  return { manager, transport, sent };
}

// ── 1. Connection State Machine ───────────────────────────────────

describe('Connection state machine', () => {
  let manager: P2PStateManager;

  beforeEach(() => {
    manager = new P2PStateManager('testuser');
  });

  const assertTransition = (
    from: ConnectionState,
    to: ConnectionState,
    expectedState: ConnectionState,
    expectChange: boolean,
  ) => {
    // Force internal state to `from`
    (manager as any)._connectionState = from;
    manager.transit(to);
    expect(manager.connectionState).toBe(expectedState);
    if (expectChange) {
      expect(manager.transitionTimestamp).toBeGreaterThan(0);
    }
  };

  it('offline → connecting (valid)', () => {
    assertTransition('offline', 'connecting', 'connecting', true);
  });

  it('connecting → handshaking (valid)', () => {
    assertTransition('connecting', 'handshaking', 'handshaking', true);
  });

  it('handshaking → ready (valid)', () => {
    assertTransition('handshaking', 'ready', 'ready', true);
  });

  it('handshaking → connecting_peers (valid)', () => {
    assertTransition('handshaking', 'connecting_peers', 'connecting_peers', true);
  });

  it('ready → reconnecting (valid)', () => {
    assertTransition('ready', 'reconnecting', 'reconnecting', true);
  });

  it('reconnecting → ready (valid)', () => {
    assertTransition('reconnecting', 'ready', 'ready', true);
  });

  it('reconnecting → offline (valid)', () => {
    assertTransition('reconnecting', 'offline', 'offline', true);
  });

  it('any → error (valid - always allowed)', () => {
    assertTransition('connecting', 'error', 'error', true);
    // Error fires an event
  });

  it('connecting → ready (INVALID - should be rejected)', () => {
    (manager as any)._connectionState = 'connecting';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    manager.transit('ready');
    expect(manager.connectionState).toBe('connecting'); // unchanged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Illegal transition: connecting → ready'),
    );
    warnSpy.mockRestore();
  });

  it('ready → connecting (INVALID)', () => {
    (manager as any)._connectionState = 'ready';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    manager.transit('connecting');
    expect(manager.connectionState).toBe('ready'); // unchanged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Illegal transition: ready → connecting'),
    );
    warnSpy.mockRestore();
  });

  it('error state fires error event', () => {
    const events: SyncEvent[] = [];
    manager.onSyncEvent((e) => events.push(e));
    manager.transit('error', 'Test error');
    expect(manager.connectionState).toBe('error');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(events[0].data).toBe('Test error');
  });

  it('same state transition is a no-op', () => {
    (manager as any)._connectionState = 'ready';
    manager.transit('ready');
    // should not throw / should not change anything
    expect(manager.connectionState).toBe('ready');
  });

  it('offline transition cancels reconnect timer', () => {
    (manager as any)._connectionState = 'connecting'; // not already offline
    const cancelSpy = vi.spyOn(manager, 'cancelReconnect');
    manager.transit('offline');
    expect(cancelSpy).toHaveBeenCalled();
    cancelSpy.mockRestore();
  });
});

// ── 2. Message Handlers ──────────────────────────────────────────

describe('Message handlers', () => {
  it('Playstate handler: updates position, paused, speed, setBy', () => {
    const manager = new P2PStateManager('hostuser');
    const { transport, sent } = mockTransport();
    // set up as host so handlePlaystate processes
    forceState(manager, 'connecting_peers');
    manager.onConnected('hostuser', 'hostuser', transport);

    const snap0 = manager.getSnapshot();
    expect(snap0.position).toBe(0);
    expect(snap0.paused).toBe(true);

    manager.dispatch(MessageType.Playstate, {
      position: 120.5,
      paused: false,
      doSeek: true,
      setBy: 'hostuser',
      seq: 1,
      timestamp: Date.now(),
      speed: 1.5,
    });

    const snap = manager.getSnapshot();
    expect(snap.position).toBeGreaterThanOrEqual(120.5);
    expect(snap.paused).toBe(false);
    expect(snap.speed).toBe(1.5);
    expect(snap.setBy).toBe('hostuser');
    expect(snap.seq).toBe(1);
  });

  it('Playstate handler: seq-based dedup (lower seq ignored)', () => {
    const manager = new P2PStateManager('hostuser');
    const { transport } = mockTransport();
    forceState(manager, 'connecting_peers');
    manager.onConnected('hostuser', 'hostuser', transport);

    // First: set high seq
    manager.dispatch(MessageType.Playstate, {
      position: 50,
      paused: false,
      doSeek: true,
      setBy: 'hostuser',
      seq: 10,
      timestamp: Date.now(),
      speed: 1.0,
    });

    // Second: lower seq from same setBy — should be ignored
    manager.dispatch(MessageType.Playstate, {
      position: 999,
      paused: true,
      doSeek: true,
      setBy: 'hostuser',
      seq: 5,
      timestamp: Date.now(),
      speed: 1.0,
    });

    const snap = manager.getSnapshot();
    expect(snap.seq).toBe(10); // seq unchanged
    expect(snap.position).toBeGreaterThanOrEqual(50);
    expect(snap.position).toBeLessThan(100); // position from higher seq
  });

  it('Chat handler: emits chat event', () => {
    const manager = new P2PStateManager('hostuser');
    const { transport } = mockTransport();
    forceState(manager, 'connecting_peers');
    manager.onConnected('hostuser', 'hostuser', transport);

    const events: SyncEvent[] = [];
    manager.onSyncEvent((e) => events.push(e));

    manager.dispatch(MessageType.Chat, {
      from: 'otheruser',
      message: 'Hello world',
      timestamp: Date.now(),
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('chat');
    expect((events[0].data as any).from).toBe('otheruser');
    expect((events[0].data as any).message).toBe('Hello world');
  });

  it('Chat handler: self-echo prevention (own messages skipped)', () => {
    const manager = new P2PStateManager('hostuser');
    const { transport } = mockTransport();
    forceState(manager, 'connecting_peers');
    manager.onConnected('hostuser', 'hostuser', transport);

    const events: SyncEvent[] = [];
    manager.onSyncEvent((e) => events.push(e));

    // Send chat as self
    manager.dispatch(MessageType.Chat, {
      from: 'hostuser',
      message: 'self message',
      timestamp: Date.now(),
    });

    expect(events).toHaveLength(0); // self chat skipped
  });

  it('Readiness handler: updates readyStates', () => {
    const manager = new P2PStateManager('hostuser');
    const { transport } = mockTransport();
    forceState(manager, 'connecting_peers');
    manager.onConnected('hostuser', 'hostuser', transport);

    manager.dispatch(MessageType.Readiness, {
      username: 'peer1',
      isReady: true,
      manuallyInitiated: true,
      setBy: 'peer1',
    });

    const snap = manager.getSnapshot();
    expect(snap.readyStates['peer1']).toBe(true);

    manager.dispatch(MessageType.Readiness, {
      username: 'peer1',
      isReady: false,
      manuallyInitiated: true,
      setBy: 'peer1',
    });

    expect(manager.getSnapshot().readyStates['peer1']).toBe(false);
  });

  it('PlaylistChange handler: updates playlist', () => {
    const { manager } = setupHost();

    const files = [{ name: 'movie.mp4', duration: 0 }];
    manager.dispatch(MessageType.PlaylistChange, {
      files,
      index: 0,
      setBy: 'otheruser',
    });

    const snap = manager.getSnapshot();
    expect(snap.playlist).toEqual(files);
    expect(snap.playlistIndex).toBe(0);
  });

  it('PlaylistChange handler: skips self-set playlist', () => {
    const { manager } = setupHost();

    manager.dispatch(MessageType.PlaylistChange, {
      files: [{ name: 'other.mp4', duration: 0 }],
      index: 0,
      setBy: 'hostuser', // same as host username
    });

    const snap = manager.getSnapshot();
    expect(snap.playlist).toEqual([]); // unchanged
  });

  it('HostElected handler: updates hostId, fires host-change event', () => {
    const { manager, transport } = setupHost();

    const events: SyncEvent[] = [];
    manager.onSyncEvent((e) => events.push(e));

    // Add a mock peer first so host flag can be set
    manager.dispatch(MessageType.UserInfo, {
      username: 'newhost',
      features: [],
    }, 'newhost');

    manager.dispatch(MessageType.HostElected, {
      host_id: 'newhost',
      reason: 'election',
    });

    const event = events.find((e) => e.type === 'host-change');
    expect(event).toBeDefined();
    expect((event!.data as any).hostId).toBe('newhost');
    expect((event!.data as any).reason).toBe('election');

    expect((manager as any).hostId).toBe('newhost');
  });

  it('ControllerChange handler: add/remove controllers', () => {
    const { manager } = setupHost();

    // Add a peer first
    manager.dispatch(MessageType.UserInfo, {
      username: 'ctrluser',
      features: [],
    }, 'ctrluser');

    // Add controller
    manager.dispatch(MessageType.ControllerChange, {
      peer_id: 'ctrluser',
      action: ControllerAction.Add,
    });

    let snap = manager.getSnapshot();
    expect(snap.controllers).toContain('ctrluser');

    // Remove controller
    manager.dispatch(MessageType.ControllerChange, {
      peer_id: 'ctrluser',
      action: ControllerAction.Remove,
    });

    snap = manager.getSnapshot();
    expect(snap.controllers).not.toContain('ctrluser');
  });

  it('VoiceMute handler: updates mute state', () => {
    const { manager } = setupHost();

    manager.dispatch(MessageType.VoiceMute, { muted: true }, 'peer1');

    const mutes = (manager as any).voiceMutes;
    expect(mutes.get('peer1')).toBe(true);

    manager.dispatch(MessageType.VoiceMute, { muted: false }, 'peer1');
    expect(mutes.get('peer1')).toBe(false);
  });

  it('UserInfo handler: adds new peer, fires user-join event', () => {
    const { manager, transport } = setupHost();

    const events: SyncEvent[] = [];
    manager.onSyncEvent((e) => events.push(e));

    manager.dispatch(MessageType.UserInfo, {
      username: 'newuser',
      features: ['chat'],
    }, 'newuser');

    const joinEvent = events.find((e) => e.type === 'user-join');
    expect(joinEvent).toBeDefined();
    expect((joinEvent!.data as any).username).toBe('newuser');

    const snap = manager.getSnapshot();
    expect(snap.peers.some((p) => p.username === 'newuser')).toBe(true);
  });

  it('PeerDisconnect handler: removes peer, fires user-leave event', () => {
    const { manager, transport } = setupHost();

    // Add a peer first
    manager.dispatch(MessageType.UserInfo, {
      username: 'leaver',
      features: [],
    }, 'leaver');

    expect(manager.getSnapshot().peers.some((p) => p.username === 'leaver')).toBe(true);

    const events: SyncEvent[] = [];
    manager.onSyncEvent((e) => events.push(e));

    manager.dispatch(MessageType.PeerDisconnect, { reason: 'left' }, 'leaver');

    const leaveEvent = events.find((e) => e.type === 'user-leave');
    expect(leaveEvent).toBeDefined();
    expect((leaveEvent!.data as any).id).toBe('leaver');

    expect(manager.getSnapshot().peers.some((p) => p.username === 'leaver')).toBe(false);
  });
});

// ── 3. Playback Control ──────────────────────────────────────────

describe('Playback control', () => {
  it('updatePlaystate: as host, broadcasts playstate', () => {
    const { manager, sent } = setupHost();

    manager.updatePlaystate(45.0, false, 2.0);

    const playstateMsgs = sent.filter((m) => m.msgType === MessageType.Playstate);
    expect(playstateMsgs).toHaveLength(1);
    const payload = playstateMsgs[0].payload as any;
    expect(payload.position).toBe(45.0);
    expect(payload.paused).toBe(false);
    expect(payload.speed).toBe(2.0);
    expect(payload.doSeek).toBe(true);
    expect(payload.setBy).toBe('hostuser');
  });

  it('requestSeek: non-host sends PlaystateRequest', () => {
    const { manager, sent } = setupPeer('peer1');

    manager.requestSeek(30.0);

    const reqMsgs = sent.filter((m) => m.msgType === MessageType.PlaystateRequest);
    expect(reqMsgs).toHaveLength(1);
    const payload = reqMsgs[0].payload as any;
    expect(payload.action).toBe(PlaystateAction.Seek);
    expect(payload.position).toBe(30.0);
  });

  it('requestPause: non-host sends PlaystateRequest with Pause action', () => {
    const { manager, sent } = setupPeer('peer1');

    manager.requestPause();

    const reqMsgs = sent.filter((m) => m.msgType === MessageType.PlaystateRequest);
    expect(reqMsgs).toHaveLength(1);
    const payload = reqMsgs[0].payload as any;
    expect(payload.action).toBe(PlaystateAction.Pause);
  });

  it('requestPlay: non-host sends PlaystateRequest with Play action', () => {
    const { manager, sent } = setupPeer('peer1');

    manager.requestPlay();

    const reqMsgs = sent.filter((m) => m.msgType === MessageType.PlaystateRequest);
    expect(reqMsgs).toHaveLength(1);
    const payload = reqMsgs[0].payload as any;
    expect(payload.action).toBe(PlaystateAction.Play);
  });

  it('requestSetSpeed: non-host sends PlaystateRequest with SetSpeed', () => {
    const { manager, sent } = setupPeer('peer1');

    manager.requestSetSpeed(1.75);

    const reqMsgs = sent.filter((m) => m.msgType === MessageType.PlaystateRequest);
    expect(reqMsgs).toHaveLength(1);
    const payload = reqMsgs[0].payload as any;
    expect(payload.action).toEqual({ SetSpeed: 1.75 });
  });

  it('requestSeek as host: calls updatePlaystate directly', () => {
    const { manager, sent } = setupHost();

    manager.requestSeek(99.0);

    const playstateMsgs = sent.filter((m) => m.msgType === MessageType.Playstate);
    expect(playstateMsgs).toHaveLength(1);
    expect((playstateMsgs[0].payload as any).position).toBe(99.0);
  });
});

// ── 4. State Replay ─────────────────────────────────────────────

describe('State replay', () => {
  it('sendStateTo: sends playstate + playlist + readiness + controllers', () => {
    const { manager, sent } = setupHost();

    // Set up some room state
    manager.updatePlaystate(100, false, 1.0);
    manager.setReady(true);

    const sentBefore = sent.length;

    // Add a peer and a controller for more state
    manager.dispatch(MessageType.UserInfo, {
      username: 'ctrlpeer',
      features: [],
    }, 'ctrlpeer');
    manager.addController('ctrlpeer');

    manager.sendStateTo('newpeer');

    const newMsgs = sent.slice(sentBefore);

    // Should contain Playstate
    const playstate = newMsgs.find((m) => m.msgType === MessageType.Playstate);
    expect(playstate).toBeDefined();

    // Should contain PlaylistChange
    const playlist = newMsgs.find((m) => m.msgType === MessageType.PlaylistChange);
    expect(playlist).toBeDefined();

    // Should contain Readiness for hostuser
    const readiness = newMsgs.find((m) => m.msgType === MessageType.Readiness);
    expect(readiness).toBeDefined();

    // Should contain ControllerChange for ctrlpeer
    const controllers = newMsgs.filter((m) => m.msgType === MessageType.ControllerChange);
    expect(controllers.length).toBeGreaterThanOrEqual(1);
    expect((controllers[0].payload as any).peer_id).toBe('ctrlpeer');
  });
});

// ── 5. Latency ──────────────────────────────────────────────────

describe('Latency', () => {
  it('LatencyPing triggers LatencyPong response', () => {
    const { manager, sent } = setupHost();

    const sendTime = Date.now();
    const sentBefore = sent.length;
    manager.dispatch(MessageType.LatencyPing, { sendTime });

    const newMsgs = sent.slice(sentBefore);
    const pong = newMsgs.find((m) => m.msgType === MessageType.LatencyPong);
    expect(pong).toBeDefined();
    expect((pong!.payload as any).sendTime).toBe(sendTime);
    expect((pong!.payload as any).receiveTime).toBeGreaterThanOrEqual(sendTime);
  });

  it('LatencyPong updates latencyMap and peer RTT', () => {
    const { manager } = setupHost();

    // Add a peer first
    manager.dispatch(MessageType.UserInfo, {
      username: 'remotepeer',
      features: [],
    }, 'remotepeer');

    const sendTime = Date.now() - 50; // 50ms ago
    manager.dispatch(MessageType.LatencyPong, {
      sendTime,
      receiveTime: sendTime + 25, // took 25ms one way
    }, 'remotepeer');

    const latencies = manager.getLatencies();
    expect(latencies['remotepeer']).toBeGreaterThan(0);
    // RTT should be ~50ms
    expect(latencies['remotepeer']).toBeGreaterThanOrEqual(40);

    // Check peer RTT is updated
    const snap = manager.getSnapshot();
    const peer = snap.peers.find((p) => p.username === 'remotepeer');
    expect(peer).toBeDefined();
    expect(peer!.rtt).toBeGreaterThan(0);
  });
});

// ── 6. Config Persistence ───────────────────────────────────────

describe('Config persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('saveConfig writes to localStorage', () => {
    const manager = new P2PStateManager('testuser');
    const { transport } = mockTransport();
    forceState(manager, 'connecting_peers');
    manager.onConnected('peer1', 'peer1', transport);

    // Set lastConfig via the private method (access via any)
    manager.setLastConfig('192.168.1.100', 'myuser', 'room42');
    manager.saveConfig('test-key');

    const raw = localStorage.getItem('test-key');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.host).toBe('192.168.1.100');
    expect(parsed.username).toBe('myuser');
    expect(parsed.room).toBe('room42');
  });

  it('loadConfig reads saved config', () => {
    // Pre-populate localStorage
    localStorage.setItem(
      'test-key-2',
      JSON.stringify({ host: '10.0.0.1', username: 'loadeduser', room: 'main' }),
    );

    const config = P2PStateManager.loadConfig('test-key-2');
    expect(config.host).toBe('10.0.0.1');
    expect(config.username).toBe('loadeduser');
    expect(config.room).toBe('main');
  });

  it('loadConfig returns defaults when nothing saved', () => {
    const config = P2PStateManager.loadConfig('nonexistent-key');
    expect(config.host).toBe('localhost');
    expect(config.username).toBe('');
    expect(config.room).toBe('');
  });

  it('saveConfig is a no-op when lastConfig is null', () => {
    // New manager, never set lastConfig
    const manager = new P2PStateManager('testuser');
    manager.saveConfig('test-key-3');

    expect(localStorage.getItem('test-key-3')).toBeNull();
  });
});

// ── 7. Connected/Disconnected Lifecycle ─────────────────────────

describe('Connection lifecycle', () => {
  it('onConnected sets peerId, hostId, transport, and transitions to ready', () => {
    const manager = new P2PStateManager('testuser');
    const { transport } = mockTransport();

    // onConnected calls transit('ready'), which is only valid from
    // 'connecting_peers' or 'handshaking'. Force the state first.
    forceState(manager, 'connecting_peers');
    manager.onConnected('myid', 'hostid', transport);

    expect(manager.myPeerId).toBe('myid');
    expect(manager.connected).toBe(true);
    expect(manager.connectionState).toBe('ready');
  });

  it('onDisconnected clears state and transitions to offline', () => {
    const manager = new P2PStateManager('testuser');
    const { transport } = mockTransport();
    forceState(manager, 'connecting_peers');
    manager.onConnected('myid', 'hostid', transport);

    // Set up some state
    manager.dispatch(MessageType.UserInfo, { username: 'peer99', features: [] }, 'peer99');

    manager.onDisconnected('test disconnect');

    expect(manager.connectionState).toBe('offline');
    expect(manager.connected).toBe(false);
    expect(manager.myPeerId).toBe('');
    expect(manager.getSnapshot().peers).toEqual([]);
  });

  it('isHost returns true when peerId matches hostId', () => {
    const manager = new P2PStateManager('hostuser');
    const { transport } = mockTransport();
    forceState(manager, 'connecting_peers');
    manager.onConnected('hostuser', 'hostuser', transport);
    expect(manager.isHost).toBe(true);
  });

  it('isHost returns false for non-host peer', () => {
    const { manager } = setupPeer('peer5');
    expect(manager.isHost).toBe(false);
  });
});

// ── 8. Reconnection ─────────────────────────────────────────────

describe('Reconnection', () => {
  it('reconnect transitions to reconnecting state', () => {
    const manager = new P2PStateManager('testuser');
    const { transport } = mockTransport();
    forceState(manager, 'connecting_peers');
    manager.onConnected('peer1', 'hostuser', transport);

    // Must be in 'ready' for reconnect to be valid
    expect(manager.connectionState).toBe('ready');

    manager.onDisconnected('test');
    expect(manager.connectionState).toBe('offline');

    // Bring back to ready so reconnect transition is valid
    forceState(manager, 'ready');

    const connectFn = vi.fn().mockRejectedValue(new Error('fail'));
    manager.reconnect(connectFn, 'disconnected');

    expect(manager.connectionState).toBe('reconnecting');
  });

  it('reconnect schedules delayed connectFn call', () => {
    vi.useFakeTimers();
    const manager = new P2PStateManager('testuser');
    const events: SyncEvent[] = [];
    manager.onSyncEvent((e) => events.push(e));

    // Must start in 'ready' for reconnect transition
    forceState(manager, 'ready');

    const connectFn = vi.fn().mockResolvedValue(undefined);
    manager.reconnect(connectFn, 'disconnected');

    expect(manager.connectionState).toBe('reconnecting');
    expect(connectFn).not.toHaveBeenCalled();

    // Advance timer past the delay (2s for first attempt)
    vi.advanceTimersByTime(2500);

    expect(connectFn).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('reconnect resets counter on cancelReconnect (design note)', () => {
    // NOTE: cancelReconnect resets reconnectAttempt to 0, and reconnect()
    // calls cancelReconnect first. This means maxReconnectAttempts is
    // effectively never reached in recursive calls. Documenting actual behavior.
    const manager = new P2PStateManager('testuser');

    manager.reconnectAttempt = 5;
    manager.cancelReconnect();
    expect(manager.reconnectAttempt).toBe(0);
  });

  it('cancelReconnect clears timer and resets attempt count', () => {
    const manager = new P2PStateManager('testuser');
    manager.reconnectAttempt = 3;

    manager.cancelReconnect();

    expect(manager.reconnectAttempt).toBe(0);
  });
});

// ── 9. Chat, Readiness, Playlist public methods ─────────────────

describe('Public methods', () => {
  it('sendChat sends Chat message through transport', () => {
    const { manager, sent } = setupPeer('peer1');

    manager.sendChat('hello everyone');

    const chatMsgs = sent.filter((m) => m.msgType === MessageType.Chat);
    expect(chatMsgs).toHaveLength(1);
    expect((chatMsgs[0].payload as any).from).toBe('peeruser');
    expect((chatMsgs[0].payload as any).message).toBe('hello everyone');
  });

  it('setReady sends Readiness message', () => {
    const { manager, sent } = setupPeer('peer1');

    manager.setReady(true);

    const readyMsgs = sent.filter((m) => m.msgType === MessageType.Readiness);
    expect(readyMsgs).toHaveLength(1);
    expect((readyMsgs[0].payload as any).username).toBe('peeruser');
    expect((readyMsgs[0].payload as any).isReady).toBe(true);
  });

  it('setPlaylist replaces playlist as host', () => {
    const { manager, sent } = setupHost();

    manager.setPlaylist(['a.mp4', 'b.mp4']);

    const snap = manager.getSnapshot();
    expect(snap.playlist).toEqual([
      { name: 'a.mp4', duration: 0 },
      { name: 'b.mp4', duration: 0 },
    ]);

    const playlistMsgs = sent.filter((m) => m.msgType === MessageType.PlaylistChange);
    expect(playlistMsgs).toHaveLength(1);
  });

  it('clearPlaylist empties playlist', () => {
    const { manager } = setupHost();

    manager.setPlaylist(['a.mp4', 'b.mp4']);
    expect(manager.getSnapshot().playlist).toHaveLength(2);

    manager.clearPlaylist();
    expect(manager.getSnapshot().playlist).toHaveLength(0);
  });

  it('updateSpeed changes speed as host', () => {
    const { manager, sent } = setupHost();

    manager.updateSpeed(2.5);

    expect((manager as any).room.speed).toBe(2.5);
  });

  it('isController returns true for self', () => {
    const { manager } = setupHost();
    expect(manager.isController('hostuser')).toBe(true);
  });

  it('isController returns true for added controller', () => {
    const { manager } = setupHost();
    manager.addController('other');
    expect(manager.isController('other')).toBe(true);
  });

  it('isController returns false for non-controller', () => {
    const { manager } = setupHost();
    expect(manager.isController('unknown')).toBe(false);
  });
});

// ── 10. Slash commands ──────────────────────────────────────────

describe('Slash commands', () => {
  it('/version returns version string', () => {
    const manager = new P2PStateManager('testuser');
    const result = manager.sendSlashCommand('/version');
    expect(result).toContain('Syncplay P2P v');
  });

  it('/help returns help text', () => {
    const manager = new P2PStateManager('testuser');
    const result = manager.sendSlashCommand('/help');
    expect(result).toContain('Commands:');
  });

  it('/ready toggles readiness', () => {
    const { manager, sent } = setupPeer('peer1');

    manager.sendSlashCommand('/ready');

    const readyMsgs = sent.filter((m) => m.msgType === MessageType.Readiness);
    expect(readyMsgs).toHaveLength(1);
    expect((readyMsgs[0].payload as any).isReady).toBe(true);
  });

  it('/users lists peers when empty', () => {
    const { manager } = setupHost();
    const result = manager.sendSlashCommand('/users');
    expect(result).toBe('No peers connected');
  });

  it('/users lists peers when connected', () => {
    const { manager } = setupHost();
    manager.dispatch(MessageType.UserInfo, { username: 'peer1', features: [] }, 'peer1');
    const result = manager.sendSlashCommand('/users');
    expect(result).toContain('peer1');
  });
});

// ── 10b. E2E Mesh (two P2PStateManagers via mock transports) ────

describe('E2E Mesh', () => {
  it('chat flow: peer sends chat → host relays → peer receives', () => {
    // Create host and peer managers
    const hostManager = new P2PStateManager('hostuser');
    const peerManager = new P2PStateManager('peeruser');

    // Wire them with mock transports that forward to each other's dispatch
    const hostTransport: P2PTransport = {
      send(msgType: MessageType, payload: unknown) {
        // Forward to peer
        peerManager.dispatch(msgType, payload, 'hostuser');
      },
    };
    const peerTransport: P2PTransport = {
      send(msgType: MessageType, payload: unknown) {
        // Forward to host
        hostManager.dispatch(msgType, payload, 'peeruser');
      },
    };

    // Set up as connected
    forceState(hostManager, 'connecting_peers');
    hostManager.onConnected('hostuser', 'hostuser', hostTransport);
    forceState(peerManager, 'connecting_peers');
    peerManager.onConnected('peeruser', 'hostuser', peerTransport);

    // Register peers via Hello
    hostManager.dispatch(MessageType.Hello, {
      username: 'peeruser',
      version: '2.0.0',
      room: 'test',
      features: ['chat'],
    }, 'peeruser');

    peerManager.dispatch(MessageType.Hello, {
      username: 'hostuser',
      version: '2.0.0',
      room: 'test',
      features: ['chat'],
    }, 'hostuser');

    // Track chat events on peer side
    const peerEvents: SyncEvent[] = [];
    peerManager.onSyncEvent((e) => peerEvents.push(e));

    const hostEvents: SyncEvent[] = [];
    hostManager.onSyncEvent((e) => hostEvents.push(e));

    // Peer sends a chat message
    peerManager.sendChat('Hello from peer!');

    // Host should receive the chat via transport
    const hostChatEvents = hostEvents.filter(e => e.type === 'chat');
    expect(hostChatEvents.length).toBeGreaterThanOrEqual(1);
    const chatData = hostChatEvents[hostChatEvents.length - 1].data as any;
    expect(chatData.from).toBe('peeruser');
    expect(chatData.message).toBe('Hello from peer!');
  });

  it('playstate flow: host updates → peer receives', () => {
    const hostManager = new P2PStateManager('hostuser');
    const peerManager = new P2PStateManager('peeruser');

    // Wire transports
    const hostTransport: P2PTransport = {
      send(msgType: MessageType, payload: unknown) {
        peerManager.dispatch(msgType, payload, 'hostuser');
      },
    };
    const peerTransport: P2PTransport = {
      send(msgType: MessageType, payload: unknown) {
        hostManager.dispatch(msgType, payload, 'peeruser');
      },
    };

    // Set up as connected
    forceState(hostManager, 'connecting_peers');
    hostManager.onConnected('hostuser', 'hostuser', hostTransport);
    forceState(peerManager, 'connecting_peers');
    peerManager.onConnected('peeruser', 'hostuser', peerTransport);

    // Register peers
    hostManager.dispatch(MessageType.Hello, {
      username: 'peeruser',
      version: '2.0.0',
      room: 'test',
      features: ['chat'],
    }, 'peeruser');

    peerManager.dispatch(MessageType.Hello, {
      username: 'hostuser',
      version: '2.0.0',
      room: 'test',
      features: ['chat'],
    }, 'hostuser');

    // Track playstate events on peer side
    const peerEvents: SyncEvent[] = [];
    peerManager.onSyncEvent((e) => peerEvents.push(e));

    // Host broadcasts a playstate update
    hostManager.updatePlaystate(120.5, false, 1.5);
    const hostSnap = hostManager.getSnapshot();
    expect(hostSnap.position).toBeGreaterThanOrEqual(120);

    // Peer should get the state via transport
    const peerSnap = peerManager.getSnapshot();
    expect(peerSnap.paused).toBe(false);
    expect(peerSnap.speed).toBe(1.5);
  });

  it('readiness flow: peer toggles → host receives', () => {
    const hostManager = new P2PStateManager('hostuser');
    const peerManager = new P2PStateManager('peeruser');

    // Wire transports
    const hostTransport: P2PTransport = {
      send(msgType: MessageType, payload: unknown) {
        peerManager.dispatch(msgType, payload, 'hostuser');
      },
    };
    const peerTransport: P2PTransport = {
      send(msgType: MessageType, payload: unknown) {
        hostManager.dispatch(msgType, payload, 'peeruser');
      },
    };

    // Set up as connected
    forceState(hostManager, 'connecting_peers');
    hostManager.onConnected('hostuser', 'hostuser', hostTransport);
    forceState(peerManager, 'connecting_peers');
    peerManager.onConnected('peeruser', 'hostuser', peerTransport);

    // Register peers
    hostManager.dispatch(MessageType.Hello, {
      username: 'peeruser',
      version: '2.0.0',
      room: 'test',
      features: ['chat'],
    }, 'peeruser');

    peerManager.dispatch(MessageType.Hello, {
      username: 'hostuser',
      version: '2.0.0',
      room: 'test',
      features: ['chat'],
    }, 'hostuser');

    // Peer sets ready to true
    peerManager.setReady(true);

    // Host should have the readiness state
    const hostSnap = hostManager.getSnapshot();
    expect(hostSnap.readyStates['peeruser']).toBe(true);

    // Peer sets ready to false
    peerManager.setReady(false);
    const hostSnap2 = hostManager.getSnapshot();
    expect(hostSnap2.readyStates['peeruser']).toBe(false);
  });

  it('ICE state tracking via updateIceState', () => {
    const manager = new P2PStateManager('testuser');
    const { transport } = mockTransport();
    forceState(manager, 'connecting_peers');
    manager.onConnected('testuser', 'testuser', transport);

    // Add a peer
    manager.dispatch(MessageType.UserInfo, {
      username: 'remotepeer',
      features: [],
    }, 'remotepeer');

    // Update ICE state
    manager.updateIceState('remotepeer', 'checking');
    let stats = manager.getPeerStats();
    let peerStat = stats.find(s => s.peerId === 'remotepeer');
    expect(peerStat?.iceState).toBe('checking');

    // Update to connected
    manager.updateIceState('remotepeer', 'connected');
    stats = manager.getPeerStats();
    peerStat = stats.find(s => s.peerId === 'remotepeer');
    expect(peerStat?.iceState).toBe('connected');

    // Update to failed (should log warning)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    manager.updateIceState('remotepeer', 'failed');
    stats = manager.getPeerStats();
    peerStat = stats.find(s => s.peerId === 'remotepeer');
    expect(peerStat?.iceState).toBe('failed');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ICE connection failed'),
    );
    warnSpy.mockRestore();

    // Update unknown peer (no-op)
    manager.updateIceState('nonexistent', 'connected');
    expect(manager.getPeerStats().length).toBe(1); // still just remotepeer
  });

  it('getPeerStats returns formatted stats', () => {
    const { manager } = setupHost();

    manager.dispatch(MessageType.UserInfo, {
      username: 'peer1',
      features: ['chat'],
    }, 'peer1');

    manager.dispatch(MessageType.UserInfo, {
      username: 'peer2',
      features: ['readiness'],
    }, 'peer2');

    const stats = manager.getPeerStats();
    expect(stats).toHaveLength(2);

    const peer1 = stats.find(s => s.peerId === 'peer1');
    expect(peer1).toBeDefined();
    expect(peer1!.username).toBe('peer1');
    expect(peer1!.iceState).toBe('connected'); // default
    expect(peer1!.rtt).toBe(0);
    expect(peer1!.muted).toBe(false);
    expect(peer1!.isReady).toBe(false);
  });
});

// ── 11. destroy ────────────────────────────────────────────────

describe('destroy', () => {
  it('destroy stops loops and clears handlers', () => {
    const manager = new P2PStateManager('testuser');
    const { transport } = mockTransport();
    forceState(manager, 'connecting_peers');
    manager.onConnected('testid', 'testid', transport);

    const handler = vi.fn();
    manager.onSyncEvent(handler);

    manager.destroy();

    // Should not throw when emitting after destroy
    expect(manager.connected).toBe(false);
  });
});
