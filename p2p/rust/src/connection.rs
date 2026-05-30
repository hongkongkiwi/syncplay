//! WebRTC Connection Manager — webrtc-rs 0.14
//!
//! Manages WebRTC peer connections, signaling, lifecycle callbacks,
//! and per-peer ICE state tracking. Uses Arc<Inner> pattern for cloneability.

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
use crate::wire;

pub const PROTOCOL_VERSION: &str = "2.0.0";
const DATA_CHANNEL_LABEL: &str = "syncplay-v2";
const STUN_FALLBACK: &[&str] = &["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"];

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

pub struct Peer {
    pub peer_id: String,
    pub username: String,
    pub dc: Arc<RTCDataChannel>,
    pub pc: Arc<RTCPeerConnection>,
    pub ice_state: Arc<Mutex<IceState>>,
}

impl Peer {
    pub async fn send(&self, data: &Bytes) -> Result<usize> {
        self.dc
            .send(data)
            .await
            .map_err(|e| anyhow::anyhow!("dc send: {e}"))
    }
}

// ── Inner ────────────────────────────────────────────────────────────

type MsgFn = Box<dyn Fn(MessageType, &[u8], String) + Send + Sync>;
type PeerFn = Box<dyn Fn(String, String) + Send + Sync>;

struct Inner {
    username: String,
    config: Mutex<Option<P2pConfig>>,
    peer_id: Mutex<String>,
    host_id: Mutex<String>,
    peers: DashMap<String, Peer>,
    handlers: Mutex<Vec<(MessageType, MsgFn)>>,
    on_join: Mutex<Vec<PeerFn>>,
    on_leave: Mutex<Vec<PeerFn>>,
    on_host: Mutex<Vec<PeerFn>>,
    signal_tx: Mutex<Option<mpsc::UnboundedSender<String>>>,
}

#[derive(Clone)]
pub struct ConnectionManager(Arc<Inner>);

impl ConnectionManager {
    pub fn new(username: &str, features: Vec<String>) -> Self {
        let mut cfg = P2pConfig::default();
        cfg.username = username.into();
        cfg.features = features;
        Self(Arc::new(Inner {
            username: username.into(),
            config: Mutex::new(Some(cfg)),
            peer_id: Default::default(),
            host_id: Default::default(),
            peers: DashMap::new(),
            handlers: Mutex::new(Vec::new()),
            on_join: Mutex::new(Vec::new()),
            on_leave: Mutex::new(Vec::new()),
            on_host: Mutex::new(Vec::new()),
            signal_tx: Mutex::new(None),
        }))
    }

    pub fn with_config(username: &str, features: Vec<String>, cfg: P2pConfig) -> Self {
        Self(Arc::new(Inner {
            username: username.into(),
            config: Mutex::new(Some(cfg)),
            peer_id: Default::default(),
            host_id: Default::default(),
            peers: DashMap::new(),
            handlers: Mutex::new(Vec::new()),
            on_join: Mutex::new(Vec::new()),
            on_leave: Mutex::new(Vec::new()),
            on_host: Mutex::new(Vec::new()),
            signal_tx: Mutex::new(None),
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
    pub fn pid(&self) -> String { self.0.peer_id.lock().clone() }
    pub fn hid(&self) -> String { self.0.host_id.lock().clone() }
    pub fn is_host(&self) -> bool {
        let pid = self.pid();
        !pid.is_empty() && pid == self.hid()
    }
    pub fn uname(&self) -> String { self.0.username.clone() }

    pub fn pcount(&self) -> usize { self.0.peers.len() }

    pub fn set_id(&self, pid: &str, hid: &str) {
        *self.0.peer_id.lock() = pid.into();
        *self.0.host_id.lock() = hid.into();
    }

    pub fn set_sig(&self, tx: mpsc::UnboundedSender<String>) {
        *self.0.signal_tx.lock() = Some(tx);
    }

    pub fn sig(&self, msg: &str) {
        if let Some(tx) = self.0.signal_tx.lock().as_ref() {
            if tx.send(msg.to_string()).is_err() {
                warn!("Signal channel closed");
            }
        } else {
            warn!("No signal channel set");
        }
    }

    pub fn set_host(&self, new_id: &str, reason: &str) {
        let old = self.0.host_id.lock().clone();
        if old != new_id {
            info!("Host: {old} → {new_id} ({reason})");
            *self.0.host_id.lock() = new_id.to_string();
            for f in self.0.on_host.lock().iter() {
                f(new_id.to_string(), reason.to_string());
            }
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
    pub fn on_msg<F: Fn(MessageType, &[u8], String) + Send + Sync + 'static>(
        &self, mt: MessageType, f: F,
    ) {
        self.0.handlers.lock().push((mt, Box::new(f)));
    }

    fn fire_join(&self, pid: &str, uname: &str) {
        for f in self.0.on_join.lock().iter() {
            f(pid.to_string(), uname.to_string());
        }
    }
    fn fire_leave(&self, pid: &str, reason: &str) {
        for f in self.0.on_leave.lock().iter() {
            f(pid.to_string(), reason.to_string());
        }
    }

    // ── Signaling ─────────────────────────────────────────────────

    pub async fn connect(&self, url: &str, room: &str, password: &str) -> Result<()> {
        self._signaling_handshake(url, room, password, "create").await
    }

    pub async fn join(&self, url: &str, room: &str, password: &str) -> Result<()> {
        self._signaling_handshake(url, room, password, "join").await
    }

    /// Connect with reconnect support.
    pub async fn connect_with_retry(
        &self, url: &str, room: &str, password: &str,
    ) -> Result<()> {
        let max_retries = self.0.config.lock().as_ref()
            .map(|c| c.network.max_reconnect_attempts)
            .unwrap_or(5);
        let delay = self.0.config.lock().as_ref()
            .map(|c| Duration::from_secs(c.network.reconnect_delay_secs))
            .unwrap_or(Duration::from_secs(5));

        let mut attempts = 0;
        loop {
            match self._signaling_handshake(url, room, password, "create").await {
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
        &self, url: &str, room: &str, password: &str, kind: &str,
    ) -> Result<()> {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::{connect_async, tungstenite::Message};

        let (ws, _) = connect_async(url).await.context("WebSocket connect")?;
        let (mut write, mut read) = ws.split();

        let msg = serde_json::json!({
            "type": kind, "room": room, "password": password,
            "username": self.uname(), "features": self.0.config.lock().as_ref()
                .map(|c| c.features.clone()).unwrap_or_default(),
        });
        write.send(Message::Text(msg.to_string().into())).await
            .context("send handshake")?;

        if let Some(Ok(Message::Text(text))) = read.next().await {
            let resp: serde_json::Value = serde_json::from_str(&text)
                .context("parse response")?;
            if resp["type"] == "error" {
                let code = resp["code"].as_str().unwrap_or("unknown");
                let message = resp["message"].as_str().unwrap_or("unknown error");
                return Err(anyhow::anyhow!("Server error: {code} — {message}"));
            }
            let pid = resp["peerId"].as_str().unwrap_or("").to_string();
            let hid = resp["hostId"].as_str().unwrap_or("").to_string();
            self.set_id(&pid, &hid);
            info!("{kind}: room={room} pid={pid} hid={hid}");

            // If joining: connect to existing peers + fetch initial state
            if kind == "join" {
                if let Some(peers) = resp["peers"].as_array() {
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
            "peer_left" => {
                let pid = msg["peerId"].as_str().unwrap_or("");
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
                    other => { warn!("Unknown signal kind: {other}"); Ok(()) }
                };
                if let Err(e) = result { warn!("Signal {kind} from {from} failed: {e}"); }
            }
            unknown => {
                if !unknown.is_empty() { debug!("Unknown server msg: {unknown}"); }
            }
        }
        Ok(())
    }

    pub async fn disconnect(&self) {
        // Send PeerDisconnect to all peers
        let p = crate::messages::PeerDisconnectPayload { reason: "leaving".into() };
        if let Ok(data) = wire::encode(&p) {
            self.send_all(&data, None).await;
        }
        for entry in self.0.peers.iter() {
            if let Err(err) = entry.pc.close().await {
                warn!("Error closing {}: {err}", entry.key());
            }
        }
        self.0.peers.clear();
    }

    // ── Sending ──────────────────────────────────────────────────

    pub async fn send_all(&self, data: &Bytes, skip: Option<&str>) {
        for entry in self.0.peers.iter() {
            if Some(entry.key().as_str()) != skip {
                if let Err(err) = entry.send(data).await {
                    warn!("Send to {} failed: {err}", entry.key());
                }
            }
        }
    }

    pub async fn send_one(&self, id: &str, data: &Bytes) -> Result<()> {
        self.0.peers.get(id).with_context(|| format!("no peer {id}"))?.send(data).await.map(|_| ())
    }

    pub async fn bcast<T: wire::MessagePayload>(&self, p: &T, skip: Option<&str>) {
        match wire::encode(p) {
            Ok(data) => self.send_all(&data, skip).await,
            Err(e) => error!("Failed to encode broadcast: {e}"),
        }
    }

    async fn _send_userinfo(&self) {
        let features = self.0.config.lock().as_ref()
            .map(|c| c.features.clone()).unwrap_or_default();
        let p = crate::messages::UserInfoPayload {
            username: self.uname(),
            features,
        };
        self.send_all(&wire::encode(&p).unwrap_or_default(), None).await;
    }

    async fn _send_hello(&self, target: &str) {
        let features = self.0.config.lock().as_ref()
            .map(|c| c.features.clone()).unwrap_or_default();
        let p = crate::messages::HelloPayload::new(
            &self.uname(), PROTOCOL_VERSION, features,
        );
        if let Ok(data) = wire::encode(&p) {
            let _ = self.send_one(target, &data).await;
        }
    }

    // ── WebRTC lifecycle ─────────────────────────────────────────

    pub async fn dial(&self, pid_str: &str, uname: &str) -> Result<()> {
        if self.0.peers.contains_key(pid_str) {
            debug!("Already connected to {uname} ({pid_str})");
            return Ok(());
        }
        info!("dial → {uname} ({pid_str})");

        let api = APIBuilder::new().build();
        let ice_conf = self.ice_conf();
        let pc = Arc::new(api.new_peer_connection(ice_conf).await?);
        let dc = pc.create_data_channel(DATA_CHANNEL_LABEL, None).await?;

        let ice_state = Arc::new(Mutex::new(IceState::New));
        self.0.peers.insert(
            pid_str.to_string(),
            Peer {
                peer_id: pid_str.to_string(),
                username: uname.to_string(),
                dc: dc.clone(),
                pc: pc.clone(),
                ice_state: ice_state.clone(),
            },
        );

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
                    cm.sig(&serde_json::json!({
                        "type":"signal","target":&p,
                        "payload":{"kind":"ice-candidate","candidate":init.candidate,
                                   "sdpMid":init.sdp_mid,"sdpMLineIndex":init.sdp_mline_index}
                    }).to_string());
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
            if matches!(st, RTCPeerConnectionState::Failed
                | RTCPeerConnectionState::Disconnected
                | RTCPeerConnectionState::Closed)
            {
                cm3._remove(&p3, &format!("{st:?}"));
            }
            Box::pin(async {})
        }));

        let offer = pc.create_offer(None).await?;
        pc.set_local_description(offer.clone()).await?;
        self.sig(&serde_json::json!({
            "type":"signal","target":pid_str,
            "payload":{"kind":"offer","sdp":offer.sdp}
        }).to_string());

        // Send Hello to the new peer
        self._send_hello(pid_str).await;
        Ok(())
    }

    pub async fn on_offer(&self, from: &str, sdp: &str) -> Result<()> {
        if self.0.peers.contains_key(from) {
            debug!("Already connected to {from}, ignoring duplicate");
            return Ok(());
        }
        info!("offer ← {from}");

        let api = APIBuilder::new().build();
        let ice_conf = self.ice_conf();
        let pc = Arc::new(api.new_peer_connection(ice_conf).await?);
        let ice_state = Arc::new(Mutex::new(IceState::Checking));

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
                    cm.sig(&serde_json::json!({
                        "type":"signal","target":&f,
                        "payload":{"kind":"ice-candidate","candidate":init.candidate,
                                   "sdpMid":init.sdp_mid,"sdpMLineIndex":init.sdp_mline_index}
                    }).to_string());
                }
            }
            Box::pin(async {})
        }));

        // DC → validate label, store peer, dispatch messages
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
            cm3.0.peers.insert(f3.clone(), Peer {
                peer_id: f3.clone(),
                username: "unknown".to_string(),
                dc: dc.clone(),
                pc: pc2.clone(),
                ice_state: is2.clone(),
            });
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
            if matches!(st, RTCPeerConnectionState::Failed
                | RTCPeerConnectionState::Disconnected
                | RTCPeerConnectionState::Closed)
            {
                cm4._remove(&f4, &format!("{st:?}"));
            }
            Box::pin(async {})
        }));

        let offer = RTCSessionDescription::offer(sdp.to_string())?;
        pc.set_remote_description(offer).await?;
        let answer = pc.create_answer(None).await?;
        pc.set_local_description(answer.clone()).await?;
        self.sig(&serde_json::json!({
            "type":"signal","target":from,
            "payload":{"kind":"answer","sdp":answer.sdp}
        }).to_string());

        // Send Hello back
        self._send_hello(from).await;
        Ok(())
    }

    pub async fn on_answer(&self, from: &str, sdp: &str) -> Result<()> {
        if let Some(p) = self.0.peers.get(from) {
            p.pc.set_remote_description(RTCSessionDescription::answer(sdp.to_string())?)
                .await.context("set remote answer")?;
        } else {
            warn!("Answer from unknown peer {from}");
        }
        Ok(())
    }

    pub async fn on_ice(&self, from: &str, cand: &str, mid: &str, mline: u16) -> Result<()> {
        if let Some(p) = self.0.peers.get(from) {
            p.pc.add_ice_candidate(RTCIceCandidateInit {
                candidate: cand.into(),
                sdp_mid: if mid.is_empty() { None } else { Some(mid.into()) },
                sdp_mline_index: Some(mline),
                username_fragment: None,
            }).await.context("add ice candidate")?;
        } else {
            warn!("ICE candidate from unknown peer {from}");
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
                    if *hmt == mt { h(mt, payload, from.to_string()); }
                }
            }
            Err(e) => warn!("Invalid message from {from}: {e} ({} bytes)", data.len()),
        }
    }

    fn _remove(&self, pid: &str, reason: &str) {
        if let Some((_, p)) = self.0.peers.remove(pid) {
            info!("✗ {pid} ({reason})");
            self.fire_leave(pid, reason);
            let pc = p.pc.clone();
            let pid_owned = pid.to_string();
            tokio::spawn(async move {
                if let Err(err) = pc.close().await {
                    warn!("Error closing {pid_owned}: {err}");
                }
            });
        }
    }

    pub fn peers(&self) -> Vec<String> {
        self.0.peers.iter().map(|e| e.key().clone()).collect()
    }

    pub fn has(&self, id: &str) -> bool { self.0.peers.contains_key(id) }

    pub fn get_ice_state(&self, id: &str) -> IceState {
        self.0.peers.get(id).map(|p| *p.ice_state.lock()).unwrap_or(IceState::Closed)
    }

    pub fn peer_stats(&self) -> Vec<(String, String, IceState, String)> {
        self.0.peers.iter().map(|e| {
            let state = *e.ice_state.lock();
            (e.key().clone(), e.username.clone(), state, state.to_string())
        }).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn test_connection_manager_new() {
        let cm = ConnectionManager::new("alice", vec!["chat".into()]);
        assert_eq!(cm.uname(), "alice");
        assert_eq!(cm.pcount(), 0);
        assert!(cm.pid().is_empty());
        assert!(!cm.is_host());
    }

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
        let a = c1.clone(); let b = c2.clone();
        cm.on_join(move |_, _| { a.store(true, Ordering::SeqCst); });
        cm.on_join(move |_, _| { b.store(true, Ordering::SeqCst); });
        for f in cm.0.on_join.lock().iter() { f("x".into(), "y".into()); }
        assert!(c1.load(Ordering::SeqCst));
        assert!(c2.load(Ordering::SeqCst));
    }

    #[test]
    fn test_ice_state_display() {
        assert_eq!(IceState::New.to_string(), "new");
        assert_eq!(IceState::Connected.to_string(), "connected");
        assert_eq!(IceState::Failed.to_string(), "failed");
    }

    #[test]
    fn test_get_ice_state_unknown() {
        assert_eq!(ConnectionManager::new("a", vec![]).get_ice_state("x"), IceState::Closed);
    }

    #[test]
    fn test_peer_stats_empty() {
        assert!(ConnectionManager::new("a", vec![]).peer_stats().is_empty());
    }
}
