// Syncplay P2P v2.0.0 — mDNS / LAN Peer Discovery stub
//
// This module provides a PeerDiscovery class that, when fully implemented,
// would use multicast DNS (mDNS) or SSDP to discover Syncplay peers on the
// local network without requiring a signaling server.
//
// ── Design Overview ──────────────────────────────────────────────────
//
// mDNS (RFC 6762) uses multicast UDP on 224.0.0.251:5353 to broadcast
// and discover services. Each Syncplay peer would:
//
//   1. Broadcast: Announce a service of type `_syncplay-p2p._tcp` on port
//      8998 (the signaling port), with a TXT record containing the peer's
//      room name and username.
//
//   2. Listen: Continuously listen for mDNS responses from other peers
//      advertising the same service type. Filter by matching room name.
//
//   3. Connect: After discovering a peer, connect directly via WebSocket
//      to ws://<peer-ip>:8998 for signaling, then establish a WebRTC
//      data channel.
//
// Alternative: SSDP (Simple Service Discovery Protocol, UPnP) could be
// used instead, broadcasting M-SEARCH on 239.255.255.250:1900 with the
// same service type.
//
// ── Platform Considerations ─────────────────────────────────────────
//
// - Browser: mDNS is NOT available in standard browser APIs. A browser
//   implementation would need a native extension or WebRTC's built-in
//   mDNS hostname resolution (limited to hostnames, not service discovery).
//   For web, the signaling server remains the primary discovery mechanism.
//
// - React Native: Can use multicast via react-native-udp or
//   react-native-network-info for LAN scanning, but mDNS libraries
//   (like react-native-zeroconf) may be needed.
//
// - Node.js / Electron: Full mDNS support via the `multicast-dns` npm
//   package or the `bonjour` package.
//
// ── Usage ────────────────────────────────────────────────────────────
//
//   import { PeerDiscovery } from 'syncplay-p2p-client';
//
//   const discovery = new PeerDiscovery();
//   discovery.startDiscovery(8998, 'my-room', 'alice');
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
   * Perform a one-shot scan for LAN peers (non-blocking stub).
   *
   * When implemented, this sends an mDNS query for `_syncplay-p2p._tcp.local`
   * and collects responses for a short window (~3 seconds). Discovered peers
   * are appended to `foundPeers` and the `onPeerFound` callback is invoked.
   *
   * In the browser stub, this populates foundPeers with a sample entry to
   * demonstrate the expected format.
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
