//! WebSocket Signaling Server
//!
//! A lightweight WebSocket relay for WebRTC signaling.
//! Handles room create/join/leave, SDP/ICE relay, host election.
//!
//! Replaces: 160-line Node.js server + the original 585-line Python SyncFactory.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::sfu::SfuServer;
use anyhow::Result;
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use log::{error, info, warn};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Notify};
use tokio::time::timeout;
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::{
    accept_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
    WebSocketStream,
};

// ── Configuration ─────────────────────────────────────────────────────

/// DoS-resistant signaling server configuration.
#[derive(Debug, Clone)]
pub struct SignalingConfig {
    /// Max concurrent WebSocket connections from a single IP.
    pub max_connections_per_ip: usize,
    /// Max concurrent WebSocket connections globally.
    pub max_connections_total: usize,
    /// Max rooms that can exist at once.
    pub max_rooms: usize,
    /// Max peers allowed in a single room.
    pub max_peers_per_room: usize,
    /// Max room name length (chars).
    pub max_room_name_len: usize,
    /// Max username length (chars).
    pub max_username_len: usize,
    /// Max password length (bytes).
    pub max_password_len: usize,
    /// Max number of features per client.
    pub max_features: usize,
    /// WebSocket max message size (bytes).
    pub max_message_size: usize,
    /// WebSocket max frame size (bytes).
    pub max_frame_size: usize,
    /// Timeout for completing the WebSocket handshake.
    pub handshake_timeout: Duration,
    /// Idle timeout before joining a room (no valid messages).
    pub auth_timeout: Duration,
    /// How often to send WebSocket pings to keep connections alive.
    pub ping_interval: Duration,
    /// New connections per second per IP (burst limit).
    pub connection_rate_per_ip: usize,
    /// Window for connection rate limiting.
    pub connection_rate_window: Duration,
}

impl Default for SignalingConfig {
    fn default() -> Self {
        Self {
            max_connections_per_ip: 50,
            max_connections_total: 5000,
            max_rooms: 10_000,
            max_peers_per_room: 100,
            max_room_name_len: 64,
            max_username_len: 32,
            max_password_len: 256,
            max_features: 100,
            max_message_size: 256 * 1024, // 256 KB
            max_frame_size: 64 * 1024,    // 64 KB
            handshake_timeout: Duration::from_secs(10),
            auth_timeout: Duration::from_secs(30),
            ping_interval: Duration::from_secs(15),
            connection_rate_per_ip: 10,
            connection_rate_window: Duration::from_secs(1),
        }
    }
}

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

// ── Connection tracker for per-IP rate limiting ─────────────────────

struct IpConnectionState {
    active_count: AtomicUsize,
    /// Timestamps of recent connections for rate limiting.
    recent_times: Mutex<Vec<Instant>>,
}

impl IpConnectionState {
    fn new() -> Self {
        Self {
            active_count: AtomicUsize::new(0),
            recent_times: Mutex::new(Vec::new()),
        }
    }
}

struct ConnectionTracker {
    per_ip: DashMap<IpAddr, IpConnectionState>,
    total_active: AtomicUsize,
    /// Global shutdown signal.
    shutdown: Notify,
}

impl ConnectionTracker {
    fn new() -> Self {
        Self {
            per_ip: DashMap::new(),
            total_active: AtomicUsize::new(0),
            shutdown: Notify::new(),
        }
    }

    /// Try to register a new connection. Returns Ok if allowed, Err with
    /// an error code and message if denied.
    fn try_accept(&self, ip: IpAddr, config: &SignalingConfig) -> Result<(), (String, String)> {
        // Global connection limit
        let total = self.total_active.load(Ordering::Relaxed);
        if total >= config.max_connections_total {
            return Err(("server_full".into(), "Server at capacity".into()));
        }

        // Per-IP rate limiting (connections/sec)
        let state = self.per_ip.entry(ip).or_insert_with(IpConnectionState::new);
        {
            let mut times = state.recent_times.lock();
            let now = Instant::now();
            let cutoff = now - config.connection_rate_window;
            times.retain(|t| *t > cutoff);
            if times.len() >= config.connection_rate_per_ip {
                return Err((
                    "rate_limited".into(),
                    "Too many connections, slow down".into(),
                ));
            }
            times.push(now);
        }

        // Per-IP concurrent connection limit
        let ip_count = state.active_count.load(Ordering::Relaxed);
        if ip_count >= config.max_connections_per_ip {
            return Err((
                "ip_limit".into(),
                "Too many connections from your IP".into(),
            ));
        }

        state.active_count.fetch_add(1, Ordering::Relaxed);
        self.total_active.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    fn release(&self, ip: IpAddr) {
        if let Some(state) = self.per_ip.get(&ip) {
            state.active_count.fetch_sub(1, Ordering::Relaxed);
        }
        self.total_active.fetch_sub(1, Ordering::Relaxed);
    }

    fn shutdown(&self) {
        self.shutdown.notify_waiters();
    }

    fn shutdown_notified(&self) -> impl std::future::Future<Output = ()> + '_ {
        self.shutdown.notified()
    }

    fn active_connections(&self) -> usize {
        self.total_active.load(Ordering::Relaxed)
    }
}

// ── Server ───────────────────────────────────────────────────────────

pub struct SignalingServer {
    rooms: Arc<DashMap<String, Arc<Mutex<Room>>>>,
    sfu_server: Option<Arc<SfuServer>>,
    config: SignalingConfig,
    tracker: Arc<ConnectionTracker>,
}

impl Default for SignalingServer {
    fn default() -> Self {
        Self::new()
    }
}

impl SignalingServer {
    pub fn new() -> Self {
        Self::new_with_config(SignalingConfig::default())
    }

    pub fn new_with_config(config: SignalingConfig) -> Self {
        Self {
            rooms: Arc::new(DashMap::new()),
            sfu_server: None,
            config,
            tracker: Arc::new(ConnectionTracker::new()),
        }
    }

    /// Enable SFU mode — WebRTC connections are routed through the server
    /// instead of peer-to-peer. Each client maintains a single connection
    /// to the server, which routes data channels and forwards audio.
    pub fn with_sfu(mut self, sfu: SfuServer) -> Self {
        self.sfu_server = Some(Arc::new(sfu));
        self
    }

    /// Initiate graceful shutdown. Stops accepting new connections and
    /// notifies all handlers to close.
    pub fn shutdown(&self) {
        info!("[signaling] initiating graceful shutdown...");
        self.tracker.shutdown();
    }

    /// Return the number of active connections.
    pub fn active_connections(&self) -> usize {
        self.tracker.active_connections()
    }

    pub async fn run(
        &self,
        addr: SocketAddr,
        tls_config: Option<Arc<rustls::ServerConfig>>,
    ) -> Result<()> {
        let listener = TcpListener::bind(addr).await?;
        info!("[signaling] listening on {addr}");
        info!(
            "[signaling] limits: max_conn={} per_ip={} max_rooms={} max_peers_per_room={}",
            self.config.max_connections_total,
            self.config.max_connections_per_ip,
            self.config.max_rooms,
            self.config.max_peers_per_room,
        );
        let rooms = self.rooms.clone();
        let sfu = self.sfu_server.clone();
        let config = self.config.clone();
        let tracker = self.tracker.clone();
        let tls_acceptor: Option<TlsAcceptor> = tls_config.map(TlsAcceptor::from);
        let _wss = tls_acceptor.is_some();

        loop {
            tokio::select! {
                accept_result = listener.accept() => {
                    match accept_result {
                        Ok((stream, peer_addr)) => {
                            let ip = peer_addr.ip();
                            let rooms = rooms.clone();
                            let sfu = sfu.clone();
                            let tls_acceptor = tls_acceptor.clone();
                            let config = config.clone();
                            let tracker = tracker.clone();

                            // Check connection limits before spawning
                            match tracker.try_accept(ip, &config) {
                                Ok(()) => {
                                    tokio::spawn(async move {
                                        if let Err(e) = handle_connection(
                                            rooms, sfu, tls_acceptor, stream, peer_addr,
                                            &config, &tracker,
                                        ).await
                                        {
                                            if !matches!(e.downcast_ref::<std::io::Error>(), Some(ioe) if ioe.kind() == std::io::ErrorKind::ConnectionReset || ioe.kind() == std::io::ErrorKind::ConnectionAborted)
                                            {
                                                error!("Connection error from {peer_addr}: {e}");
                                            }
                                        }
                                        tracker.release(ip);
                                    });
                                }
                                Err((code, msg)) => {
                                    // Connection rejected — send HTTP 503-like response and close
                                    warn!(
                                        "[signaling] rejected connection from {peer_addr}: {code}"
                                    );
                                    // Try to send a polite rejection
                                    let _ = send_ws_rejection(stream, &code, &msg).await;
                                }
                            }
                        }
                        Err(e) => {
                            error!("Accept error: {e}");
                        }
                    }
                }
                _ = tracker.shutdown_notified() => {
                    info!(
                        "[signaling] shutdown signal received, stopping accept loop ({} active connections)",
                        tracker.active_connections()
                    );
                    break;
                }
            }
        }

        info!("[signaling] server stopped");
        Ok(())
    }
}

/// Send a graceful rejection message to a TCP stream before closing.
/// We attempt to complete the WebSocket handshake and send an error,
/// but if the client isn't doing WS, just close.
async fn send_ws_rejection(stream: TcpStream, code: &str, msg: &str) -> Result<()> {
    // Try to complete the handshake with a short timeout
    let ws_result = timeout(
        Duration::from_secs(2),
        accept_async_with_config(
            stream,
            Some(
                WebSocketConfig::default()
                    .max_message_size(Some(4096))
                    .max_frame_size(Some(4096)),
            ),
        ),
    )
    .await;

    match ws_result {
        Ok(Ok(mut ws)) => {
            let rejection = serde_json::json!({
                "type": "error",
                "code": code,
                "message": msg,
            });
            let text = rejection.to_string();
            let _ = ws.send(Message::Text(text.into())).await;
            let _ = ws.close(None).await;
        }
        _ => {
            // Client wasn't doing WS or timed out — just drop
        }
    }
    Ok(())
}

// ── Connection handler (free function) ───────────────────────────────

async fn handle_connection(
    rooms: Arc<DashMap<String, Arc<Mutex<Room>>>>,
    sfu_server: Option<Arc<SfuServer>>,
    tls_acceptor: Option<TlsAcceptor>,
    stream: TcpStream,
    addr: SocketAddr,
    config: &SignalingConfig,
    tracker: &ConnectionTracker,
) -> Result<()> {
    // WebSocket config with size limits to prevent memory exhaustion
    let ws_config = WebSocketConfig::default()
        .max_message_size(Some(config.max_message_size))
        .max_frame_size(Some(config.max_frame_size));

    // WebSocket handshake with timeout (slowloris protection)
    if let Some(acceptor) = tls_acceptor {
        let tls_handshake = timeout(config.handshake_timeout, acceptor.accept(stream));
        let tls_stream = match tls_handshake.await {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => {
                warn!("[signaling] TLS handshake failed from {addr}: {e}");
                return Err(e.into());
            }
            Err(_) => {
                warn!("[signaling] TLS handshake timeout from {addr}");
                return Err(anyhow::anyhow!("TLS handshake timeout"));
            }
        };

        let ws_handshake = timeout(
            config.handshake_timeout,
            accept_async_with_config(tls_stream, Some(ws_config)),
        );
        let ws = match ws_handshake.await {
            Ok(Ok(ws)) => ws,
            Ok(Err(e)) => {
                warn!("[signaling] WebSocket handshake failed from {addr}: {e}");
                return Err(e.into());
            }
            Err(_) => {
                warn!("[signaling] WebSocket handshake timeout from {addr}");
                return Err(anyhow::anyhow!("handshake timeout"));
            }
        };
        return handle_ws(ws, rooms, sfu_server, addr, config, tracker).await;
    }

    let ws_handshake = timeout(
        config.handshake_timeout,
        accept_async_with_config(stream, Some(ws_config)),
    );
    let ws = match ws_handshake.await {
        Ok(Ok(ws)) => ws,
        Ok(Err(e)) => {
            warn!("[signaling] WebSocket handshake failed from {addr}: {e}");
            return Err(e.into());
        }
        Err(_) => {
            warn!("[signaling] WebSocket handshake timeout from {addr}");
            return Err(anyhow::anyhow!("handshake timeout"));
        }
    };

    handle_ws(ws, rooms, sfu_server, addr, config, tracker).await
}

/// Generic inner handler that works with any WebSocket stream type
/// (plain TCP or TLS-wrapped).
async fn handle_ws<S>(
    ws: WebSocketStream<S>,
    rooms: Arc<DashMap<String, Arc<Mutex<Room>>>>,
    sfu_server: Option<Arc<SfuServer>>,
    addr: SocketAddr,
    config: &SignalingConfig,
    tracker: &ConnectionTracker,
) -> Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut write, mut read) = ws.split();

    let (tx, mut rx) = mpsc::channel::<String>(1024);
    let (done_tx, mut done_rx) = mpsc::channel::<()>(1024);

    let mut peer_id: Option<String> = None;
    let mut room_name: Option<String> = None;

    // Track whether the client has authenticated (joined or created a room).
    let mut authenticated = false;
    let connection_start = Instant::now();

    // Rate limiting state for signal messages
    let mut signal_count: u32 = 0;
    let mut signal_window_start = Instant::now();

    let ping_interval = config.ping_interval;

    // Write loop — also handles ping/pong keepalive
    let write_handle = tokio::spawn(async move {
        let mut ping_timer = tokio::time::interval(ping_interval);
        // Skip first tick (delay)
        ping_timer.tick().await;

        loop {
            tokio::select! {
                _ = ping_timer.tick() => {
                    // Send WebSocket ping frame for keepalive
                    if write.send(Message::Ping(bytes::Bytes::new())).await.is_err() {
                        break;
                    }
                }
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
        // Determine timeout: shorter auth timeout for unauthenticated connections
        let read_deadline = if authenticated {
            // Already in a room — no idle timeout (rely on ping/pong)
            // But still use a generous timeout to detect dead connections
            Duration::from_secs(120)
        } else {
            config.auth_timeout
        };

        let read_fut = read.next();
        let msg_result = tokio::select! {
            msg = read_fut => msg,
            _ = tokio::time::sleep(read_deadline) => {
                if !authenticated {
                    warn!("[signaling] auth timeout for {addr} ({:.0}s idle)", connection_start.elapsed().as_secs());
                    send_json(&tx, &err("timeout", "Authentication timeout — please join or create a room"));
                    // Give the client a moment to receive the error
                    tokio::time::sleep(Duration::from_millis(500)).await;
                } else {
                    warn!("[signaling] idle timeout for {addr} (peer={peer_id:?})");
                }
                break;
            }
            _ = tracker.shutdown_notified() => {
                info!("[signaling] shutdown: closing connection from {addr}");
                send_json(&tx, &err("shutdown", "Server is shutting down"));
                tokio::time::sleep(Duration::from_millis(500)).await;
                break;
            }
        };

        match msg_result {
            Some(Ok(Message::Text(text))) => {
                // Validate overall message size at the JSON level
                if text.len() > config.max_message_size {
                    warn!(
                        "[signaling] oversized message from {addr}: {} bytes",
                        text.len()
                    );
                    send_json(&tx, &err("message_too_large", "Message exceeds size limit"));
                    continue;
                }

                let msg: ClientMessage = match serde_json::from_str(&text) {
                    Ok(m) => m,
                    Err(e) => {
                        // Don't echo full parse error — could leak internals
                        warn!("[signaling] JSON parse error from {addr}: {e}");
                        send_json(&tx, &err("parse_error", "Invalid message format"));
                        continue;
                    }
                };

                match msg {
                    ClientMessage::Create {
                        room,
                        password,
                        username,
                        features,
                        persistent,
                        ..
                    } => {
                        // Validate room name
                        if !valid_name(&room, 1, config.max_room_name_len) {
                            send_json(
                                &tx,
                                &err(
                                    "invalid_name",
                                    &format!(
                                        "Room name must be 1-{} printable ASCII characters",
                                        config.max_room_name_len
                                    ),
                                ),
                            );
                            continue;
                        }
                        // Validate username
                        if !valid_name(&username, 1, config.max_username_len) {
                            send_json(
                                &tx,
                                &err(
                                    "invalid_name",
                                    &format!(
                                        "Username must be 1-{} printable ASCII characters",
                                        config.max_username_len
                                    ),
                                ),
                            );
                            continue;
                        }
                        // Validate password length
                        if password.len() > config.max_password_len {
                            send_json(
                                &tx,
                                &err(
                                    "invalid_password",
                                    &format!(
                                        "Password must be at most {} bytes",
                                        config.max_password_len
                                    ),
                                ),
                            );
                            continue;
                        }
                        // Validate features count
                        if features.len() > config.max_features {
                            send_json(
                                &tx,
                                &err(
                                    "too_many_features",
                                    &format!("Maximum {} features allowed", config.max_features),
                                ),
                            );
                            continue;
                        }

                        // Check max rooms limit
                        if rooms.len() >= config.max_rooms {
                            send_json(&tx, &err("server_full", "Maximum number of rooms reached"));
                            continue;
                        }

                        // Use generic error — don't reveal whether room exists
                        if rooms.contains_key(&room) {
                            send_json(&tx, &err("invalid_request", "Cannot create room"));
                            continue;
                        }

                        let pid = make_peer_id();
                        let p = PeerInfo {
                            id: pid.clone(),
                            username: username.clone(),
                            features,
                            tx: tx.clone(),
                        };

                        let mut peers_map = HashMap::new();
                        peers_map.insert(pid.clone(), p);
                        let join_order = vec![pid.clone()];
                        let room_obj = Arc::new(Mutex::new(Room {
                            password: if password.is_empty() {
                                None
                            } else {
                                Some(password)
                            },
                            host_id: pid.clone(),
                            peers: peers_map,
                            join_order,
                            persistent,
                        }));

                        rooms.insert(room.clone(), room_obj);
                        peer_id = Some(pid.clone());
                        room_name = Some(room.clone());
                        authenticated = true;

                        send_json(
                            &tx,
                            &ServerMessage::Created {
                                room_id: room.clone(),
                                host_id: pid.clone(),
                                peer_id: pid.clone(),
                                peers: vec![],
                            },
                        );

                        info!("[room] created: {room}  host: {pid}  user: {username}");
                    }

                    ClientMessage::Join {
                        room,
                        password,
                        username,
                        features,
                    } => {
                        // Validate room name (was missing on Join!)
                        if !valid_name(&room, 1, config.max_room_name_len) {
                            send_json(
                                &tx,
                                &err(
                                    "invalid_name",
                                    &format!(
                                        "Room name must be 1-{} printable ASCII characters",
                                        config.max_room_name_len
                                    ),
                                ),
                            );
                            continue;
                        }
                        // Validate username
                        if !valid_name(&username, 1, config.max_username_len) {
                            send_json(
                                &tx,
                                &err(
                                    "invalid_name",
                                    &format!(
                                        "Username must be 1-{} printable ASCII characters",
                                        config.max_username_len
                                    ),
                                ),
                            );
                            continue;
                        }
                        // Validate password length
                        if password.len() > config.max_password_len {
                            send_json(
                                &tx,
                                &err(
                                    "invalid_password",
                                    &format!(
                                        "Password must be at most {} bytes",
                                        config.max_password_len
                                    ),
                                ),
                            );
                            continue;
                        }
                        // Validate features count
                        if features.len() > config.max_features {
                            send_json(
                                &tx,
                                &err(
                                    "too_many_features",
                                    &format!("Maximum {} features allowed", config.max_features),
                                ),
                            );
                            continue;
                        }

                        let room_obj = match rooms.get(&room) {
                            Some(r) => r.clone(),
                            None => {
                                // Generic error — don't distinguish between "not found" and "wrong password"
                                send_json(&tx, &err("invalid_request", "Cannot join room"));
                                continue;
                            }
                        };

                        {
                            let r = room_obj.lock();
                            if let Some(pwd) = &r.password {
                                // Constant-time comparison to prevent timing side-channel
                                if !constant_time_eq(pwd.as_bytes(), password.as_bytes()) {
                                    // Generic error — same as room not found
                                    send_json(&tx, &err("invalid_request", "Cannot join room"));
                                    continue;
                                }
                            }
                            if r.peers.values().any(|p| p.username == username) {
                                // Don't reveal whether username is taken
                                send_json(&tx, &err("invalid_request", "Cannot join room"));
                                continue;
                            }
                            if r.peers.len() >= config.max_peers_per_room {
                                send_json(
                                    &tx,
                                    &err(
                                        "room_full",
                                        &format!(
                                            "Room is full (max {} peers)",
                                            config.max_peers_per_room
                                        ),
                                    ),
                                );
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

                            let p = PeerInfo {
                                id: pid.clone(),
                                username: username.clone(),
                                features: features.clone(),
                                tx: tx.clone(),
                            };
                            r.peers.insert(pid.clone(), p);
                            r.join_order.push(pid.clone());
                        }

                        peer_id = Some(pid.clone());
                        room_name = Some(room.clone());
                        authenticated = true;

                        send_json(
                            &tx,
                            &ServerMessage::RoomInfo {
                                room_id: room.clone(),
                                host_id: host_id.clone(),
                                peer_id: pid.clone(),
                                peers: existing_peers,
                            },
                        );

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

                        info!(
                            "[room] {room}: {username} joined  ({} peers)",
                            room_obj.lock().peers.len()
                        );
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
                            if now.duration_since(signal_window_start).as_millis() as u64
                                > SIGNAL_WINDOW_MS
                            {
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
                                warn!(
                                    "[signal] oversized payload from {pid}: {} bytes",
                                    payload_json.len()
                                );
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
                                            match sfu
                                                .handle_offer(rname, pid, &username, &payload.sdp)
                                                .await
                                            {
                                                Ok(answer_sdp) => {
                                                    send_json(
                                                        &tx,
                                                        &ServerMessage::SignalRelay {
                                                            from: "_server".into(),
                                                            payload: SignalPayload {
                                                                kind: "answer".into(),
                                                                sdp: answer_sdp,
                                                                candidate: String::new(),
                                                                sdp_mid: String::new(),
                                                                sdp_mline_index: 0,
                                                            },
                                                        },
                                                    );
                                                }
                                                Err(e) => {
                                                    warn!("[sfu] offer failed: {e}");
                                                    send_json(
                                                        &tx,
                                                        &err(
                                                            "sfu_error",
                                                            &format!("Offer failed: {e}"),
                                                        ),
                                                    );
                                                }
                                            }
                                        }
                                        "ice" | "ice-candidate" => {
                                            if let Err(e) = sfu
                                                .handle_ice(
                                                    rname,
                                                    pid,
                                                    &payload.candidate,
                                                    &payload.sdp_mid,
                                                    payload.sdp_mline_index,
                                                )
                                                .await
                                            {
                                                warn!("[sfu] ICE failed: {e}");
                                                // Send error feedback to client
                                                send_json(
                                                    &tx,
                                                    &err("sfu_error", &format!("ICE failed: {e}")),
                                                );
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
                        let room_list: Vec<serde_json::Value> = rooms
                            .iter()
                            .map(|entry| {
                                let room_name = entry.key().clone();
                                let room = entry.value().lock();
                                serde_json::json!({
                                    "room": room_name,
                                    "peers": room.peers.len(),
                                    "has_password": room.password.is_some(),
                                })
                            })
                            .collect();
                        send_json(&tx, &ServerMessage::RoomList { rooms: room_list });
                        continue;
                    }
                }
            }
            Some(Ok(Message::Ping(_data))) => {
                // tokio-tungstenite auto-responds with Pong — nothing to do
            }
            Some(Ok(Message::Pong(_))) => {
                // Received pong — connection is alive, nothing to do
            }
            Some(Ok(Message::Close(_))) | None => {
                break;
            }
            Some(Err(e)) => {
                warn!("[signaling] WebSocket error from {addr}: {e}");
                break;
            }
            _ => {}
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

    if let Err(e) = done_tx.try_send(()) {
        warn!("[room] cleanup done signal send failed (receiver dropped): {e}");
    }
    if let Err(e) = write_handle.await {
        warn!("[room] write task join error during cleanup: {e}");
    }
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
        assert_eq!(server.active_connections(), 0);
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

    #[test]
    fn test_config_defaults() {
        let config = SignalingConfig::default();
        assert_eq!(config.max_connections_per_ip, 50);
        assert_eq!(config.max_connections_total, 5000);
        assert_eq!(config.max_peers_per_room, 100);
        assert_eq!(config.max_password_len, 256);
        assert_eq!(config.max_features, 100);
    }

    #[test]
    fn test_connection_tracker_accept_and_release() {
        let tracker = ConnectionTracker::new();
        let config = SignalingConfig {
            max_connections_per_ip: 2,
            max_connections_total: 10,
            connection_rate_per_ip: 100,
            ..Default::default()
        };
        let ip = "192.168.1.1".parse::<IpAddr>().unwrap();

        // Accept first connection
        assert!(tracker.try_accept(ip, &config).is_ok());
        assert_eq!(tracker.active_connections(), 1);

        // Accept second connection
        assert!(tracker.try_accept(ip, &config).is_ok());
        assert_eq!(tracker.active_connections(), 2);

        // Third should be rejected (per-IP limit)
        assert!(tracker.try_accept(ip, &config).is_err());

        // Release one
        tracker.release(ip);
        assert_eq!(tracker.active_connections(), 1);

        // Now we should be able to accept again
        assert!(tracker.try_accept(ip, &config).is_ok());
        assert_eq!(tracker.active_connections(), 2);
    }

    #[test]
    fn test_connection_tracker_global_limit() {
        let tracker = ConnectionTracker::new();
        let config = SignalingConfig {
            max_connections_per_ip: 100,
            max_connections_total: 3,
            connection_rate_per_ip: 100,
            ..Default::default()
        };

        let ip1 = "10.0.0.1".parse::<IpAddr>().unwrap();
        let ip2 = "10.0.0.2".parse::<IpAddr>().unwrap();

        assert!(tracker.try_accept(ip1, &config).is_ok());
        assert!(tracker.try_accept(ip1, &config).is_ok());
        assert!(tracker.try_accept(ip2, &config).is_ok());

        // Fourth should be rejected (global limit)
        assert!(tracker.try_accept(ip2, &config).is_err());
    }

    #[test]
    fn test_connection_tracker_rate_limit() {
        let tracker = ConnectionTracker::new();
        let config = SignalingConfig {
            max_connections_per_ip: 100,
            max_connections_total: 100,
            connection_rate_per_ip: 3,
            connection_rate_window: Duration::from_secs(10),
            ..Default::default()
        };

        let ip = "10.0.0.1".parse::<IpAddr>().unwrap();

        assert!(tracker.try_accept(ip, &config).is_ok());
        assert!(tracker.try_accept(ip, &config).is_ok());
        assert!(tracker.try_accept(ip, &config).is_ok());

        // Fourth in the same window should be rejected
        assert!(tracker.try_accept(ip, &config).is_err());
    }

    #[test]
    fn test_valid_name() {
        assert!(valid_name("hello", 1, 32));
        assert!(valid_name("Hello World", 1, 32));
        assert!(valid_name("a", 1, 32));
        assert!(!valid_name("", 1, 32));
        assert!(!valid_name("hello\n", 1, 32));
        assert!(!valid_name("hello\tworld", 1, 32));
        // Non-ASCII
        assert!(!valid_name("héllo", 1, 32));
        // Too long
        assert!(!valid_name(
            "abcdefghijklmnopqrstuvwxyz0123456789---",
            1,
            32
        ));
    }

    #[test]
    fn test_constant_time_eq() {
        assert!(constant_time_eq(b"password", b"password"));
        assert!(!constant_time_eq(b"password", b"password1"));
        assert!(!constant_time_eq(b"short", b"longer"));
        assert!(!constant_time_eq(b"", b"x"));
        assert!(constant_time_eq(b"", b""));
    }
}
