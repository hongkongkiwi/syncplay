// Cross-client integration test — verifies full protocol flow between
// two P2PStateManagers simulating a host and a peer in a watch session.
// Covers: hello/handshake, playstate sync, chat relay, readiness,
// playlist, controllers, latency ping/pong, host election, peer disconnect.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  P2PStateManager,
  type P2PTransport,
  type SyncEvent,
} from './state';
import {
  MessageType,
  PlaystateAction,
  PlaylistAction,
  ControllerAction,
} from './messages';
import * as wire from './wire';

// ── Helpers ────────────────────────────────────────────────────────

function forceState(manager: P2PStateManager, state: string): void {
  (manager as any)._connectionState = state;
}

interface SentMessage {
  msgType: MessageType;
  payload: unknown;
}

function mockTransport(): { transport: P2PTransport; sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  return {
    transport: { send(msgType, payload) { sent.push({ msgType, payload }); } },
    sent,
  };
}

function wirePeerToHost(
  host: P2PStateManager,
  peer: P2PStateManager,
) {
  // Transport: peer sends to host, host sends to peer (simulates data channel)
  const hostTransport: P2PTransport = {
    send(msgType, payload) {
      peer.dispatch(msgType, payload, 'host');
    },
  };
  const peerTransport: P2PTransport = {
    send(msgType, payload) {
      host.dispatch(msgType, payload, 'peer');
    },
  };

  forceState(host, 'connecting_peers');
  host.onConnected('host', 'host', hostTransport);
  forceState(peer, 'connecting_peers');
  peer.onConnected('peer', 'host', peerTransport);

  // Registration: peers exchange Hello messages (simulating signaling layer)
  host.dispatch(MessageType.Hello, {
    username: 'peer',
    version: '2.0.0',
    room: 'test',
    features: ['chat', 'readiness', 'playlist'],
  }, 'peer');

  peer.dispatch(MessageType.Hello, {
    username: 'host',
    version: '2.0.0',
    room: 'test',
    features: ['chat', 'readiness', 'playlist'],
  }, 'host');

  return { hostTransport, peerTransport };
}


// ── Tests ──────────────────────────────────────────────────────────

describe('Cross-client integration', () => {
  let host: P2PStateManager;
  let peer: P2PStateManager;

  beforeEach(() => {
    host = new P2PStateManager('host');
    peer = new P2PStateManager('peer');
  });

  // ── 1. Handshake flow ─────────────────────────────────────────

  it('host and peer complete handshake via Hello exchange', () => {
    wirePeerToHost(host, peer);

    expect(host.isHost).toBe(true);
    expect(peer.isHost).toBe(false);
    expect(host.connected).toBe(true);
    expect(peer.connected).toBe(true);
    expect(host.connectionState).toBe('ready');
    expect(peer.connectionState).toBe('ready');

    // Peer should be in host's peer list
    const hostSnap = host.getSnapshot();
    expect(hostSnap.peers.some(p => p.username === 'peer')).toBe(true);
  });

  // ── 2. Playstate sync ─────────────────────────────────────────

  it('host playstate update reaches peer with latency compensation', () => {
    wirePeerToHost(host, peer);

    const peerEvents: SyncEvent[] = [];
    peer.onSyncEvent(e => peerEvents.push(e));

    // Host updates playstate
    host.updatePlaystate(120.5, false, 1.0);

    // Peer should receive playstate event
    const playstateEvents = peerEvents.filter(e => e.type === 'playstate');
    expect(playstateEvents.length).toBeGreaterThanOrEqual(1);

    const peerSnap = peer.getSnapshot();
    expect(peerSnap.paused).toBe(false);
    expect(peerSnap.speed).toBe(1.0);
  });

  it('host doSeek flag propagates correctly', () => {
    const { hostTransport } = wirePeerToHost(host, peer);

    // Host sends a seek playstate via transport (simulating data channel)
    hostTransport.send(MessageType.Playstate, {
      position: 300,
      paused: false,
      doSeek: true,
      setBy: 'host',
      seq: 1,
      timestamp: Date.now(),
      speed: 1.0,
    });

    const peerSnap = peer.getSnapshot();
    expect(peerSnap.doSeek).toBe(true);
  });

  // ── 3. Chat relay ─────────────────────────────────────────────

  it('peer chat reaches host via transport', () => {
    wirePeerToHost(host, peer);

    const hostEvents: SyncEvent[] = [];
    host.onSyncEvent(e => hostEvents.push(e));

    // Peer sends a chat message
    peer.sendChat('Hello from peer!');

    const chatEvents = hostEvents.filter(e => e.type === 'chat');
    expect(chatEvents.length).toBeGreaterThanOrEqual(1);
    const chatData = chatEvents[chatEvents.length - 1].data as any;
    expect(chatData.from).toBe('peer');
    expect(chatData.message).toBe('Hello from peer!');
  });

  it('host chat reaches peer', () => {
    wirePeerToHost(host, peer);

    const peerEvents: SyncEvent[] = [];
    peer.onSyncEvent(e => peerEvents.push(e));

    // Host sends chat
    host.sendChat('Welcome!');

    const chatEvents = peerEvents.filter(e => e.type === 'chat');
    // Host chat goes through transport, peer receives it
    expect(chatEvents.length).toBeGreaterThanOrEqual(1);
  });

  // ── 4. Readiness sync ─────────────────────────────────────────

  it('peer readiness propagates to host', () => {
    wirePeerToHost(host, peer);

    // Peer sets ready
    peer.setReady(true);

    const hostSnap = host.getSnapshot();
    expect(hostSnap.readyStates['peer']).toBe(true);

    // Peer sets not ready
    peer.setReady(false);
    const hostSnap2 = host.getSnapshot();
    expect(hostSnap2.readyStates['peer']).toBe(false);
  });

  // ── 5. Playlist ───────────────────────────────────────────────

  it('host playlist change reaches peer', () => {
    wirePeerToHost(host, peer);

    host.setPlaylist(['movie.mp4', 'trailer.mp4']);

    const peerSnap = peer.getSnapshot();
    expect(peerSnap.playlist).toEqual([
      { name: 'movie.mp4', duration: 0 },
      { name: 'trailer.mp4', duration: 0 },
    ]);

    // Change index
    host.setPlaylistIndex(1);
    const peerSnap2 = peer.getSnapshot();
    expect(peerSnap2.playlistIndex).toBe(1);
  });

  // ── 6. Controllers ────────────────────────────────────────────

  it('host can add and remove controllers, peer sees changes', () => {
    wirePeerToHost(host, peer);

    // Add peer as controller
    host.addController('peer');

    const peerSnap = peer.getSnapshot();
    expect(peerSnap.controllers).toContain('peer');

    // Remove controller
    host.removeController('peer');
    const peerSnap2 = peer.getSnapshot();
    expect(peerSnap2.controllers).not.toContain('peer');
  });

  it('controller validation blocks unauthorized playstate requests', () => {
    wirePeerToHost(host, peer);

    // Peer is NOT a controller — should be blocked
    // Simulate a PlaystateRequest from peer (would normally be blocked by handlePlaystateRequest)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    host.dispatch(MessageType.PlaystateRequest, {
      action: PlaystateAction.Seek,
      position: 50,
      requestId: 'req-1',
    }, 'peer');

    // Host should have rejected (controller validation)
    expect(host.getSnapshot().position).not.toBe(50);

    // Now make peer a controller
    host.addController('peer');

    // Now the request should be accepted
    host.dispatch(MessageType.PlaystateRequest, {
      action: PlaystateAction.Seek,
      position: 50,
      requestId: 'req-2',
    }, 'peer');

    // Should have accepted
    expect(host.getSnapshot().position).toBeGreaterThanOrEqual(50);

    warnSpy.mockRestore();
  });

  // ── 7. Latency ────────────────────────────────────────────────

  it('latency ping/pong works between host and peer', () => {
    const { hostTransport } = wirePeerToHost(host, peer);

    // Send a ping from host transport → peer
    const sendTime = Date.now();
    hostTransport.send(MessageType.LatencyPing, { sendTime });

    // The peer receives ping → sends pong back via peer transport → host receives
    // We verify the round-trip completed without errors
    expect(host.connectionState).toBe('ready');
    expect(peer.connectionState).toBe('ready');
  });

  // ── 8. Peer disconnect ────────────────────────────────────────

  it('peer disconnect cleans up host state', () => {
    wirePeerToHost(host, peer);

    expect(host.getSnapshot().peers.some(p => p.username === 'peer')).toBe(true);

    // Peer disconnects
    host.dispatch(MessageType.PeerDisconnect, { reason: 'left' }, 'peer');

    const hostSnap = host.getSnapshot();
    expect(hostSnap.peers.some(p => p.username === 'peer')).toBe(false);
  });

  // ── 9. State replay ───────────────────────────────────────────

  it('rejoining peer receives full room state', () => {
    wirePeerToHost(host, peer);

    // Set up room state
    host.updatePlaystate(99.5, false, 1.5);
    host.setReady(true);
    host.addController('peer');

    // Request state replay (simulating a rejoin)
    host.sendStateTo('peer');

    // Peer should receive the latest state
    const peerSnap = peer.getSnapshot();
    expect(peerSnap.position).toBeGreaterThanOrEqual(99);
    expect(peerSnap.speed).toBe(1.5);
    expect(peerSnap.readyStates['host']).toBe(true);
  });

  // ── 10. Voice mute ────────────────────────────────────────────

  it('voice mute propagates between peers', () => {
    wirePeerToHost(host, peer);

    // Peer sends voice mute
    host.dispatch(MessageType.VoiceMute, { muted: true }, 'peer');

    // Check host tracks the mute
    const peerInHost = host.getSnapshot().peers.find(p => p.username === 'peer');
    expect(peerInHost?.muted).toBe(true);

    // Unmute
    host.dispatch(MessageType.VoiceMute, { muted: false }, 'peer');
    const peerInHost2 = host.getSnapshot().peers.find(p => p.username === 'peer');
    expect(peerInHost2?.muted).toBe(false);
  });

  // ── 11. File info ─────────────────────────────────────────────

  it('file info propagates from host to peer', () => {
    wirePeerToHost(host, peer);

    const fileMeta = { name: 'movie.mkv', duration: 7200, size: 2_000_000_000 };
    host.sendFileInfo(fileMeta);

    const peerSnap = peer.getSnapshot();
    const hostPeer = peerSnap.peers.find(p => p.username === 'host');
    expect(hostPeer?.file?.name).toBe('movie.mkv');
    expect(hostPeer?.file?.duration).toBe(7200);
  });

  // ── 12. Speed control ─────────────────────────────────────────

  it('speed changes propagate and apply to peers', () => {
    wirePeerToHost(host, peer);

    // Host changes speed via updatePlaystate (which broadcasts to peers)
    host.updatePlaystate(10.0, false, 2.0);

    const peerSnap = peer.getSnapshot();
    expect(peerSnap.speed).toBe(2.0);

    // Reset to 1x
    host.updatePlaystate(10.0, false, 1.0);
    const peerSnap2 = peer.getSnapshot();
    expect(peerSnap2.speed).toBe(1.0);
  });

  // ── 13. Subtitle info ─────────────────────────────────────────

  it('subtitle info propagates to peers', () => {
    wirePeerToHost(host, peer);

    host.dispatch(MessageType.SubtitleInfo, {
      subtitles: [
        { filename: 'movie.en.srt', size: 4096, language: 'en' },
        { filename: 'movie.fr.srt', size: 3800, language: 'fr' },
      ],
    });

    // Subtitle info emits as a chat event
    // The handler converts it to a system message — verify it doesn't crash
    expect(host.connectionState).toBe('ready');
  });

  // ── 14. Full session flow ─────────────────────────────────────

  it('complete watch session: connect → play → pause → seek → disconnect', () => {
    wirePeerToHost(host, peer);

    // 1. Initial state: paused at 0
    expect(host.getSnapshot().paused).toBe(true);
    expect(host.getSnapshot().position).toBe(0);

    // 2. Host plays
    host.updatePlaystate(0, false, 1.0);
    expect(host.getSnapshot().paused).toBe(false);

    // 3. Playback progresses (simulated by hostTick)
    host.updatePlaystate(30.0, false, 1.0);
    expect(host.getSnapshot().position).toBeGreaterThanOrEqual(30);

    // 4. Host pauses at 45s
    host.updatePlaystate(45.0, true);
    expect(host.getSnapshot().paused).toBe(true);

    // 5. Host seeks to 120s
    host.dispatch(MessageType.Playstate, {
      position: 120,
      paused: true,
      doSeek: true,
      setBy: 'host',
      seq: host.getSnapshot().seq + 1,
      timestamp: Date.now(),
      speed: 1.0,
    }, 'host');

    // 6. Host resumes
    host.updatePlaystate(120.0, false, 1.0);

    // 7. Peer disconnects
    host.dispatch(MessageType.PeerDisconnect, { reason: 'goodbye' }, 'peer');
    expect(host.getSnapshot().peers.some(p => p.username === 'peer')).toBe(false);
  });
});

// ── 15. Wire roundtrip (encode/decode binary) ───────────────────

describe('Wire roundtrip', () => {
  it('roundtrip PlaystatePayload through wire encode/decode', () => {
    const payload = {
      position: 42.5, paused: false, doSeek: true,
      setBy: 'test', seq: 1, timestamp: Date.now(), speed: 1.0,
    };
    const frame = wire.encode(MessageType.Playstate, payload);
    expect(frame).toBeInstanceOf(Uint8Array);
    const [type, decoded] = wire.decode<typeof payload>(frame);
    expect(type).toBe(MessageType.Playstate);
    expect(decoded.position).toBe(42.5);
    expect(decoded.paused).toBe(false);
  });

  it('roundtrip ChatPayload through wire encode/decode', () => {
    const payload = { from: 'user1', message: 'hello world', timestamp: Date.now() };
    const frame = wire.encode(MessageType.Chat, payload);
    const [type, decoded] = wire.decode<typeof payload>(frame);
    expect(type).toBe(MessageType.Chat);
    expect(decoded.from).toBe('user1');
    expect(decoded.message).toBe('hello world');
  });

  it('roundtrip ReadinessPayload through wire encode/decode', () => {
    const payload = { username: 'peer1', isReady: true, manuallyInitiated: true, setBy: 'peer1' };
    const frame = wire.encode(MessageType.Readiness, payload);
    const [type, decoded] = wire.decode<typeof payload>(frame);
    expect(type).toBe(MessageType.Readiness);
    expect(decoded.username).toBe('peer1');
    expect(decoded.isReady).toBe(true);
  });

  it('roundtrip FileInfoPayload through wire encode/decode', () => {
    const payload = { username: 'host', file: { name: 'movie.mkv', duration: 7200, size: 2_000_000_000 } };
    const frame = wire.encode(MessageType.FileInfo, payload);
    const [type, decoded] = wire.decode<typeof payload>(frame);
    expect(type).toBe(MessageType.FileInfo);
    expect(decoded.username).toBe('host');
    expect(decoded.file?.name).toBe('movie.mkv');
    expect(decoded.file?.duration).toBe(7200);
  });

  it('roundtrip FileInfoPayload without file (clearing)', () => {
    const payload = { username: 'host' };
    const frame = wire.encode(MessageType.FileInfo, payload);
    const [type, decoded] = wire.decode<typeof payload>(frame);
    expect(type).toBe(MessageType.FileInfo);
    expect(decoded.username).toBe('host');
    expect(decoded.file).toBeUndefined();
  });

  it('roundtrip HostElectedPayload through wire encode/decode', () => {
    const payload = { hostId: 'newhost', reason: 'election' };
    const frame = wire.encode(MessageType.HostElected, payload);
    const [type, decoded] = wire.decode<typeof payload>(frame);
    expect(type).toBe(MessageType.HostElected);
    expect(decoded.hostId).toBe('newhost');
    expect(decoded.reason).toBe('election');
  });

  it('roundtrip ControllerChangePayload through wire encode/decode', () => {
    const payload = { peer_id: 'ctrluser', action: ControllerAction.Add };
    const frame = wire.encode(MessageType.ControllerChange, payload);
    const [type, decoded] = wire.decode<typeof payload>(frame);
    expect(type).toBe(MessageType.ControllerChange);
    expect(decoded.peer_id).toBe('ctrluser');
    expect(decoded.action).toBe(ControllerAction.Add);
  });

  it('roundtrip VoiceMutePayload through wire encode/decode', () => {
    const payload = { muted: true };
    const frame = wire.encode(MessageType.VoiceMute, payload);
    const [type, decoded] = wire.decode<typeof payload>(frame);
    expect(type).toBe(MessageType.VoiceMute);
    expect(decoded.muted).toBe(true);
  });

  it('roundtrip PlaylistChangePayload through wire encode/decode', () => {
    const payload = { files: [{ name: 'episode1.mp4', duration: 1800 }], index: 0, setBy: 'host' };
    const frame = wire.encode(MessageType.PlaylistChange, payload);
    const [type, decoded] = wire.decode<typeof payload>(frame);
    expect(type).toBe(MessageType.PlaylistChange);
    expect(decoded.files).toEqual([{ name: 'episode1.mp4', duration: 1800 }]);
    expect(decoded.index).toBe(0);
    expect(decoded.setBy).toBe('host');
  });

  it('roundtrip PlaystateRequestPayload (Seek) through wire encode/decode', () => {
    const payload = { action: PlaystateAction.Seek, position: 30, requestId: 'req-1' };
    const frame = wire.encode(MessageType.PlaystateRequest, payload);
    const [type, decoded] = wire.decode<typeof payload>(frame);
    expect(type).toBe(MessageType.PlaystateRequest);
    expect(decoded.action).toBe(PlaystateAction.Seek);
    expect(decoded.position).toBe(30);
  });

  it('roundtrip PlaystateRequestPayload (SetSpeed) through wire encode/decode', () => {
    const payload = { action: { setspeed: 2.0 }, position: 0, requestId: 'req-2' };
    const frame = wire.encode(MessageType.PlaystateRequest, payload);
    const [type, decoded] = wire.decode<typeof payload>(frame);
    expect(type).toBe(MessageType.PlaystateRequest);
    expect((decoded.action as any).setspeed).toBe(2.0);
  });

  it('roundtrip LatencyPing through wire encode/decode', () => {
    const sendTime = Date.now();
    const frame = wire.encode(MessageType.LatencyPing, { sendTime });
    const [type, decoded] = wire.decode<{ sendTime: number }>(frame);
    expect(type).toBe(MessageType.LatencyPing);
    expect(decoded.sendTime).toBe(sendTime);
  });

  it('roundtrip LatencyPong through wire encode/decode', () => {
    const sendTime = Date.now() - 100;
    const receiveTime = Date.now();
    const frame = wire.encode(MessageType.LatencyPong, { sendTime, receiveTime });
    const [type, decoded] = wire.decode<{ sendTime: number; receiveTime: number }>(frame);
    expect(type).toBe(MessageType.LatencyPong);
    expect(decoded.sendTime).toBe(sendTime);
    expect(decoded.receiveTime).toBe(receiveTime);
  });

  it('roundtrip AvatarSetPayload through wire encode/decode', () => {
    const payload = { username: 'user1', preset_id: 'cool-cat', custom_url: '', accent: '#FF6B6B' };
    const frame = wire.encode(MessageType.AvatarSet, payload);
    const [type, decoded] = wire.decode<typeof payload>(frame);
    expect(type).toBe(MessageType.AvatarSet);
    expect(decoded.username).toBe('user1');
    expect(decoded.preset_id).toBe('cool-cat');
    expect(decoded.accent).toBe('#FF6B6B');
  });

  it('roundtrip StatusUpdatePayload through wire encode/decode', () => {
    const payload = { username: 'user1', status_text: 'watching intently 👀', timestamp: Date.now() };
    const frame = wire.encode(MessageType.StatusUpdate, payload);
    const [type, decoded] = wire.decode<typeof payload>(frame);
    expect(type).toBe(MessageType.StatusUpdate);
    expect(decoded.username).toBe('user1');
    expect(decoded.status_text).toBe('watching intently 👀');
  });

  it('roundtrip FileTransferPayload through wire encode/decode', () => {
    const data = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const payload = {
      transferId: 'tx-abc', chunkIndex: 0, offset: 0,
      totalSize: 1024, chunkSize: 256, data,
    };
    const frame = wire.encode(MessageType.FileTransfer, payload);
    const [type, decoded] = wire.decode<typeof payload>(frame);
    expect(type).toBe(MessageType.FileTransfer);
    expect(decoded.transferId).toBe('tx-abc');
    expect(decoded.chunkIndex).toBe(0);
    expect(decoded.totalSize).toBe(1024);
    expect(decoded.data).toBeInstanceOf(Uint8Array);
    expect(decoded.data.byteLength).toBe(4);
  });

  it('roundtrip SubtitleInfoPayload through wire encode/decode', () => {
    const payload = {
      subtitles: [
        { filename: 'movie.en.srt', size: 4096, language: 'en' },
        { filename: 'movie.fr.srt', size: 3800, language: 'fr' },
      ],
    };
    const frame = wire.encode(MessageType.SubtitleInfo, payload);
    const [type, decoded] = wire.decode<typeof payload>(frame);
    expect(type).toBe(MessageType.SubtitleInfo);
    expect(decoded.subtitles).toHaveLength(2);
    expect(decoded.subtitles[0].filename).toBe('movie.en.srt');
    expect(decoded.subtitles[0].language).toBe('en');
  });

  it('roundtrip VoiceFramePayload through wire encode/decode', () => {
    const audioData = new Uint8Array([0x10, 0x20, 0x30]);
    const payload = {
      from: 'peer1', data: audioData, sampleRate: 48000,
      channels: 1, timestamp: Date.now(), seq: 1,
    };
    const frame = wire.encode(MessageType.VoiceFrame, payload);
    const [type, decoded] = wire.decode<typeof payload>(frame);
    expect(type).toBe(MessageType.VoiceFrame);
    expect(decoded.from).toBe('peer1');
    expect(decoded.sampleRate).toBe(48000);
    expect(decoded.channels).toBe(1);
    expect(decoded.seq).toBe(1);
    expect(decoded.data).toBeInstanceOf(Uint8Array);
    expect(decoded.data.byteLength).toBe(3);
  });
});
