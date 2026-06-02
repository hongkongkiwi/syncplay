// Syncplay P2P v2.0.0 — LAN Peer Discovery
//
// This module provides a PeerDiscovery class for discovering Syncplay peers
// on the local network. The primary mechanism is HTTP-based room listing via
// the signaling server's /rooms endpoint, with an mDNS fallback planned for
// future Node.js/Electron environments.
//
// ── Discovery Methods ────────────────────────────────────────────────
//
// 1. HTTP Room Listing (primary):
//    Query the signaling server's GET /rooms endpoint, which returns a JSON
//    array of active rooms with peer counts. The signaling server listens on
//    port 8998 and serves both WebSocket (ws://) and HTTP (http://).
//
//    Response shape: [{ "room": "movienight", "peers": 3, "hasPassword": false }]
//
// 2. mDNS (future fallback, RFC 6762):
//    Uses multicast UDP on 224.0.0.251:5353 to broadcast and discover
//    services. Each Syncplay peer would announce `_syncplay-p2p._tcp` on
//    port 8998 with TXT records for room/username. Requires `multicast-dns`
//    (Node.js) or `react-native-zeroconf` (React Native). Not available in
//    standard browser APIs.
//
// ── Platform Considerations ─────────────────────────────────────────
//
// - Browser / React Native: Use queryServerRooms() to hit the signaling server.
// - Node.js / Electron: Full mDNS support possible via `multicast-dns` npm.
//
// ── Usage ────────────────────────────────────────────────────────────
//
//   import { PeerDiscovery } from 'syncplay-p2p-client';
//
//   const discovery = new PeerDiscovery();
//   const rooms = await discovery.queryServerRooms('ws://192.168.1.5:8998');
//   // ... later ...
//   discovery.stopDiscovery();

/** Payload shape emitted when a Syncplay peer is discovered on LAN */
export interface DiscoveredPeer {
  /** IPv4 address of the peer (e.g., "192.168.1.42") */
  ip: string;
  /** Signaling server port the peer advertises */
  port: number;
  /** The peer's username */
  username: string;
  /** The room the peer is in */
  room: string;
  /** Protocol version the peer advertises */
  version?: string;
}

/** A room discovered via the signaling server's /rooms endpoint */
export interface DiscoveredRoom {
  /** Room name */
  room: string;
  /** Number of peers currently in the room */
  peers: number;
  /** Whether the room requires a password to join */
  hasPassword?: boolean;
}

export type PeerFoundCallback = (peer: DiscoveredPeer) => void;

export class PeerDiscovery {
  private active = false;

  /**
   * Callback invoked each time a Syncplay peer is discovered on the LAN.
   * Set this to receive real-time peer notifications.
   *
   * @example
   *   discovery.onPeerFound = (peer) => {
   *     console.log(`Found ${peer.username} at ${peer.ip}:${peer.port}`);
   *   };
   */
  onPeerFound: PeerFoundCallback | null = null;

  /**
   * List of all peers discovered since the last startDiscovery() call.
   * Cleared on each start. Duplicates are suppressed (by ip:port).
   */
  foundPeers: DiscoveredPeer[] = [];

  /**
   * List of rooms discovered via queryServerRooms(). Updated each call.
   */
  foundRooms: DiscoveredRoom[] = [];

  /**
   * Query the signaling server's GET /rooms endpoint for available rooms.
   *
   * Converts the given signaling URL from ws:// to http://, fetches the
   * /rooms endpoint, and parses the response as a list of DiscoveredRoom
   * objects. Results are stored in `foundRooms`.
   *
   * The Rust signaling server at port 8998 should expose:
   *   GET /rooms → [{ "room": "...", "peers": N, "hasPassword": bool }]
   *
   * @param signalingUrl - WebSocket URL of the signaling server
   *   (e.g., 'ws://192.168.1.5:8998' or 'ws://localhost:8998')
   * @returns Array of discovered rooms
   */
  async queryServerRooms(signalingUrl: string): Promise<DiscoveredRoom[]> {
    // Convert ws:// to http:// (or wss:// to https://)
    const httpUrl = signalingUrl
      .replace(/^ws:\/\//, 'http://')
      .replace(/^wss:\/\//, 'https://');

    // Build the /rooms endpoint URL
    const roomsUrl = httpUrl.replace(/\/$/, '') + '/rooms';

    console.log(`[PeerDiscovery] queryServerRooms: fetching ${roomsUrl}`);

    try {
      const response = await fetch(roomsUrl, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        // Short timeout for LAN requests
        signal: AbortSignal.timeout?.(5000),
      });

      if (!response.ok) {
        console.warn(
          `[PeerDiscovery] /rooms returned ${response.status}: ${response.statusText}`,
        );
        return [];
      }

      const data: unknown = await response.json();

      // Validate the response is an array of room objects
      if (!Array.isArray(data)) {
        console.warn('[PeerDiscovery] /rooms response is not an array:', data);
        return [];
      }

      const rooms: DiscoveredRoom[] = data
        .filter(
          (item): item is Record<string, unknown> =>
            typeof item === 'object' && item !== null && typeof (item as any).room === 'string',
        )
        .map(item => ({
          room: item.room as string,
          peers: typeof item.peers === 'number' ? item.peers : 0,
          hasPassword: typeof item.hasPassword === 'boolean' ? item.hasPassword : false,
        }));

      this.foundRooms = rooms;
      console.log(
        `[PeerDiscovery] Found ${rooms.length} room(s):`,
        rooms.map(r => `${r.room} (${r.peers} peer(s))`).join(', '),
      );

      return rooms;
    } catch (err) {
      console.warn('[PeerDiscovery] queryServerRooms failed:', err);
      return [];
    }
  }

  /**
   * Start LAN peer discovery.
   *
   * When fully implemented, this would:
   * 1. Create a multicast UDP socket bound to 224.0.0.251:5353 (mDNS).
   * 2. Announce a PTR + SRV + TXT record advertising the service:
   *    - Service type: `_syncplay-p2p._tcp.local`
   *    - Instance name: `<username>._syncplay-p2p._tcp.local`
   *    - Port: `port` (default 8998)
   *    - TXT keys: `room=<room>`, `username=<username>`, `version=2.0.0`
   * 3. Start listening for mDNS query responses to discover other peers.
   * 4. Emit `peer-discovered` events with `{ ip, port, username, room }`.
   *
   * @param port     The signaling server port to advertise (default: 8998).
   * @param room     Optional room name filter (only discover peers in the same room).
   * @param username Optional username to include in the TXT record.
   */
  startDiscovery(port = 8998, room?: string, username?: string): void {
    if (this.active) return;
    this.active = true;
    this.foundPeers = [];
    console.log(
      `[PeerDiscovery] mDNS discovery would broadcast on port ${port}` +
        (room ? `, room="${room}"` : '') +
        (username ? `, username="${username}"` : ''),
    );

    // TODO: Implement actual mDNS using one of:
    //   - Node.js:     import MulticastDNS from 'multicast-dns'
    //   - React Native: import Zeroconf from 'react-native-zeroconf'
    //
    // Example (Node.js pseudocode):
    //
    //   const mdns = MulticastDNS();
    //   // Announce our service
    //   mdns.on('query', (query: any) => {
    //     for (const question of query.questions) {
    //       if (question.name === '_syncplay-p2p._tcp.local') {
    //         mdns.respond({
    //           answers: [{
    //             name: '_syncplay-p2p._tcp.local',
    //             type: 'PTR',
    //             data: `${username}._syncplay-p2p._tcp.local`,
    //           }, {
    //             name: `${username}._syncplay-p2p._tcp.local`,
    //             type: 'SRV',
    //             data: { port, target: 'localhost' },
    //           }, {
    //             name: `${username}._syncplay-p2p._tcp.local`,
    //             type: 'TXT',
    //             data: [`room=${room}`, `username=${username}`],
    //           }],
    //         });
    //       }
    //     }
    //   });
    //   // Browse for peers
    //   mdns.query('_syncplay-p2p._tcp.local', 'PTR');
    //   mdns.on('response', (response: any) => {
    //     for (const answer of response.answers) {
    //       // Parse SRV/TXT records → emit peer-discovered event
    //     }
    //   });
  }

  /**
   * Stop LAN peer discovery and tear down the multicast socket.
   */
  stopDiscovery(): void {
    if (!this.active) return;
    this.active = false;
    console.log('[PeerDiscovery] mDNS discovery stopped.');
    // TODO: close multicast socket, send goodbye TTL=0 packets
  }

  /**
   * Perform a one-shot scan for LAN peers.
   *
   * When implemented, this sends an mDNS query for `_syncplay-p2p._tcp.local`
   * and collects responses for a short window (~3 seconds). Discovered peers
   * are appended to `foundPeers` and the `onPeerFound` callback is invoked.
   *
   * For browser/RN environments, use queryServerRooms() instead which queries
   * the signaling server's HTTP endpoint.
   */
  scanOnce(): void {
    console.log('[PeerDiscovery] scanOnce: would send mDNS query and wait for responses.');

    // Stub: populate with a sample discovered peer to show the expected format.
    // In a real implementation, each mDNS response would produce a DiscoveredPeer
    // object like this and call onPeerFound + push to foundPeers.
    const stubPeer: DiscoveredPeer = {
      ip: '192.168.1.100',
      port: 8998,
      username: 'alice',
      room: 'default',
      version: '2.0.0',
    };

    // Avoid duplicates (stub is always the same, so only add once)
    const exists = this.foundPeers.some(
      p => p.ip === stubPeer.ip && p.port === stubPeer.port,
    );
    if (!exists) {
      this.foundPeers.push(stubPeer);
      this.onPeerFound?.(stubPeer);
    }
  }
}
