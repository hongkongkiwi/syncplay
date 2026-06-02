//! WebSocket Signaling Server
//!
//! A lightweight WebSocket relay for WebRTC signaling.
//! Handles room create/join/leave, SDP/ICE relay, host election.
//!
//! Replaces: 160-line Node.js server + the original 585-line Python SyncFactory.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;

use crate::sfu::SfuServer;
use anyhow::Result;
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use log::{error, info, warn};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::{accept_async, tungstenite::Message, WebSocketStream};

// ── Rate limiting for signal messages ─────────────────────────────────
const MAX_SIGNAL_RATE: u32 = 20; // max signals per window
const SIGNAL_WINDOW_MS: u64 = 1000; // 1 second window
const MAX_SIGNAL_PAYLOAD_BYTES: usize = 64 * 1024; // 64 KB cap per signal message

// ── Signalling Messages ──────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ClientMessage {
    #[serde(rename = "create")]
    Create {
        room: String,
        #[serde(default)]
        password: String,
        #[serde(default)]
        username: String,
        #[serde(default)]
        persistent: bool,
        #[serde(default)]
        features: Vec<String>,
    },
    #[serde(rename = "join")]
    Join {
        room: String,
        #[serde(default)]
        password: String,
        username: String,
        #[serde(default)]
        features: Vec<String>,
    },
    #[serde(rename = "signal")]
    Signal {
        target: String,
        payload: SignalPayload,
    },
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "leave")]
    Leave,
    #[serde(rename = "list_rooms")]
    ListRooms,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct SignalPayload {
    kind: String,
    #[serde(default)]
    sdp: String,
    #[serde(default)]
    candidate: String,
    #[serde(rename = "sdpMid", default)]
    sdp_mid: String,
    #[serde(rename = "sdpMLineIndex", default)]
    sdp_mline_index: u16,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum ServerMessage {
    #[serde(rename = "created")]
    Created {
        #[serde(rename = "roomId")]
        room_id: String,
        #[serde(rename = "hostId")]
        host_id: String,
        #[serde(rename = "peerId")]
        peer_id: String,
        peers: Vec<serde_json::Value>,
    },
    #[serde(rename = "room_info")]
    RoomInfo {
        #[serde(rename = "roomId")]
        room_id: String,
        #[serde(rename = "hostId")]
        host_id: String,
        #[serde(rename = "peerId")]
        peer_id: String,
        peers: Vec<serde_json::Value>,
    },
    #[serde(rename = "peer_joined")]
    PeerJoined {
        #[serde(rename = "peerId")]
        peer_id: String,
        username: String,
        features: Vec<String>,
    },
    #[serde(rename = "peer_left")]
    PeerLeft {
        #[serde(rename = "peerId")]
        peer_id: String,
        reason: String,
    },
    #[serde(rename = "host_changed")]
    HostChanged {
        #[serde(rename = "hostId")]
        host_id: String,
        reason: String,
    },
    #[serde(rename = "signal")]
    SignalRelay {
        from: String,
        payload: SignalPayload,
    },
    #[serde(rename = "pong")]
    Pong,
    #[serde(rename = "room_list")]
    RoomList { rooms: Vec<serde_json::Value> },
    #[serde(rename = "error")]
    Error { code: String, message: String },
}

// ── Room ─────────────────────────────────────────────────────────────

struct Room {
    password: Option<String>,
    host_id: String,
    peers: HashMap<String, PeerInfo>,
    join_order: Vec<String>,
    /// If true, room is not removed when empty (persistent rooms)
    persistent: bool,
}

struct PeerInfo {
    id: String,
    username: String,
    features: Vec<String>,
    tx: mpsc::Sender<String>,
}

// ── Free helpers ─────────────────────────────────────────────────────

const MAX_PEERS_PER_ROOM: usize = 100;

/// Constant-time byte comparison to prevent timing side-channel attacks.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn make_peer_id() -> String {
    use std::time::SystemTime;
    let ts = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{ts:x}-{:04x}", rand::random::<u16>())
}

fn peer_info(p: &PeerInfo) -> serde_json::Value {
    serde_json::json!({
        "peerId": p.id,
        "username": p.username,
        "features": p.features,
    })
}

fn send_json(tx: &mpsc::Sender<String>, msg: &ServerMessage) {
    match serde_json::to_string(msg) {
        Ok(s) => {
            if let Err(e) = tx.try_send(s) {
                log::warn!("[signalling] channel full, dropping message: {e}");
            }
        }
        Err(e) => log::error!("JSON serialize failed: {e}"),
    }
}

fn valid_name(s: &str, min: usize, max: usize) -> bool {
    !s.is_empty()
        && s.len() >= min
        && s.len() <= max
        && s.chars().all(|c| c.is_ascii_graphic() || c == ' ')
}

fn err(code: &str, message: &str) -> ServerMessage {
    ServerMessage::Error {
        code: code.into(),
        message: message.into(),
    }
}

// ── Server ───────────────────────────────────────────────────────────

pub struct SignalingServer {
    rooms: Arc<DashMap<String, Arc<Mutex<Room>>>>,
    sfu_server: Option<Arc<SfuServer>>,
}

impl Default for SignalingServer {
    fn default() -> Self {
        Self::new()
    }
}

impl SignalingServer {
    pub fn new() -> Self {
        Self {
            rooms: Arc::new(DashMap::new()),
            sfu_server: None,
        }
    }

    /// Enable SFU mode — WebRTC connections are routed through the server
    /// instead of peer-to-peer. Each client maintains a single connection
    /// to the server, which routes data channels and forwards audio.
    pub fn with_sfu(mut self, sfu: SfuServer) -> Self {
        self.sfu_server = Some(Arc::new(sfu));
        self
    }

    pub async fn run(
        &self,
        addr: SocketAddr,
        tls_config: Option<Arc<rustls::ServerConfig>>,
    ) -> Result<()> {
        let listener = TcpListener::bind(addr).await?;
        info!("[signaling] listening on {addr}");
        let rooms = self.rooms.clone();
        let sfu = self.sfu_server.clone();
        let tls_acceptor: Option<TlsAcceptor> = tls_config.map(TlsAcceptor::from);

        loop {
            match listener.accept().await {
                Ok((stream, peer_addr)) => {
                    let rooms = rooms.clone();
                    let sfu = sfu.clone();
                    let tls_acceptor = tls_acceptor.clone();
                    tokio::spawn(async move {
                        if let Err(e) =
                            handle_connection(rooms, sfu, tls_acceptor, stream, peer_addr).await
                        {
                            error!("Connection error from {peer_addr}: {e}");
                        }
                    });
                }
                Err(e) => {
                    error!("Accept error: {e}");
                }
            }
        }
    }
}

// ── Connection handler (free function) ───────────────────────────────

async fn handle_connection(
    rooms: Arc<DashMap<String, Arc<Mutex<Room>>>>,
    sfu_server: Option<Arc<SfuServer>>,
    tls_acceptor: Option<TlsAcceptor>,
    stream: TcpStream,
    addr: SocketAddr,
) -> Result<()> {
    if let Some(acceptor) = tls_acceptor {
        let tls_stream = acceptor.accept(stream).await?;
        let ws = accept_async(tls_stream).await?;
        handle_ws(ws, rooms, sfu_server, addr).await
    } else {
        let ws = accept_async(stream).await?;
        handle_ws(ws, rooms, sfu_server, addr).await
    }
}

/// Generic inner handler that works with any WebSocket stream type
/// (plain TCP or TLS-wrapped).
async fn handle_ws<S>(
    ws: WebSocketStream<S>,
    rooms: Arc<DashMap<String, Arc<Mutex<Room>>>>,
    sfu_server: Option<Arc<SfuServer>>,
    _addr: SocketAddr,
) -> Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut write, mut read) = ws.split();

    let (tx, mut rx) = mpsc::channel::<String>(1024);
    let (done_tx, mut done_rx) = mpsc::channel::<()>(1024);

    let mut peer_id: Option<String> = None;
    let mut room_name: Option<String> = None;

    // Rate limiting state for signal messages
    let mut signal_count: u32 = 0;
    let mut signal_window_start = Instant::now();

    // Write loop
    let write_handle = tokio::spawn(async move {
        loop {
            tokio::select! {
                msg = rx.recv() => {
                    match msg {
                        Some(text) => {
                            if write.send(Message::Text(text.into())).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    }
                }
                _ = done_rx.recv() => {
                    break;
                }
            }
        }
    });

    // Read loop
    loop {
        tokio::select! {
            msg = read.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        let msg: ClientMessage = match serde_json::from_str(&text) {
                            Ok(m) => m,
                            Err(e) => {
                                send_json(&tx, &err("parse_error", &e.to_string()));
                                continue;
                            }
                        };

                        match msg {
                            ClientMessage::Create { room, password, username, features, persistent, .. } => {
                                if !valid_name(&room, 1, 64) {
                                    send_json(&tx, &err("invalid_name", "Room name must be 1-64 printable chars"));
                                    continue;
                                }
                                if !valid_name(&username, 1, 32) {
                                    send_json(&tx, &err("invalid_name", "Username must be 1-32 printable chars"));
                                    continue;
                                }
                                if rooms.contains_key(&room) {
                                    send_json(&tx, &err("room_exists", &format!("Room '{room}' already exists")));
                                    continue;
                                }

                                let pid = make_peer_id();
                                let p = PeerInfo { id: pid.clone(), username: username.clone(), features, tx: tx.clone() };

                                let mut peers_map = HashMap::new();
                                peers_map.insert(pid.clone(), p);
                                let join_order = vec![pid.clone()];
                                let room_obj = Arc::new(Mutex::new(Room {
                                    password: if password.is_empty() { None } else { Some(password) },
                                    host_id: pid.clone(),
                                    peers: peers_map,
                                    join_order,
                                    persistent,
                                }));

                                rooms.insert(room.clone(), room_obj);
                                peer_id = Some(pid.clone());
                                room_name = Some(room.clone());

                                send_json(&tx, &ServerMessage::Created {
                                    room_id: room.clone(),
                                    host_id: pid.clone(),
                                    peer_id: pid.clone(),
                                    peers: vec![],
                                });

                                info!("[room] created: {room}  host: {pid}  user: {username}");
                            }

                            ClientMessage::Join { room, password, username, features } => {
                                if !valid_name(&username, 1, 32) {
                                    send_json(&tx, &err("invalid_name", "Username must be 1-32 printable chars"));
                                    continue;
                                }
                                let room_obj = match rooms.get(&room) {
                                    Some(r) => r.clone(),
                                    None => {
                                        send_json(&tx, &err("room_not_found", &format!("Room '{room}' not found")));
                                        continue;
                                    }
                                };

                                {
                                    let r = room_obj.lock();
                                    if let Some(pwd) = &r.password {
                                        // Constant-time comparison to prevent timing side-channel
                                        if !constant_time_eq(pwd.as_bytes(), password.as_bytes()) {
                                            send_json(&tx, &err("wrong_password", "Incorrect room password"));
                                            continue;
                                        }
                                    }
                                    if r.peers.values().any(|p| p.username == username) {
                                        send_json(&tx, &err("name_taken", &format!("Username '{username}' is taken")));
                                        continue;
                                    }
                                    if r.peers.len() >= MAX_PEERS_PER_ROOM {
                                        send_json(&tx, &err("room_full", &format!("Room '{room}' is full (max {MAX_PEERS_PER_ROOM})")));
                                        continue;
                                    }
                                }

                                let pid = make_peer_id();
                                let host_id;
                                let existing_peers: Vec<serde_json::Value>;

                                {
                                    let mut r = room_obj.lock();
                                    host_id = r.host_id.clone();
                                    existing_peers = r.peers.values().map(peer_info).collect();

                                    let p = PeerInfo { id: pid.clone(), username: username.clone(), features: features.clone(), tx: tx.clone() };
                                    r.peers.insert(pid.clone(), p);
                                    r.join_order.push(pid.clone());
                                }

                                peer_id = Some(pid.clone());
                                room_name = Some(room.clone());

                                send_json(&tx, &ServerMessage::RoomInfo {
                                    room_id: room.clone(),
                                    host_id: host_id.clone(),
                                    peer_id: pid.clone(),
                                    peers: existing_peers,
                                });

                                let joined_msg = ServerMessage::PeerJoined {
                                    peer_id: pid.clone(),
                                    username: username.clone(),
                                    features,
                                };

                                let r = room_obj.lock();
                                for p in r.peers.values() {
                                    if p.id != pid {
                                        send_json(&p.tx, &joined_msg);
                                    }
                                }

                                info!("[room] {room}: {username} joined  ({} peers)", room_obj.lock().peers.len());
                            }

                            ClientMessage::Signal { target, payload } => {
                                if let (Some(ref pid), Some(ref rname)) = (&peer_id, &room_name) {
                                    // Validate target before locking room
                                    if target.is_empty() {
                                        warn!("[signal] empty target from {pid}");
                                        continue;
                                    }

                                    // Rate limit
                                    let now = Instant::now();
                                    if now.duration_since(signal_window_start).as_millis() as u64 > SIGNAL_WINDOW_MS {
                                        signal_window_start = now;
                                        signal_count = 0;
                                    }
                                    signal_count += 1;
                                    if signal_count > MAX_SIGNAL_RATE {
                                        warn!("[signal] rate limit exceeded for {pid} — dropping signal to {target}");
                                        continue;
                                    }
                                    // Payload size cap
                                    let payload_json = serde_json::to_string(&payload).unwrap_or_default();
                                    if payload_json.len() > MAX_SIGNAL_PAYLOAD_BYTES {
                                        warn!("[signal] oversized payload from {pid}: {} bytes", payload_json.len());
                                        continue;
                                    }

                                    // ── SFU routing: target="_server" → handle SDP/ICE server-side ──
                                    if target == "_server" {
                                        if let Some(ref sfu) = sfu_server {
                                            // Look up peer username for SFU tracking
                                            let username = rooms
                                                .get(rname)
                                                .and_then(|r| {
                                                    let room = r.lock();
                                                    room.peers.get(pid).map(|p| p.username.clone())
                                                })
                                                .unwrap_or_default();

                                            match payload.kind.as_str() {
                                                "offer" => {
                                                    match sfu.handle_offer(rname, pid, &username, &payload.sdp).await {
                                                        Ok(answer_sdp) => {
                                                            send_json(&tx, &ServerMessage::SignalRelay {
                                                                from: "_server".into(),
                                                                payload: SignalPayload {
                                                                    kind: "answer".into(),
                                                                    sdp: answer_sdp,
                                                                    candidate: String::new(),
                                                                    sdp_mid: String::new(),
                                                                    sdp_mline_index: 0,
                                                                },
                                                            });
                                                        }
                                                        Err(e) => {
                                                            warn!("[sfu] offer failed: {e}");
                                                            send_json(&tx, &err("sfu_error", &format!("Offer failed: {e}")));
                                                        }
                                                    }
                                                }
                                                "ice" | "ice-candidate" => {
                                                    if let Err(e) = sfu.handle_ice(
                                                        rname, pid,
                                                        &payload.candidate,
                                                        &payload.sdp_mid,
                                                        payload.sdp_mline_index,
                                                    ).await {
                                                        warn!("[sfu] ICE failed: {e}");
                                                        // Send error feedback to client
                                                        send_json(&tx, &err("sfu_error", &format!("ICE failed: {e}")));
                                                    }
                                                }
                                                _ => {
                                                    warn!("[sfu] unknown signal kind: {}", payload.kind);
                                                }
                                            }
                                        }
                                        continue;
                                    }

                                    // Standard P2P relay
                                    if let Some(room) = rooms.get(rname) {
                                        let r = room.lock();
                                        if let Some(target_peer) = r.peers.get(&target) {
                                            send_json(
                                                &target_peer.tx,
                                                &ServerMessage::SignalRelay {
                                                    from: pid.clone(),
                                                    payload,
                                                },
                                            );
                                        } else {
                                            warn!("[signal] {pid} tried to signal unknown target {target}");
                                        }
                                    }
                                }
                            }

                            ClientMessage::Ping => {
                                send_json(&tx, &ServerMessage::Pong);
                            }

                            ClientMessage::Leave => {
                                break;
                            }

                            ClientMessage::ListRooms => {
                                let room_list: Vec<serde_json::Value> = rooms.iter().map(|entry| {
                                    let room_name = entry.key().clone();
                                    let room = entry.value().lock();
                                    serde_json::json!({
                                        "room": room_name,
                                        "peers": room.peers.len(),
                                        "has_password": room.password.is_some(),
                                    })
                                }).collect();
                                send_json(&tx, &ServerMessage::RoomList { rooms: room_list });
                                continue;
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    // Cleanup
    if let (Some(pid), Some(rname)) = (&peer_id, &room_name) {
        // SFU cleanup: remove peer from SFU server
        if let Some(ref sfu) = sfu_server {
            sfu.remove_peer(rname, pid).await;
        }

        if let Some(room) = rooms.get(rname) {
            let mut r = room.lock();

            let was_host = r.host_id == *pid;
            let new_host = if was_host {
                r.join_order.iter().find(|id| *id != pid).cloned()
            } else {
                None
            };

            if was_host {
                if let Some(ref new_id) = new_host {
                    r.host_id = new_id.clone();
                    let host_msg = ServerMessage::HostChanged {
                        host_id: new_id.clone(),
                        reason: "previous_host_left".into(),
                    };
                    for p in r.peers.values() {
                        send_json(&p.tx, &host_msg);
                    }
                    info!("[room] {rname}: host migrated to {new_id}");
                }
            }

            let _username = r.peers.remove(pid).map(|p| p.username).unwrap_or_default();
            let remaining = r.peers.len();
            drop(r);

            let leave_msg = ServerMessage::PeerLeft {
                peer_id: pid.clone(),
                reason: "left".into(),
            };

            let r = room.lock();
            for p in r.peers.values() {
                send_json(&p.tx, &leave_msg);
            }

            if remaining == 0 {
                let persistent = r.persistent;
                drop(r);
                if !persistent {
                    rooms.remove(rname);
                    info!("[room] removed empty room: {rname}");
                } else {
                    info!("[room] kept persistent room: {rname} (empty)");
                }
            }
        }
    }

    let _ = done_tx.try_send(());
    let _ = write_handle.await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_make_peer_id_format() {
        let id = make_peer_id();
        // Format: {timestamp_hex}-{4_hex}
        assert!(id.contains('-'));
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[1].len(), 4);
        // Should be valid hex
        u64::from_str_radix(parts[1], 16).expect("hex part");
    }

    #[test]
    fn test_make_peer_id_unique() {
        let id1 = make_peer_id();
        let id2 = make_peer_id();
        assert_ne!(id1, id2);
    }

    #[test]
    fn test_err_message() {
        let msg = err("test_code", "test message");
        match msg {
            ServerMessage::Error { code, message } => {
                assert_eq!(code, "test_code");
                assert_eq!(message, "test message");
            }
            _ => panic!("expected Error variant"),
        }
    }

    #[test]
    fn test_signaling_server_new() {
        let server = SignalingServer::new();
        assert!(server.rooms.is_empty());
    }

    #[test]
    fn test_peer_info_json() {
        let (tx, _rx) = mpsc::channel(1024);
        let info = PeerInfo {
            id: "peer-1".into(),
            username: "alice".into(),
            features: vec!["chat".into()],
            tx,
        };
        let json = peer_info(&info);
        assert_eq!(json["peerId"], "peer-1");
        assert_eq!(json["username"], "alice");
        assert!(json["features"].is_array());
    }
}
