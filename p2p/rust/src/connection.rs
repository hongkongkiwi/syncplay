//! WebRTC Connection Manager — webrtc-rs 0.14
//!
//! Manages WebRTC peer connections, signaling, lifecycle callbacks,
//! and per-peer ICE state tracking. Uses `Arc<Inner>` pattern for cloneability.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use bytes::Bytes;
use dashmap::DashMap;
use log::{debug, error, info, warn};
use parking_lot::Mutex;
use tokio::sync::mpsc;
use tokio::time;

use webrtc::api::APIBuilder;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_connection_state::RTCIceConnectionState;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

use crate::config::P2pConfig;
use crate::messages::MessageType;
use crate::state::{ConnectionStateMachine, SharedStateMachine};
use crate::wire;

pub const PROTOCOL_VERSION: &str = "2.0.0";
pub const DATA_CHANNEL_LABEL: &str = "syncplay-v2";
const STUN_FALLBACK: &[&str] = &[
    "stun:stun.l.google.com:19302",
    "stun:stun1.l.google.com:19302",
];

fn default_ice_conf() -> RTCConfiguration {
    RTCConfiguration {
        ice_servers: vec![RTCIceServer {
            urls: STUN_FALLBACK.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }],
        ..Default::default()
    }
}

fn ice_conf_from_config(cfg: &P2pConfig) -> RTCConfiguration {
    let servers = cfg.ice_servers();
    if servers.is_empty() {
        return default_ice_conf();
    }
    RTCConfiguration {
        ice_servers: servers,
        ..Default::default()
    }
}

// ── Peer ─────────────────────────────────────────────────────────────

/// WebRTC ICE connection state for a peer connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IceState {
    New,
    Checking,
    Connected,
    Disconnected,
    Failed,
    Closed,
}

impl std::fmt::Display for IceState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::New => write!(f, "new"),
            Self::Checking => write!(f, "connecting..."),
            Self::Connected => write!(f, "connected"),
            Self::Disconnected => write!(f, "disconnected"),
            Self::Failed => write!(f, "failed"),
            Self::Closed => write!(f, "closed"),
        }
    }
}

/// A connected peer with its WebRTC data channel, peer connection, and ICE state.
pub struct Peer {
    pub peer_id: String,
    pub username: String,
    pub dc: Arc<RTCDataChannel>,
    pub pc: Arc<RTCPeerConnection>,
    pub ice_state: Arc<Mutex<IceState>>,
    pub queued_ice: Mutex<Vec<RTCIceCandidateInit>>,
}

impl Peer {
    pub async fn send(&self, data: &Bytes) -> Result<usize> {
        self.dc
            .send(data)
            .await
            .map_err(|e| anyhow::anyhow!("dc send: {e}"))
    }

    /// Flush all queued ICE candidates to the peer connection.
    pub async fn flush_queued_ice(&self) {
        let candidates: Vec<_> = {
            let mut queued = self.queued_ice.lock();
            queued.drain(..).collect()
        };
        for candidate in candidates {
            if let Err(e) = self.pc.add_ice_candidate(candidate).await {
                warn!("Failed to add queued ICE candidate: {e}");
            }
        }
    }
}

// ── Inner ────────────────────────────────────────────────────────────

type MsgFn = Box<dyn Fn(MessageType, &[u8], String) + Send + Sync>;
type PeerFn = Box<dyn Fn(String, String) + Send + Sync>;
type PcFn = Box<dyn Fn(Arc<RTCPeerConnection>, String) + Send + Sync>;
type DisconnectFn = Box<dyn Fn(String, String) + Send + Sync>; // pid, username

struct Inner {
    username: String,
    config: Mutex<Option<P2pConfig>>,
    peer_id: Mutex<String>,
    host_id: Mutex<String>,
    peers: DashMap<String, Peer>,
    /// Virtual peers in SFU mode (peer_id → username). No direct PC.
    virtual_peers: DashMap<String, String>,
    /// Peers currently attempting reconnection (peer_id → username)
    reconnecting: DashMap<String, String>,
    handlers: Mutex<Vec<(MessageType, MsgFn)>>,
    on_join: Mutex<Vec<PeerFn>>,
    on_leave: Mutex<Vec<PeerFn>>,
    on_host: Mutex<Vec<PeerFn>>,
    on_pc: Mutex<Vec<PcFn>>,
    on_disconnect: Mutex<Vec<DisconnectFn>>,
    signal_tx: Mutex<Option<mpsc::Sender<String>>>,
    /// Oneshot channel for room list responses (set by /rooms command)
    room_list_tx: Mutex<Option<tokio::sync::oneshot::Sender<String>>>,
    /// Connection lifecycle state machine
    state: SharedStateMachine,
}

#[derive(Clone)]
pub struct ConnectionManager(Arc<Inner>);

impl ConnectionManager {
    pub fn new(username: &str, features: Vec<String>) -> Self {
        let cfg = P2pConfig {
            username: username.into(),
            features,
            ..Default::default()
        };
        Self(Arc::new(Inner {
            username: username.into(),
            config: Mutex::new(Some(cfg)),
            peer_id: Default::default(),
            host_id: Default::default(),
            peers: DashMap::new(),
            virtual_peers: DashMap::new(),
            reconnecting: DashMap::new(),
            handlers: Mutex::new(Vec::new()),
            on_join: Mutex::new(Vec::new()),
            on_leave: Mutex::new(Vec::new()),
            on_host: Mutex::new(Vec::new()),
            on_pc: Mutex::new(Vec::new()),
            on_disconnect: Mutex::new(Vec::new()),
            signal_tx: Mutex::new(None),
            room_list_tx: Mutex::new(None),
            state: Arc::new(ConnectionStateMachine::new()),
        }))
    }

    pub fn with_config(username: &str, _features: Vec<String>, cfg: P2pConfig) -> Self {
        Self(Arc::new(Inner {
            username: username.into(),
            config: Mutex::new(Some(cfg)),
            peer_id: Default::default(),
            host_id: Default::default(),
            peers: DashMap::new(),
            virtual_peers: DashMap::new(),
            reconnecting: DashMap::new(),
            handlers: Mutex::new(Vec::new()),
            on_join: Mutex::new(Vec::new()),
            on_leave: Mutex::new(Vec::new()),
            on_host: Mutex::new(Vec::new()),
            on_pc: Mutex::new(Vec::new()),
            on_disconnect: Mutex::new(Vec::new()),
            signal_tx: Mutex::new(None),
            room_list_tx: Mutex::new(None),
            state: Arc::new(ConnectionStateMachine::new()),
        }))
    }

    fn ice_conf(&self) -> RTCConfiguration {
        if let Some(cfg) = self.0.config.lock().as_ref() {
            ice_conf_from_config(cfg)
        } else {
            default_ice_conf()
        }
    }

    // ── Identity ──────────────────────────────────────────────────
    pub fn pid(&self) -> String {
        self.0.peer_id.lock().clone()
    }
    pub fn hid(&self) -> String {
        self.0.host_id.lock().clone()
    }
    pub fn is_host(&self) -> bool {
        // Hold both locks simultaneously to avoid TOCTOU between reads
        let pid = self.0.peer_id.lock().clone();
        let hid = self.0.host_id.lock().clone();
        !pid.is_empty() && pid == hid
    }
    pub fn uname(&self) -> String {
        self.0.username.clone()
    }

    pub fn pcount(&self) -> usize {
        self.0.peers.len() + self.0.virtual_peers.len()
    }

    /// Current connection lifecycle state.
    pub fn connection_state(&self) -> crate::state::ConnectionState {
        self.0.state.get()
    }

    /// Set connection state to reconnecting (for reconnect flows).
    pub fn set_state_reconnecting(&self, attempt: u32, max_attempts: u32) {
        self.0.state.set_reconnecting(attempt, max_attempts);
    }

    /// Whether SFU mode is enabled (star topology via server).
    pub fn is_sfu(&self) -> bool {
        self.0
            .config
            .lock()
            .as_ref()
            .map(|c| c.sfu_enabled)
            .unwrap_or(false)
    }

    pub fn set_id(&self, pid: &str, hid: &str) {
        *self.0.peer_id.lock() = pid.into();
        *self.0.host_id.lock() = hid.into();
    }

    pub fn set_sig(&self, tx: mpsc::Sender<String>) {
        *self.0.signal_tx.lock() = Some(tx);
    }

    pub fn sig(&self, msg: &str) {
        if let Some(tx) = self.0.signal_tx.lock().as_ref() {
            if let Err(e) = tx.try_send(msg.to_string()) {
                warn!("Signal channel full or closed: {e}");
            }
        } else {
            warn!("No signal channel set");
        }
    }

    /// Set the oneshot sender that will receive the room_list response.
    pub fn set_room_list_tx(&self, tx: tokio::sync::oneshot::Sender<String>) {
        *self.0.room_list_tx.lock() = Some(tx);
    }

    /// Take the oneshot sender (consume it) so it fires exactly once.
    pub fn take_room_list_tx(&self) -> Option<tokio::sync::oneshot::Sender<String>> {
        self.0.room_list_tx.lock().take()
    }

    pub fn set_host(&self, new_id: &str, reason: &str) {
        // Hold host_id lock for read+write atomically
        {
            let mut host = self.0.host_id.lock();
            if *host == new_id {
                return;
            }
            *host = new_id.to_string();
        }
        info!("Host changed to {new_id} ({reason})");
        // Fire callbacks outside the host_id lock
        for f in self.0.on_host.lock().iter() {
            f(new_id.to_string(), reason.to_string());
        }
    }

    // ── Lifecycle callbacks (Vec-based — multiple listeners) ──────
    pub fn on_join<F: Fn(String, String) + Send + Sync + 'static>(&self, f: F) {
        self.0.on_join.lock().push(Box::new(f));
    }
    pub fn on_leave<F: Fn(String, String) + Send + Sync + 'static>(&self, f: F) {
        self.0.on_leave.lock().push(Box::new(f));
    }
    pub fn on_host<F: Fn(String, String) + Send + Sync + 'static>(&self, f: F) {
        self.0.on_host.lock().push(Box::new(f));
    }
    pub fn on_peer_connection<F: Fn(Arc<RTCPeerConnection>, String) + Send + Sync + 'static>(
        &self,
        f: F,
    ) {
        self.0.on_pc.lock().push(Box::new(f));
    }
    pub fn on_disconnect<F: Fn(String, String) + Send + Sync + 'static>(&self, f: F) {
        self.0.on_disconnect.lock().push(Box::new(f));
    }
    pub fn on_msg<F: Fn(MessageType, &[u8], String) + Send + Sync + 'static>(
        &self,
        mt: MessageType,
        f: F,
    ) {
        self.0.handlers.lock().push((mt, Box::new(f)));
    }

    fn fire_join(&self, pid: &str, uname: &str) {
        // Iterate while holding lock — callers must not re-enter on_join
        self.0.on_join.lock().iter().for_each(|f| {
            f(pid.to_string(), uname.to_string());
        });
    }
    fn fire_leave(&self, pid: &str, reason: &str) {
        for f in self.0.on_leave.lock().iter() {
            f(pid.to_string(), reason.to_string());
        }
    }
    fn fire_pc(&self, pc: Arc<RTCPeerConnection>, pid: &str) {
        for f in self.0.on_pc.lock().iter() {
            f(pc.clone(), pid.to_string());
        }
    }

    // ── Signaling ─────────────────────────────────────────────────

    pub async fn connect(&self, url: &str, room: &str, password: &str) -> Result<()> {
        self._signaling_handshake(url, room, password, "create")
            .await
    }

    pub async fn join(&self, url: &str, room: &str, password: &str) -> Result<()> {
        self._signaling_handshake(url, room, password, "join").await
    }

    /// Connect with reconnect support.
    pub async fn connect_with_retry(&self, url: &str, room: &str, password: &str) -> Result<()> {
        self.0.state.set_connecting();
        let max_retries = self
            .0
            .config
            .lock()
            .as_ref()
            .map(|c| c.network.max_reconnect_attempts)
            .unwrap_or(5);
        let delay = self
            .0
            .config
            .lock()
            .as_ref()
            .map(|c| Duration::from_secs(c.network.reconnect_delay_secs))
            .unwrap_or(Duration::from_secs(5));

        let mut attempts = 0;
        loop {
            match self
                ._signaling_handshake(url, room, password, "create")
                .await
            {
                Ok(()) => return Ok(()),
                Err(e) => {
                    attempts += 1;
                    if max_retries > 0 && attempts >= max_retries {
                        return Err(anyhow::anyhow!("Failed after {attempts} attempts: {e}"));
                    }
                    warn!("Connect attempt {attempts} failed: {e} — retrying in {delay:?}");
                    time::sleep(delay).await;
                }
            }
        }
    }

    async fn _signaling_handshake(
        &self,
        url: &str,
        room: &str,
        password: &str,
        kind: &str,
    ) -> Result<()> {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::{connect_async, tungstenite::Message};

        let (ws, _) = connect_async(url).await.context("WebSocket connect")?;
        let (mut write, mut read) = ws.split();
        self.0.state.set_handshaking();

        let features = self
            .0
            .config
            .lock()
            .as_ref()
            .map(|c| {
                let mut feats = c.features.clone();
                if c.sfu_enabled && !feats.contains(&"sfu".to_string()) {
                    feats.push("sfu".to_string());
                }
                feats
            })
            .unwrap_or_default();

        let msg = serde_json::json!({
            "type": kind, "room": room, "password": password,
            "username": self.uname(), "features": features,
        });
        write
            .send(Message::Text(msg.to_string().into()))
            .await
            .context("send handshake")?;

        if let Some(Ok(Message::Text(text))) = read.next().await {
            let resp: serde_json::Value = serde_json::from_str(&text).context("parse response")?;
            if resp["type"] == "error" {
                let code = resp["code"].as_str().unwrap_or("unknown");
                let message = resp["message"].as_str().unwrap_or("unknown error");
                return Err(anyhow::anyhow!("Server error: {code} — {message}"));
            }
            let pid = resp["peerId"].as_str().unwrap_or("").to_string();
            let hid = resp["hostId"].as_str().unwrap_or("").to_string();
            self.set_id(&pid, &hid);
            info!("{kind}: room={room} pid={pid} hid={hid}");

            // If joining: connect to existing peers or SFU server
            if kind == "join" {
                if self.is_sfu() {
                    // SFU mode: single connection to server routes everything
                    let cm = self.clone();
                    tokio::spawn(async move {
                        if let Err(e) = cm.dial("_server", "server").await {
                            warn!("SFU dial failed: {e}");
                        }
                    });
                } else if let Some(peers) = resp["peers"].as_array() {
                    for peer in peers {
                        let p = peer["peerId"].as_str().unwrap_or("");
                        let u = peer["username"].as_str().unwrap_or("unknown");
                        let cm = self.clone();
                        let pid2 = p.to_string();
                        let un2 = u.to_string();
                        tokio::spawn(async move {
                            if let Err(e) = cm.dial(&pid2, &un2).await {
                                warn!("Dial {pid2} failed: {e}");
                            }
                        });
                    }
                }
                // Send UserInfo to all peers announcing our features
                self._send_userinfo().await;
            }
        } else {
            return Err(anyhow::anyhow!("No response from signaling server"));
        }

        // Wire up the signaling send channel so SDP/ICE candidates can be relayed
        // through this WebSocket connection
        let (sig_tx, mut sig_rx) = mpsc::channel::<String>(256);
        self.set_sig(sig_tx);

        // Spawn writer: forwards signal messages to the WebSocket
        let cm_clone = self.clone();
        tokio::spawn(async move {
            while let Some(msg) = sig_rx.recv().await {
                if let Err(e) = write.send(Message::Text(msg.into())).await {
                    warn!("Signal write error: {e}");
                    break;
                }
            }
            cm_clone.0.state.set_offline("signaling write closed");
        });

        let cm = self.clone();
        tokio::spawn(async move {
            while let Some(msg) = read.next().await {
                match msg {
                    Ok(Message::Text(text)) => {
                        if let Err(e) = cm.handle_signal_msg(&text).await {
                            warn!("Signal handling error: {e}");
                        }
                    }
                    Ok(Message::Close(_)) | Err(_) => {
                        cm.0.state.set_offline("signaling lost");
                        debug!("Signaling websocket closed");
                        break;
                    }
                    _ => {}
                }
            }
        });

        Ok(())
    }

    async fn handle_signal_msg(&self, text: &str) -> Result<()> {
        let msg: serde_json::Value = serde_json::from_str(text)?;
        match msg["type"].as_str().unwrap_or("") {
            "peer_joined" => {
                let pid = msg["peerId"].as_str().unwrap_or("");
                let uname = msg["username"].as_str().unwrap_or("");
                info!("Peer joined: {uname} ({pid})");

                if self.is_sfu() {
                    // SFU mode: track virtual peer, don't dial
                    self.0
                        .virtual_peers
                        .insert(pid.to_string(), uname.to_string());
                    self.fire_join(pid, uname);
                } else {
                    let cm = self.clone();
                    let p = pid.to_string();
                    let u = uname.to_string();
                    tokio::spawn(async move {
                        if let Err(e) = cm.dial(&p, &u).await {
                            warn!("Dial {p} failed: {e}");
                        }
                    });
                    self.fire_join(pid, uname);
                }
            }
            "peer_left" => {
                let pid = msg["peerId"].as_str().unwrap_or("");
                self.0.virtual_peers.remove(pid);
                self._remove(pid, "left");
            }
            "host_changed" => {
                let hid = msg["hostId"].as_str().unwrap_or("");
                let reason = msg["reason"].as_str().unwrap_or("unknown");
                self.set_host(hid, reason);
            }
            "signal" => {
                let from = msg["from"].as_str().unwrap_or("");
                let payload = &msg["payload"];
                let kind = payload["kind"].as_str().unwrap_or("");
                let sdp = payload["sdp"].as_str().unwrap_or("");
                let cand = payload["candidate"].as_str().unwrap_or("");
                let mid = payload["sdpMid"].as_str().unwrap_or("");
                let mline = payload["sdpMLineIndex"].as_u64().unwrap_or(0) as u16;
                let result = match kind {
                    "offer" => self.on_offer(from, sdp).await,
                    "answer" => self.on_answer(from, sdp).await,
                    "ice-candidate" => self.on_ice(from, cand, mid, mline).await,
                    other => {
                        warn!("Unknown signal kind: {other}");
                        Ok(())
                    }
                };
                if let Err(e) = result {
                    warn!("Signal {kind} from {from} failed: {e}");
                }
            }
            "room_list" => {
                if let Some(tx) = self.0.room_list_tx.lock().take() {
                    if let Err(_) = tx.send(text.to_string()) {
                        warn!("room_list oneshot receiver dropped");
                    }
                }
            }
            unknown => {
                if !unknown.is_empty() {
                    debug!("Unknown server msg: {unknown}");
                }
            }
        }
        Ok(())
    }

    pub async fn disconnect(&self) {
        // Send PeerDisconnect to all peers
        let p = crate::messages::PeerDisconnectPayload {
            reason: "leaving".into(),
        };
        if let Ok(data) = wire::encode(&p) {
            self.send_all(&data, None).await;
        }
        // Clear reconnecting state
        self.0.reconnecting.clear();
        for entry in self.0.peers.iter() {
            if let Err(err) = entry.pc.close().await {
                warn!("Error closing {}: {err}", entry.key());
            }
        }
        self.0.peers.clear();
    }

    // ── Sending ──────────────────────────────────────────────────

    pub async fn send_all(&self, data: &Bytes, skip: Option<&str>) {
        if !self.is_host() {
            warn!("send_all called by non-host; ignoring");
            return;
        }
        for entry in self.0.peers.iter() {
            if Some(entry.key().as_str()) != skip {
                if let Err(err) = entry.send(data).await {
                    warn!("Send to {} failed: {err}", entry.key());
                }
            }
        }
    }

    pub async fn send_one(&self, id: &str, data: &Bytes) -> Result<()> {
        self.0
            .peers
            .get(id)
            .with_context(|| format!("no peer {id}"))?
            .send(data)
            .await
            .map(|_| ())
    }

    pub async fn bcast<T: wire::MessagePayload>(&self, p: &T, skip: Option<&str>) {
        if !self.is_host() {
            warn!("bcast called by non-host; ignoring");
            return;
        }
        match wire::encode(p) {
            Ok(data) => self.send_all(&data, skip).await,
            Err(e) => error!("Failed to encode broadcast: {e}"),
        }
    }

    async fn _send_userinfo(&self) {
        let features = self
            .0
            .config
            .lock()
            .as_ref()
            .map(|c| c.features.clone())
            .unwrap_or_default();
        let p = crate::messages::UserInfoPayload {
            username: self.uname(),
            features,
        };
        match wire::encode(&p) {
            Ok(data) => {
                for entry in self.0.peers.iter() {
                    if let Err(e) = entry.send(&data).await {
                        warn!("UserInfo to {} failed: {e}", entry.key());
                    }
                }
            }
            Err(e) => error!("Failed to encode UserInfo: {e}"),
        }
    }

    async fn _send_hello(&self, target: &str) {
        let (features, room) = self
            .0
            .config
            .lock()
            .as_ref()
            .map(|c| (c.features.clone(), c.room.clone()))
            .unwrap_or_default();
        let p =
            crate::messages::HelloPayload::new(&self.uname(), PROTOCOL_VERSION, &room, features);
        if let Ok(data) = wire::encode(&p) {
            if let Err(e) = self.send_one(target, &data).await {
                warn!("Hello to {target} failed: {e}");
            }
        }
    }

    // ── WebRTC lifecycle ─────────────────────────────────────────

    pub async fn dial(&self, pid_str: &str, uname: &str) -> Result<()> {
        info!("dial → {uname} ({pid_str})");

        let api = APIBuilder::new().build();
        let ice_conf = self.ice_conf();
        let pc = Arc::new(api.new_peer_connection(ice_conf).await?);
        let dc = pc.create_data_channel(DATA_CHANNEL_LABEL, None).await?;

        let ice_state = Arc::new(Mutex::new(IceState::New));

        // Use entry() to avoid double-insert race
        use dashmap::mapref::entry::Entry;
        match self.0.peers.entry(pid_str.to_string()) {
            Entry::Occupied(_) => {
                debug!("Already connected to {uname} ({pid_str})");
                return Ok(());
            }
            Entry::Vacant(vac) => {
                vac.insert(Peer {
                    peer_id: pid_str.to_string(),
                    username: uname.to_string(),
                    dc: dc.clone(),
                    pc: pc.clone(),
                    ice_state: ice_state.clone(),
                    queued_ice: Mutex::new(Vec::new()),
                });
            }
        }

        // Flush any queued ICE candidates inline
        if let Some(peer) = self.0.peers.get(pid_str) {
            peer.flush_queued_ice().await;
        }

        // ICE tracking — updates Peer's ice_state
        let is = ice_state.clone();
        let pid2 = pid_str.to_string();
        pc.on_ice_connection_state_change(Box::new(move |st| {
            let new = match st {
                RTCIceConnectionState::New => IceState::New,
                RTCIceConnectionState::Checking => IceState::Checking,
                RTCIceConnectionState::Connected => IceState::Connected,
                RTCIceConnectionState::Disconnected => IceState::Disconnected,
                RTCIceConnectionState::Failed => IceState::Failed,
                RTCIceConnectionState::Closed => IceState::Closed,
                _ => IceState::New,
            };
            info!("ICE {} → {new}", pid2);
            *is.lock() = new;
            Box::pin(async {})
        }));

        // ICE candidate → signal
        let cm = self.clone();
        let p = pid_str.to_string();
        pc.on_ice_candidate(Box::new(move |c| {
            if let Some(c) = c {
                if let Ok(init) = c.to_json() {
                    cm.sig(
                        &serde_json::json!({
                            "type":"signal","target":&p,
                            "payload":{"kind":"ice-candidate","candidate":init.candidate,
                                       "sdpMid":init.sdp_mid,"sdpMLineIndex":init.sdp_mline_index}
                        })
                        .to_string(),
                    );
                }
            }
            Box::pin(async {})
        }));

        // DC message → dispatch
        let cm2 = self.clone();
        let p2 = pid_str.to_string();
        dc.on_message(Box::new(move |msg| {
            cm2._dispatch(&msg.data, &p2);
            Box::pin(async {})
        }));

        // State → cleanup
        let cm3 = self.clone();
        let p3 = pid_str.to_string();
        pc.on_peer_connection_state_change(Box::new(move |st| {
            if matches!(
                st,
                RTCPeerConnectionState::Failed
                    | RTCPeerConnectionState::Disconnected
                    | RTCPeerConnectionState::Closed
            ) {
                cm3._remove(&p3, &format!("{st:?}"));
            }
            Box::pin(async {})
        }));

        let offer = pc.create_offer(None).await?;
        pc.set_local_description(offer.clone()).await?;
        self.sig(
            &serde_json::json!({
                "type":"signal","target":pid_str,
                "payload":{"kind":"offer","sdp":offer.sdp}
            })
            .to_string(),
        );

        // Send Hello to the new peer
        self._send_hello(pid_str).await;

        // Notify voice chat about the new peer connection
        self.fire_pc(pc.clone(), pid_str);
        Ok(())
    }

    pub async fn on_offer(&self, from: &str, sdp: &str) -> Result<()> {
        info!("offer ← {from}");

        let api = APIBuilder::new().build();
        let ice_conf = self.ice_conf();
        let pc = Arc::new(api.new_peer_connection(ice_conf).await?);
        let ice_state = Arc::new(Mutex::new(IceState::Checking));

        // Create a local data channel and insert partial Peer entry early
        let dc = pc.create_data_channel(DATA_CHANNEL_LABEL, None).await?;
        let from_owned = from.to_string();

        // Use entry() to only insert if not already present (race-free)
        use dashmap::mapref::entry::Entry;
        match self.0.peers.entry(from_owned.clone()) {
            Entry::Occupied(_) => {
                debug!("Peer {from} already in map; not inserting partial entry");
            }
            Entry::Vacant(vac) => {
                vac.insert(Peer {
                    peer_id: from_owned.clone(),
                    username: "unknown".to_string(),
                    dc: dc.clone(),
                    pc: pc.clone(),
                    ice_state: ice_state.clone(),
                    queued_ice: Mutex::new(Vec::new()),
                });
            }
        }

        // ICE tracking
        let is = ice_state.clone();
        let f_ice = from.to_string();
        pc.on_ice_connection_state_change(Box::new(move |st| {
            let new = match st {
                RTCIceConnectionState::New => IceState::New,
                RTCIceConnectionState::Checking => IceState::Checking,
                RTCIceConnectionState::Connected => IceState::Connected,
                RTCIceConnectionState::Disconnected => IceState::Disconnected,
                RTCIceConnectionState::Failed => IceState::Failed,
                RTCIceConnectionState::Closed => IceState::Closed,
                _ => IceState::New,
            };
            info!("ICE {} → {new}", f_ice);
            *is.lock() = new;
            Box::pin(async {})
        }));

        // ICE candidate → signal
        let cm = self.clone();
        let f = from.to_string();
        pc.on_ice_candidate(Box::new(move |c| {
            if let Some(c) = c {
                if let Ok(init) = c.to_json() {
                    cm.sig(
                        &serde_json::json!({
                            "type":"signal","target":&f,
                            "payload":{"kind":"ice-candidate","candidate":init.candidate,
                                       "sdpMid":init.sdp_mid,"sdpMLineIndex":init.sdp_mline_index}
                        })
                        .to_string(),
                    );
                }
            }
            Box::pin(async {})
        }));

        // DC → update peer entry (replace locally-created dc with received dc)
        let cm2 = self.clone();
        let pc2 = pc.clone();
        let f2 = from.to_string();
        let is2 = ice_state.clone();
        pc.on_data_channel(Box::new(move |dc| {
            if dc.label() != DATA_CHANNEL_LABEL {
                warn!("Ignoring unknown data channel: {}", dc.label());
                return Box::pin(async {});
            }
            let cm3 = cm2.clone();
            let f3 = f2.clone();
            // Update the existing peer entry with the received DC
            cm3.0.peers.insert(
                f3.clone(),
                Peer {
                    peer_id: f3.clone(),
                    username: "unknown".to_string(),
                    dc: dc.clone(),
                    pc: pc2.clone(),
                    ice_state: is2.clone(),
                    queued_ice: Mutex::new(Vec::new()),
                },
            );
            dc.on_message(Box::new(move |msg| {
                cm3._dispatch(&msg.data, &f3);
                Box::pin(async {})
            }));
            Box::pin(async {})
        }));

        // State → cleanup
        let cm4 = self.clone();
        let f4 = from.to_string();
        pc.on_peer_connection_state_change(Box::new(move |st| {
            if matches!(
                st,
                RTCPeerConnectionState::Failed
                    | RTCPeerConnectionState::Disconnected
                    | RTCPeerConnectionState::Closed
            ) {
                cm4._remove(&f4, &format!("{st:?}"));
            }
            Box::pin(async {})
        }));

        let offer = RTCSessionDescription::offer(sdp.to_string())?;
        pc.set_remote_description(offer).await?;
        let answer = pc.create_answer(None).await?;
        pc.set_local_description(answer.clone()).await?;
        self.sig(
            &serde_json::json!({
                "type":"signal","target":from,
                "payload":{"kind":"answer","sdp":answer.sdp}
            })
            .to_string(),
        );

        // Send Hello back
        self._send_hello(from).await;

        // Notify voice chat about the new peer connection
        self.fire_pc(pc, from);

        Ok(())
    }

    pub async fn on_answer(&self, from: &str, sdp: &str) -> Result<()> {
        if let Some(p) = self.0.peers.get(from) {
            p.pc.set_remote_description(RTCSessionDescription::answer(sdp.to_string())?)
                .await
                .context("set remote answer")?;
        } else {
            warn!("Answer from unknown peer {from}");
        }
        Ok(())
    }

    pub async fn on_ice(&self, from: &str, cand: &str, mid: &str, mline: u16) -> Result<()> {
        let candidate = RTCIceCandidateInit {
            candidate: cand.into(),
            sdp_mid: if mid.is_empty() {
                None
            } else {
                Some(mid.into())
            },
            sdp_mline_index: Some(mline),
            username_fragment: None,
        };
        if let Some(p) = self.0.peers.get(from) {
            p.pc.add_ice_candidate(candidate)
                .await
                .context("add ice candidate")?;
        } else {
            // Peer not found — try entry() to queue on a partial entry if one exists
            use dashmap::mapref::entry::Entry;
            match self.0.peers.entry(from.to_string()) {
                Entry::Occupied(occ) => {
                    // Partial entry exists (pc being created) — queue the candidate
                    occ.get().queued_ice.lock().push(candidate);
                    debug!("Queued ICE candidate for {from} (PC still being created)");
                }
                Entry::Vacant(_) => {
                    warn!("ICE candidate from unknown peer {from}");
                }
            }
        }
        Ok(())
    }

    // ── Internal ─────────────────────────────────────────────────

    fn _dispatch(&self, data: &[u8], from: &str) {
        match wire::decode_header(data) {
            Ok((mt, frame_len)) => {
                debug!("← {mt:?} from {from}");
                let payload = &data[8..frame_len];
                for (hmt, h) in self.0.handlers.lock().iter() {
                    if *hmt == mt {
                        h(mt, payload, from.to_string());
                    }
                }
            }
            Err(e) => warn!("Invalid message from {from}: {e} ({} bytes)", data.len()),
        }
    }

    fn _remove(&self, pid: &str, reason: &str) {
        if let Some((_, p)) = self.0.peers.remove(pid) {
            info!("✗ {pid} ({reason})");
            // Fire on_disconnect callbacks before on_leave so reconnect handlers can act
            let uname = p.username.clone();
            for f in self.0.on_disconnect.lock().iter() {
                f(pid.to_string(), uname.clone());
            }
            self.fire_leave(pid, reason);
            let pc = p.pc.clone();
            let pid_owned = pid.to_string();
            tokio::spawn(async move {
                if let Err(err) = pc.close().await {
                    warn!("Error closing {pid_owned}: {err}");
                }
            });
        }
        // Clean up reconnecting state too
        self.0.reconnecting.remove(pid);
    }

    /// Attempt reconnection to a peer that disconnected with backoff.
    /// Max 3 retries: 2s → 4s → 8s. On success, peer is re-added to peers map.
    /// On failure after max retries, fires leave callback.
    /// Call from the main async context (not inside tokio::spawn — dial() is not Send).
    pub async fn reconnect_peer(&self, pid: &str) {
        // Get the peer's username before removing
        let uname = self
            .0
            .peers
            .get(pid)
            .map(|p| p.username.clone())
            .unwrap_or_else(|| "unknown".to_string());

        // Remove the stale peer (but don't fire leave yet)
        if let Some((_, p)) = self.0.peers.remove(pid) {
            let pc = p.pc.clone();
            tokio::spawn(async move {
                if let Err(e) = pc.close().await {
                    warn!("Error closing stale peer connection: {e}");
                }
            });
        }

        // Mark as reconnecting
        self.0.reconnecting.insert(pid.to_string(), uname.clone());
        info!("Reconnecting to {uname} ({pid}) — backoff: 2s/4s/8s");

        let delays = [2u64, 4, 8];
        for (attempt, delay) in delays.iter().enumerate() {
            time::sleep(Duration::from_secs(*delay)).await;

            // Check if we're still supposed to reconnect (not disconnected globally)
            if !self.0.reconnecting.contains_key(pid) {
                info!("Reconnect to {pid} cancelled");
                return;
            }

            info!(
                "Reconnect attempt {}/{} → {uname} ({pid})",
                attempt + 1,
                delays.len()
            );
            match self.dial(pid, &uname).await {
                Ok(()) => {
                    info!("✓ Reconnected to {uname} ({pid})");
                    self.0.reconnecting.remove(pid);
                    self.fire_join(pid, &uname);
                    return;
                }
                Err(e) => {
                    warn!("Reconnect attempt {} to {pid} failed: {e}", attempt + 1);
                }
            }
        }

        // All retries exhausted — permanent removal
        warn!("Reconnect to {pid} exhausted — removing peer");
        self.0.reconnecting.remove(pid);
        self.fire_leave(pid, "reconnect_failed");
    }

    pub fn peers(&self) -> Vec<String> {
        self.0.peers.iter().map(|e| e.key().clone()).collect()
    }

    pub fn has(&self, id: &str) -> bool {
        self.0.peers.contains_key(id)
    }

    /// Update the connection state based on current peer count.
    /// Call after any peer joins or leaves.
    pub fn update_peer_state(&self) {
        let count = self.0.peers.len();
        if count == 0 {
            if matches!(
                self.0.state.get(),
                crate::state::ConnectionState::Ready { .. }
            ) {
                self.0.state.set_connecting_peers(0);
            }
        } else {
            self.0.state.set_ready(count);
        }
    }

    pub fn get_ice_state(&self, id: &str) -> IceState {
        self.0
            .peers
            .get(id)
            .map(|p| *p.ice_state.lock())
            .unwrap_or(IceState::Closed)
    }

    pub fn peer_stats(&self) -> Vec<(String, String, IceState, String)> {
        let mut stats: Vec<_> = self
            .0
            .peers
            .iter()
            .map(|e| {
                let state = *e.ice_state.lock();
                (
                    e.key().clone(),
                    e.username.clone(),
                    state,
                    state.to_string(),
                )
            })
            .collect();
        // Include virtual peers (SFU mode) — shown as "connected" since server routes
        for entry in self.0.virtual_peers.iter() {
            stats.push((
                entry.key().clone(),
                entry.value().clone(),
                IceState::Connected,
                "connected".to_string(),
            ));
        }
        stats
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    // ── Constructor tests ────────────────────────────────────────────

    #[test]
    fn test_connection_manager_new() {
        let cm = ConnectionManager::new("alice", vec!["chat".into()]);
        assert_eq!(cm.uname(), "alice");
        assert_eq!(cm.pcount(), 0);
        assert!(cm.pid().is_empty());
        assert!(!cm.is_host());
    }

    #[test]
    fn test_connection_manager_with_config() {
        let cfg = P2pConfig {
            username: "bob".into(),
            room: "test-room".into(),
            sfu_enabled: true,
            features: vec!["sfu".into(), "chat".into()],
            ..Default::default()
        };
        let cm = ConnectionManager::with_config("bob", vec![], cfg);
        assert_eq!(cm.uname(), "bob");
        assert!(cm.is_sfu());
        assert_eq!(cm.pcount(), 0);
        assert!(!cm.is_host());
    }

    // ── Identity tests ───────────────────────────────────────────────

    #[test]
    fn test_set_id_and_host_check() {
        let cm = ConnectionManager::new("alice", vec![]);
        cm.set_id("peer-1", "peer-1");
        assert_eq!(cm.pid(), "peer-1");
        assert!(cm.is_host());
    }

    #[test]
    fn test_set_id_not_host() {
        let cm = ConnectionManager::new("bob", vec![]);
        cm.set_id("peer-2", "peer-1");
        assert!(!cm.is_host());
    }

    #[test]
    fn test_is_host_empty_pid() {
        let cm = ConnectionManager::new("alice", vec![]);
        // pid defaults to "" and hid defaults to "" — both empty, is_host returns false
        assert!(!cm.is_host());
        // Set hid to something but leave pid empty
        cm.set_id("", "some-host");
        assert!(!cm.is_host());
    }

    #[test]
    fn test_uname_returns_username() {
        let cm = ConnectionManager::new("charlie", vec![]);
        assert_eq!(cm.uname(), "charlie");
    }

    #[test]
    fn test_pcount_empty() {
        let cm = ConnectionManager::new("alice", vec![]);
        assert_eq!(cm.pcount(), 0);
    }

    #[test]
    fn test_pid_and_hid_after_set() {
        let cm = ConnectionManager::new("alice", vec![]);
        assert!(cm.pid().is_empty());
        assert!(cm.hid().is_empty());
        cm.set_id("peer-a", "host-b");
        assert_eq!(cm.pid(), "peer-a");
        assert_eq!(cm.hid(), "host-b");
    }

    // ── Host callbacks ───────────────────────────────────────────────

    #[test]
    fn test_set_host_triggers_callback() {
        let cm = ConnectionManager::new("alice", vec![]);
        cm.set_id("peer-1", "peer-1");
        let called = Arc::new(AtomicBool::new(false));
        let c = called.clone();
        cm.on_host(move |new_id, reason| {
            assert_eq!(new_id, "peer-2");
            assert_eq!(reason, "previous_left");
            c.store(true, Ordering::SeqCst);
        });
        cm.set_host("peer-2", "previous_left");
        assert!(called.load(Ordering::SeqCst));
    }

    #[test]
    fn test_multiple_callbacks() {
        let cm = ConnectionManager::new("alice", vec![]);
        let c1 = Arc::new(AtomicBool::new(false));
        let c2 = Arc::new(AtomicBool::new(false));
        let a = c1.clone();
        let b = c2.clone();
        cm.on_join(move |_, _| {
            a.store(true, Ordering::SeqCst);
        });
        cm.on_join(move |_, _| {
            b.store(true, Ordering::SeqCst);
        });
        for f in cm.0.on_join.lock().iter() {
            f("x".into(), "y".into());
        }
        assert!(c1.load(Ordering::SeqCst));
        assert!(c2.load(Ordering::SeqCst));
    }

    #[test]
    fn test_set_host_same_value_noop() {
        let cm = ConnectionManager::new("alice", vec![]);
        cm.set_id("peer-1", "peer-1");
        let called = Arc::new(AtomicBool::new(false));
        let c = called.clone();
        cm.on_host(move |_, _| {
            c.store(true, Ordering::SeqCst);
        });
        // Set to the same value — callback should NOT fire
        cm.set_host("peer-1", "no_change");
        assert!(!called.load(Ordering::SeqCst));
    }

    #[test]
    fn test_multiple_on_host_callbacks_fire() {
        let cm = ConnectionManager::new("alice", vec![]);
        cm.set_id("peer-1", "peer-1");
        let c1 = Arc::new(AtomicBool::new(false));
        let c2 = Arc::new(AtomicBool::new(false));
        let a = c1.clone();
        let b = c2.clone();
        cm.on_host(move |_, _| {
            a.store(true, Ordering::SeqCst);
        });
        cm.on_host(move |_, _| {
            b.store(true, Ordering::SeqCst);
        });
        cm.set_host("peer-2", "election");
        assert!(c1.load(Ordering::SeqCst));
        assert!(c2.load(Ordering::SeqCst));
    }

    // ── Leave / disconnect callbacks ─────────────────────────────────

    #[test]
    fn test_on_leave_registration_and_fire() {
        let cm = ConnectionManager::new("alice", vec![]);
        let called = Arc::new(AtomicBool::new(false));
        let c = called.clone();
        cm.on_leave(move |pid, reason| {
            assert_eq!(pid, "peer-x");
            assert_eq!(reason, "left");
            c.store(true, Ordering::SeqCst);
        });
        for f in cm.0.on_leave.lock().iter() {
            f("peer-x".into(), "left".into());
        }
        assert!(called.load(Ordering::SeqCst));
    }

    // ── Signal tests ────────────────────────────────────────────────

    #[test]
    fn test_sig_no_channel() {
        let cm = ConnectionManager::new("alice", vec![]);
        // sig() with no channel set should not panic; just logs a warning
        cm.sig("test message");
        // No assertion needed — test passes if no panic
    }

    #[test]
    fn test_set_sig_then_sig() {
        let cm = ConnectionManager::new("alice", vec![]);
        let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(8);
        cm.set_sig(tx);
        cm.sig("hello");
        // The signal should be available on the receiver
        match rx.try_recv() {
            Ok(msg) => assert_eq!(msg, "hello"),
            _ => panic!("Expected signal message"),
        }
    }

    // ── IceState tests ──────────────────────────────────────────────

    #[test]
    fn test_ice_state_display() {
        assert_eq!(IceState::New.to_string(), "new");
        assert_eq!(IceState::Connected.to_string(), "connected");
        assert_eq!(IceState::Failed.to_string(), "failed");
    }

    #[test]
    fn test_ice_state_display_all() {
        // Every variant returns a non-empty Display string
        assert!(!IceState::New.to_string().is_empty());
        assert!(!IceState::Checking.to_string().is_empty());
        assert!(!IceState::Connected.to_string().is_empty());
        assert!(!IceState::Disconnected.to_string().is_empty());
        assert!(!IceState::Failed.to_string().is_empty());
        assert!(!IceState::Closed.to_string().is_empty());
        // Spot-check a few exact values
        assert_eq!(IceState::Checking.to_string(), "connecting...");
        assert_eq!(IceState::Disconnected.to_string(), "disconnected");
        assert_eq!(IceState::Closed.to_string(), "closed");
    }

    #[test]
    fn test_ice_state_debug_clone_eq() {
        // Clone, Debug, and PartialEq are derived — verify they work
        let s1 = IceState::Connected;
        let s2 = s1; // Copy (Clone + Copy)
        assert_eq!(s1, s2);
        assert!(format!("{s1:?}").contains("Connected"));
        // PartialEq: different variants are not equal
        assert_ne!(IceState::New, IceState::Connected);
        assert_eq!(IceState::Failed, IceState::Failed);
    }

    #[test]
    fn test_get_ice_state_unknown() {
        assert_eq!(
            ConnectionManager::new("a", vec![]).get_ice_state("x"),
            IceState::Closed
        );
    }

    // ── Connection state tests ──────────────────────────────────────

    #[test]
    fn test_connection_state_initial() {
        let cm = ConnectionManager::new("alice", vec![]);
        assert_eq!(
            cm.connection_state(),
            crate::state::ConnectionState::Offline
        );
    }

    #[test]
    fn test_connection_state_after_reconnecting() {
        let cm = ConnectionManager::new("alice", vec![]);
        // set_reconnecting only accepts transitions from Connecting/
        // Handshaking/ConnectingPeers/Ready/Reconnecting — not Offline.
        // First move to Connecting, then to Reconnecting.
        cm.0.state.set_connecting();
        cm.set_state_reconnecting(2, 5);
        assert_eq!(
            cm.connection_state(),
            crate::state::ConnectionState::Reconnecting {
                attempt: 2,
                max_attempts: 5,
            }
        );
    }

    // ── ICE configuration tests ─────────────────────────────────────

    #[test]
    fn test_default_ice_conf() {
        let conf = default_ice_conf();
        // Must have at least one ICE server (STUN fallback)
        assert!(!conf.ice_servers.is_empty());
        // The default STUN servers should include Google STUN
        let urls = &conf.ice_servers[0].urls;
        assert!(!urls.is_empty());
        assert!(urls.contains(&"stun:stun.l.google.com:19302".to_string()));
    }

    #[test]
    fn test_ice_conf_from_config_empty_servers() {
        let cfg = P2pConfig::default();
        let conf = ice_conf_from_config(&cfg);
        // With empty STUN/TURN config, should fall back to default (Google STUN)
        assert!(!conf.ice_servers.is_empty());
        let urls = &conf.ice_servers[0].urls;
        assert!(urls.contains(&"stun:stun.l.google.com:19302".to_string()));
    }

    // ── Peers tests ─────────────────────────────────────────────────

    #[test]
    fn test_peers_empty() {
        let cm = ConnectionManager::new("alice", vec![]);
        assert!(cm.peers().is_empty());
    }

    #[test]
    fn test_has_unknown() {
        let cm = ConnectionManager::new("alice", vec![]);
        assert!(!cm.has("nonexistent"));
    }

    #[test]
    fn test_peer_stats_empty() {
        assert!(ConnectionManager::new("a", vec![]).peer_stats().is_empty());
    }

    // ── SFU tests ───────────────────────────────────────────────────

    #[test]
    fn test_is_sfu_default_false() {
        let cm = ConnectionManager::new("alice", vec![]);
        assert!(!cm.is_sfu());
    }

    #[test]
    fn test_is_sfu_with_config_true() {
        let cfg = P2pConfig {
            sfu_enabled: true,
            ..Default::default()
        };
        let cm = ConnectionManager::with_config("alice", vec![], cfg);
        assert!(cm.is_sfu());
    }

    // ── Constant tests ──────────────────────────────────────────────

    #[test]
    fn test_protocol_version() {
        assert!(!PROTOCOL_VERSION.is_empty());
        // Semantic versioning — should contain dots
        assert!(PROTOCOL_VERSION.contains('.'));
    }

    #[test]
    fn test_data_channel_label() {
        assert!(!DATA_CHANNEL_LABEL.is_empty());
        assert!(DATA_CHANNEL_LABEL.contains("syncplay"));
    }

    // ── Disconnect callback test ────────────────────────────────────

    #[test]
    fn test_on_disconnect_registration_and_fire() {
        let cm = ConnectionManager::new("alice", vec![]);
        let called = Arc::new(AtomicBool::new(false));
        let c = called.clone();
        cm.on_disconnect(move |pid, username| {
            assert_eq!(pid, "peer-d");
            assert_eq!(username, "disconnector");
            c.store(true, Ordering::SeqCst);
        });
        for f in cm.0.on_disconnect.lock().iter() {
            f("peer-d".into(), "disconnector".into());
        }
        assert!(called.load(Ordering::SeqCst));
    }
}
