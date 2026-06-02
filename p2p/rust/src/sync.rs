//! Host-authoritative state sync manager.
//!
//! Manages playstate sync, chat relay, readiness, playlist, controllers,
//! latency measurements, and handshake protocol.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use log::{debug, error, info, warn};
use parking_lot::{Mutex, RwLock};
use tokio::sync::Notify;
use tokio::time;

use crate::config::P2pConfig;
use crate::connection::{ConnectionManager, PROTOCOL_VERSION};
use crate::messages::*;
use crate::wire;

/// Warn if a peer has > 500ms latency
const LATENCY_WARN_MS: f64 = 0.5;

fn now_ms() -> u64 {
    crate::now_ms()
}

/// Immutable snapshot of room state for UI rendering in the TUI or CLI.
#[derive(Debug, Clone)]
pub struct RoomStateSnapshot {
    pub position: f64,
    pub paused: bool,
    pub set_by: String,
    pub seq: u64,
    pub playlist: Vec<FileEntry>,
    pub playlist_index: usize,
    pub ready_states: HashMap<String, bool>,
    pub controllers: Vec<String>,
}

struct RoomState {
    position: f64,
    paused: bool,
    set_by: String,
    seq: u64,
    playlist: Vec<FileEntry>,
    playlist_index: usize,
    controllers: HashSet<String>,
    ready_states: HashMap<String, bool>,
    speed: f64,
}

impl Default for RoomState {
    fn default() -> Self {
        Self {
            position: 0.0,
            paused: true,
            set_by: String::new(),
            seq: 0,
            playlist: vec![],
            playlist_index: 0,
            controllers: HashSet::new(),
            ready_states: HashMap::new(),
            speed: 1.0,
        }
    }
}

/// Host-authoritative synchronization manager for room state, playback control, chat relay, and latency tracking.
pub struct SyncManager {
    conn: ConnectionManager,
    room: Arc<Mutex<RoomState>>,
    pub latency_map: Arc<Mutex<HashMap<String, f64>>>,
    voice_mutes: Arc<Mutex<HashMap<String, bool>>>,
    shutdown: Arc<Notify>,
    player_socket: Arc<Mutex<Option<String>>>,
    /// Sync interval in ms from config (default 500)
    sync_interval_ms: u64,
    /// Ping interval in ms from config (default 2000)
    ping_interval_ms: u64,
    /// Max chat message length from config (default 2000)
    max_chat: usize,
    /// Max playlist items from config (default 250)
    max_pl_items: usize,
    /// Features advertised to peers (from config)
    features: Arc<RwLock<Vec<String>>>,
    /// Prevents double-spawn of the host sync loop
    host_loop_running: Arc<std::sync::atomic::AtomicBool>,
}

impl Clone for SyncManager {
    fn clone(&self) -> Self {
        Self {
            conn: self.conn.clone(),
            room: self.room.clone(),
            latency_map: self.latency_map.clone(),
            voice_mutes: self.voice_mutes.clone(),
            shutdown: self.shutdown.clone(),
            player_socket: self.player_socket.clone(),
            sync_interval_ms: self.sync_interval_ms,
            ping_interval_ms: self.ping_interval_ms,
            max_chat: self.max_chat,
            max_pl_items: self.max_pl_items,
            features: self.features.clone(),
            host_loop_running: self.host_loop_running.clone(),
        }
    }
}

impl SyncManager {
    pub fn new(conn: ConnectionManager, config: P2pConfig) -> Self {
        let sync_interval_ms = config.sync.sync_interval_ms;
        let ping_interval_ms = config.sync.ping_interval_ms;
        let max_chat = config.sync.max_chat_length;
        let max_pl_items = config.sync.max_playlist_items;
        let features = Arc::new(RwLock::new(config.features.clone()));

        let mgr = Self {
            conn: conn.clone(),
            room: Arc::new(Mutex::new(RoomState::default())),
            latency_map: Arc::new(Mutex::new(HashMap::new())),
            voice_mutes: Arc::new(Mutex::new(HashMap::new())),
            shutdown: Arc::new(Notify::new()),
            player_socket: Arc::new(Mutex::new(None)),
            sync_interval_ms,
            ping_interval_ms,
            max_chat,
            max_pl_items,
            features,
            host_loop_running: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };
        mgr.register_handlers();
        // Wire up P2P reconnection on peer disconnect
        let c_recon = conn.clone();
        conn.on_disconnect(move |pid: String, _uname: String| {
            let c2 = c_recon.clone();
            c2.set_state_reconnecting(1, 3);
            tokio::spawn(async move {
                c2.reconnect_peer(&pid).await;
            });
        });
        let c = conn.clone();
        let r = mgr.room.clone();
        let s = mgr.shutdown.clone();
        let m2 = mgr.clone();
        let hlr1 = mgr.host_loop_running.clone();
        let iv_cap = sync_interval_ms;
        conn.on_host(move |_new_id: String, reason: String| {
            if c.is_host() {
                // Prevent double-spawn: only start if not already running
                if hlr1.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    warn!("Host loop already running — skipping duplicate spawn");
                    return;
                }
                info!("I am now the host ({reason}) — starting sync loop");
                m2.add_controller(&c.pid());
                let c2 = c.clone();
                let r2 = r.clone();
                let s2 = s.clone();
                let hlr2 = hlr1.clone();
                tokio::spawn(async move {
                    host_loop(c2, r2, s2, iv_cap).await;
                    hlr2.store(false, std::sync::atomic::Ordering::SeqCst);
                });
            }
        });
        mgr
    }

    pub fn is_host(&self) -> bool {
        self.conn.is_host()
    }

    pub async fn start(&self) {
        if self.conn.is_host() {
            // Prevent double-spawn if on_host already started a loop
            if self
                .host_loop_running
                .swap(true, std::sync::atomic::Ordering::SeqCst)
            {
                warn!("Host loop already running — skipping start() spawn");
                return;
            }
            let c = self.conn.clone();
            let r = self.room.clone();
            let s = self.shutdown.clone();
            let iv = self.sync_interval_ms;
            let hlr = self.host_loop_running.clone();
            tokio::spawn(async move {
                host_loop(c, r, s, iv).await;
                hlr.store(false, std::sync::atomic::Ordering::SeqCst);
            });
        }
        let c = self.conn.clone();
        let s = self.shutdown.clone();
        let iv = self.ping_interval_ms;
        tokio::spawn(async move {
            ping_loop(c, s, iv).await;
        });
    }

    pub async fn stop(&self) {
        self.shutdown.notify_waiters();
        info!("SyncManager stopped");
    }

    // ── State snapshot for new joiners ────────────────────────────

    /// Broadcast current room state to a specific peer (for new joiners).
    pub async fn send_state_to(&self, target: &str) {
        // Read all state in one lock acquisition for consistency
        let (pos, paused, sb, seq, speed, files, idx, ready_states, controllers) = {
            let r = self.room.lock();
            (
                r.position,
                r.paused,
                r.set_by.clone(),
                r.seq,
                r.speed,
                r.playlist.clone(),
                r.playlist_index,
                r.ready_states.clone(),
                r.controllers.iter().cloned().collect::<Vec<_>>(),
            )
        };
        // Send playstate with speed
        let ps = PlaystatePayload::with_speed(pos, paused, true, &sb, seq, speed);
        if let Ok(data) = wire::encode(&ps) {
            if let Err(e) = self.conn.send_one(target, &data).await {
                warn!("send_state_to: playstate to {target}: {e}");
            }
        }
        // Send playlist
        if !files.is_empty() {
            let pl = PlaylistChangePayload {
                files,
                index: idx,
                set_by: sb.clone(),
            };
            if let Ok(data) = wire::encode(&pl) {
                if let Err(e) = self.conn.send_one(target, &data).await {
                    warn!("send_state_to: playlist to {target}: {e}");
                }
            }
        }
        // Send readiness states
        for (username, is_ready) in &ready_states {
            let rp = ReadinessPayload::new(username, *is_ready, false, &sb);
            if let Ok(data) = wire::encode(&rp) {
                if let Err(e) = self.conn.send_one(target, &data).await {
                    warn!("send_state_to: readiness to {target}: {e}");
                }
            }
        }
        // Send controller list so rejoining peers regain controller status
        for cid in &controllers {
            let cp = ControllerChangePayload {
                peer_id: cid.clone(),
                action: ControllerAction::Add,
            };
            if let Ok(data) = wire::encode(&cp) {
                if let Err(e) = self.conn.send_one(target, &data).await {
                    warn!("send_state_to: controller {cid} to {target}: {e}");
                }
            }
        }
    }

    // ── Playback ──────────────────────────────────────────────────

    pub fn update_playstate(&self, position: f64, paused: bool) {
        if !self.conn.is_host() {
            debug!("update_playstate ignored — not host");
            return;
        }
        let mut r = self.room.lock();
        r.position = position;
        r.paused = paused;
        r.seq += 1;
    }

    pub async fn request_seek(&self, pos: f64) {
        if self.conn.is_host() {
            {
                let mut r = self.room.lock();
                r.position = pos;
                r.seq += 1;
            }
            self.bcast_ps(true).await;
        } else {
            match wire::encode(&PlaystateRequestPayload::seek(pos)) {
                Ok(frame) => self.send_to_host(&frame).await,
                Err(e) => error!("encode seek: {e}"),
            }
        }
    }

    pub async fn request_pause(&self) {
        if self.conn.is_host() {
            {
                let mut r = self.room.lock();
                r.paused = true;
                r.seq += 1;
            }
            self.bcast_ps(false).await;
        } else {
            match wire::encode(&PlaystateRequestPayload::pause()) {
                Ok(frame) => self.send_to_host(&frame).await,
                Err(e) => error!("encode pause: {e}"),
            }
        }
    }

    pub async fn request_play(&self) {
        if self.conn.is_host() {
            {
                let mut r = self.room.lock();
                r.paused = false;
                r.seq += 1;
            }
            self.bcast_ps(false).await;
        } else {
            match wire::encode(&PlaystateRequestPayload::play()) {
                Ok(frame) => self.send_to_host(&frame).await,
                Err(e) => error!("encode play: {e}"),
            }
        }
    }

    pub async fn request_set_speed(&self, speed: f64) {
        if self.conn.is_host() {
            {
                let mut r = self.room.lock();
                r.speed = speed;
                r.seq += 1;
            }
            self.bcast_ps(false).await;
        } else {
            match wire::encode(&PlaystateRequestPayload::set_speed(speed)) {
                Ok(frame) => self.send_to_host(&frame).await,
                Err(e) => error!("encode set_speed: {e}"),
            }
        }
    }

    pub async fn update_speed(&self, speed: f64) {
        if !self.conn.is_host() {
            return;
        }
        let mut r = self.room.lock();
        r.speed = speed;
        r.seq += 1;
    }

    // ── Chat ──────────────────────────────────────────────────────

    pub async fn send_chat(&self, msg: &str) {
        let truncated = if msg.len() > self.max_chat {
            // Truncate at char boundary to avoid breaking multi-byte/emoji
            let mut end = self.max_chat;
            while end > 0 && !msg.is_char_boundary(end) {
                end -= 1;
            }
            &msg[..end]
        } else {
            msg
        };
        let p = ChatPayload::new(&self.conn.uname(), truncated);
        if self.conn.is_host() {
            self.conn.bcast(&p, None).await;
        } else {
            match wire::encode(&p) {
                Ok(frame) => self.send_to_host(&frame).await,
                Err(e) => error!("encode chat: {e}"),
            }
        }
    }

    pub async fn send_voice_mute(&self, muted: bool) {
        let p = VoiceMutePayload { muted };
        if self.conn.is_host() {
            // Host relays to all peers to notify them of the mute state
            self.conn.bcast(&p, None).await;
        } else {
            // Non-host sends to host for relaying
            match wire::encode(&p) {
                Ok(frame) => self.send_to_host(&frame).await,
                Err(e) => error!("encode voice mute: {e}"),
            }
        }
    }

    // ── Readiness ─────────────────────────────────────────────────

    pub async fn set_ready(&self, is_ready: bool, target: Option<&str>) {
        let uname = target.unwrap_or(&self.conn.uname()).to_string();
        let p = ReadinessPayload::new(&uname, is_ready, true, &self.conn.uname());
        match wire::encode(&p) {
            Ok(frame) => {
                if self.conn.is_host() {
                    self.room.lock().ready_states.insert(uname, is_ready);
                    self.conn.bcast(&p, None).await;
                } else {
                    self.send_to_host(&frame).await;
                }
            }
            Err(e) => error!("encode readiness: {e}"),
        }
    }

    // ── Playlist ──────────────────────────────────────────────────

    pub async fn set_playlist(&self, files: Vec<FileEntry>) {
        let files = files
            .into_iter()
            .take(self.max_pl_items)
            .collect::<Vec<_>>();
        if self.conn.is_host() {
            let idx = {
                let mut r = self.room.lock();
                r.playlist = files.clone();
                r.playlist_index
            };
            self.conn
                .bcast(
                    &PlaylistChangePayload {
                        files,
                        index: idx,
                        set_by: self.conn.uname(),
                    },
                    None,
                )
                .await;
        } else {
            match wire::encode(&PlaylistRequestPayload {
                action: PlaylistAction::SetPlaylist,
                files,
                index: 0,
            }) {
                Ok(frame) => self.send_to_host(&frame).await,
                Err(e) => error!("encode playlist: {e}"),
            }
        }
    }

    pub async fn set_playlist_index(&self, idx: usize) {
        if self.conn.is_host() {
            let files = {
                let mut r = self.room.lock();
                r.playlist_index = idx;
                r.position = 0.0;
                r.seq += 1;
                r.playlist.clone()
            };
            self.conn
                .bcast(
                    &PlaylistChangePayload {
                        files,
                        index: idx,
                        set_by: self.conn.uname(),
                    },
                    None,
                )
                .await;
        } else {
            match wire::encode(&PlaylistRequestPayload {
                action: PlaylistAction::SetIndex,
                files: vec![],
                index: idx,
            }) {
                Ok(frame) => self.send_to_host(&frame).await,
                Err(e) => error!("encode playlist idx: {e}"),
            }
        }
    }

    /// Send current file info — only the host can broadcast this.
    pub async fn send_file_info(&self, file: Option<FileMetadata>) {
        if !self.conn.is_host() {
            warn!("send_file_info ignored — not host");
            return;
        }
        self.conn
            .bcast(
                &FileInfoPayload {
                    username: self.conn.uname(),
                    file,
                },
                None,
            )
            .await;
    }

    pub fn add_controller(&self, pid: &str) {
        self.room.lock().controllers.insert(pid.into());
    }
    pub fn remove_controller(&self, pid: &str) {
        self.room.lock().controllers.remove(pid);
    }
    pub fn is_controller(&self, pid: &str) -> bool {
        self.room.lock().controllers.contains(pid) || pid == self.conn.pid()
    }
    /// Send controller change — only the host can broadcast this.
    pub async fn send_controller_change(&self, peer_id: &str, action: ControllerAction) {
        if !self.conn.is_host() {
            warn!("send_controller_change ignored — not host");
            return;
        }
        self.conn
            .bcast(
                &ControllerChangePayload {
                    peer_id: peer_id.into(),
                    action,
                },
                None,
            )
            .await;
    }
    pub fn get_latencies(&self) -> HashMap<String, f64> {
        self.latency_map.lock().clone()
    }

    pub fn get_peer_stats(&self) -> Vec<(String, String, crate::connection::IceState, String)> {
        self.conn.peer_stats()
    }

    pub fn get_connection(&self) -> crate::connection::ConnectionManager {
        self.conn.clone()
    }

    pub fn set_player_socket(&self, socket: Option<String>) {
        *self.player_socket.lock() = socket;
    }

    pub fn get_player_socket(&self) -> Option<String> {
        self.player_socket.lock().clone()
    }

    /// Snapshot of room state for UI rendering.
    pub fn get_room_state(&self) -> RoomStateSnapshot {
        let r = self.room.lock();
        RoomStateSnapshot {
            position: r.position,
            paused: r.paused,
            set_by: r.set_by.clone(),
            seq: r.seq,
            playlist: r.playlist.clone(),
            playlist_index: r.playlist_index,
            ready_states: r.ready_states.clone(),
            controllers: r.controllers.iter().cloned().collect(),
        }
    }

    // ── Internal ──────────────────────────────────────────────────

    async fn send_to_host(&self, frame: &bytes::Bytes) {
        let hid = self.conn.hid();
        if let Err(e) = self.conn.send_one(&hid, frame).await {
            warn!("Failed to send to host {hid}: {e}");
        }
    }

    async fn bcast_ps(&self, do_seek: bool) {
        let (pos, paused, sb, seq, speed) = {
            let r = self.room.lock();
            (r.position, r.paused, r.set_by.clone(), r.seq, r.speed)
        };
        self.conn
            .bcast(
                &PlaystatePayload::with_speed(pos, paused, do_seek, &sb, seq, speed),
                None,
            )
            .await;
    }

    fn register_handlers(&self) {
        let conn = self.conn.clone();
        let room = self.room.clone();
        let lm = self.latency_map.clone();

        // Hello — version check (uses features from config, read at response time)
        let c0 = conn.clone();
        let feats = self.features.clone(); // Arc<RwLock<Vec<String>>>
        self.conn.on_msg(
            MessageType::Hello,
            move |_: MessageType, data: &[u8], from: String| {
                match rmp_serde::from_slice::<HelloPayload>(data) {
                    Ok(hello) => {
                        info!(
                            "Hello from {from}: v{} features={:?}",
                            hello.version, hello.features
                        );
                        if hello.version != PROTOCOL_VERSION {
                            warn!(
                                "Version mismatch: peer {from} is v{}, we are v{PROTOCOL_VERSION}",
                                hello.version
                            );
                        }
                        // Respond with our own Hello — read current features at response time
                        let c = c0.clone();
                        let f = from.clone();
                        let f2 = feats.read().clone();
                        tokio::spawn(async move {
                            let p = HelloPayload::new(&c.uname(), PROTOCOL_VERSION, "", f2);
                            if let Ok(data) = wire::encode(&p) {
                                if let Err(e) = c.send_one(&f, &data).await {
                                    warn!("Failed to send hello response to {f}: {e}");
                                }
                            }
                        });
                    }
                    Err(e) => warn!("Bad Hello from {from}: {e}"),
                }
            },
        );

        // UserInfo — log features
        self.conn.on_msg(
            MessageType::UserInfo,
            move |_: MessageType, data: &[u8], from: String| {
                if let Ok(info) = rmp_serde::from_slice::<UserInfoPayload>(data) {
                    info!(
                        "UserInfo from {from}: {} features={:?}",
                        info.username, info.features
                    );
                }
            },
        );

        // PeerDisconnect — clean removal
        self.conn.on_msg(
            MessageType::PeerDisconnect,
            move |_: MessageType, data: &[u8], from: String| {
                if let Ok(pd) = rmp_serde::from_slice::<PeerDisconnectPayload>(data) {
                    info!("Peer {from} disconnecting: {}", pd.reason);
                }
                // Removal handled by ICE/PC state change, but we acknowledge
            },
        );

        // Playstate
        let c1 = conn.clone();
        let r1 = room.clone();
        let psock = self.player_socket.clone();
        self.conn.on_msg(
            MessageType::Playstate,
            move |_: MessageType, data: &[u8], from: String| {
                if c1.is_host() && from != c1.pid() {
                    warn!("Playstate from non-self on host");
                    return;
                }
                if !c1.is_host() && from != c1.hid() {
                    warn!("Playstate from non-host");
                    return;
                }
                match rmp_serde::from_slice::<PlaystatePayload>(data) {
                    Ok(p) => {
                        let mut r = r1.lock();
                        if p.seq <= r.seq {
                            debug!("Stale playstate seq={}", p.seq);
                            return;
                        }
                        // Latency compensation: adjust position by network delay
                        let now = crate::now_ms();
                        let latency_secs = if p.timestamp > 0 && now > p.timestamp {
                            (now - p.timestamp) as f64 / 1000.0
                        } else {
                            0.0
                        };
                        let adjusted_pos = if !p.paused {
                            p.position + latency_secs * p.speed
                        } else {
                            p.position
                        };
                        r.position = adjusted_pos;
                        r.paused = p.paused;
                        r.set_by = p.set_by;
                        r.seq = p.seq;
                        if (p.speed - 1.0).abs() > 0.001 {
                            r.speed = p.speed;
                        }
                        drop(r);
                        // Drive local player to match
                        if let Some(ref sock) = *psock.lock() {
                            let sock_path = sock.clone();
                            if p.do_seek {
                                let s = sock_path.clone();
                                let seek_pos = adjusted_pos;
                                tokio::spawn(async move {
                                    if let Err(e) =
                                        crate::player_controller::PlayerController::seek(
                                            &s, seek_pos,
                                        )
                                        .await
                                    {
                                        error!("Player seek failed: {e}");
                                    }
                                });
                            }
                            if p.paused {
                                let s = sock_path.clone();
                                tokio::spawn(async move {
                                    if let Err(e) =
                                        crate::player_controller::PlayerController::pause(&s).await
                                    {
                                        error!("Player pause failed: {e}");
                                    }
                                });
                            } else {
                                let s = sock_path;
                                tokio::spawn(async move {
                                    if let Err(e) =
                                        crate::player_controller::PlayerController::play(&s).await
                                    {
                                        error!("Player play failed: {e}");
                                    }
                                });
                            }
                        }
                    }
                    Err(e) => warn!("Bad Playstate: {e}"),
                }
            },
        );

        // PlaystateRequest — validate controller, update, broadcast
        let c2 = conn.clone();
        let r2 = room.clone();
        self.conn.on_msg(
            MessageType::PlaystateRequest,
            move |_: MessageType, data: &[u8], from: String| {
                if !c2.is_host() {
                    warn!("PlaystateRequest from non-host {from}");
                    return;
                }
                let allowed = {
                    let r = r2.lock();
                    r.controllers.contains(&from) || from == c2.pid()
                };
                if !allowed {
                    warn!("PlaystateRequest denied — {from} is not a controller");
                    return;
                }
                match rmp_serde::from_slice::<PlaystateRequestPayload>(data) {
                    Ok(req) => {
                        let do_seek = matches!(req.action, PlaystateAction::Seek);
                        {
                            let mut r = r2.lock();
                            match req.action {
                                PlaystateAction::Seek => {
                                    r.position = req.position;
                                    r.set_by = from.clone();
                                    r.seq += 1;
                                }
                                PlaystateAction::Pause => {
                                    r.paused = true;
                                    r.set_by = from.clone();
                                    r.seq += 1;
                                }
                                PlaystateAction::Play => {
                                    r.paused = false;
                                    r.set_by = from.clone();
                                    r.seq += 1;
                                }
                                PlaystateAction::SetSpeed(new_speed) => {
                                    r.speed = new_speed;
                                    r.set_by = from.clone();
                                    r.seq += 1;
                                }
                            }
                        }
                        let (pos, paused, sb, seq, speed) = {
                            let r = r2.lock();
                            (r.position, r.paused, r.set_by.clone(), r.seq, r.speed)
                        };
                        match wire::encode(&PlaystatePayload::with_speed(
                            pos, paused, do_seek, &sb, seq, speed,
                        )) {
                            Ok(frame) => {
                                let c = c2.clone();
                                tokio::spawn(async move {
                                    // Re-check is_host() before broadcasting in case host changed
                                    if c.is_host() {
                                        c.send_all(&frame, None).await;
                                    } else {
                                        warn!(
                                            "PlaystateRequest: no longer host, skipping broadcast"
                                        );
                                    }
                                });
                            }
                            Err(e) => error!("encode playstate: {e}"),
                        }
                    }
                    Err(e) => warn!("Bad PlaystateRequest: {e}"),
                }
            },
        );

        // Chat — host relays
        let c3 = conn.clone();
        self.conn.on_msg(
            MessageType::Chat,
            move |_: MessageType, data: &[u8], from: String| {
                if !c3.is_host() {
                    warn!("Chat from non-host {from}");
                    return;
                }
                match rmp_serde::from_slice::<ChatPayload>(data) {
                    Ok(p) => {
                        debug!("Chat: {}", p.message);
                        let c = c3.clone();
                        tokio::spawn(async move {
                            c.bcast(&p, None).await;
                        });
                    }
                    Err(e) => warn!("Bad Chat: {e}"),
                }
            },
        );

        // Readiness — host tracks and relays; peers just process locally
        let c4 = conn.clone();
        let r4 = room.clone();
        self.conn.on_msg(
            MessageType::Readiness,
            move |_: MessageType, data: &[u8], from: String| match rmp_serde::from_slice::<
                ReadinessPayload,
            >(data)
            {
                Ok(p) => {
                    if c4.is_host() {
                        r4.lock()
                            .ready_states
                            .insert(p.username.clone(), p.is_ready);
                        // Only host relays to avoid amplification loop
                        let c = c4.clone();
                        tokio::spawn(async move {
                            c.bcast(&p, None).await;
                        });
                    }
                    // Non-host peers just update local ready_states for UI
                    else {
                        r4.lock()
                            .ready_states
                            .insert(p.username.clone(), p.is_ready);
                        debug!(
                            "Readiness update from {from}: {} ready={}",
                            p.username, p.is_ready
                        );
                    }
                }
                Err(e) => warn!("Bad Readiness: {e}"),
            },
        );

        // PlaylistRequest — host handles and broadcasts
        let c5 = conn.clone();
        let r5 = room.clone();
        let mpl = self.max_pl_items;
        self.conn.on_msg(
            MessageType::PlaylistRequest,
            move |_: MessageType, data: &[u8], from: String| {
                if !c5.is_host() {
                    warn!("PlaylistRequest from non-host {from}");
                    return;
                }
                // Only controllers (or the host itself) can modify playlist
                {
                    let allowed = {
                        let r = r5.lock();
                        r.controllers.contains(&from) || from == c5.pid()
                    };
                    if !allowed {
                        warn!("PlaylistRequest denied — {from} is not a controller");
                        return;
                    }
                }
                match rmp_serde::from_slice::<PlaylistRequestPayload>(data) {
                    Ok(req) => {
                        let (files, idx, set_by) = match req.action {
                            PlaylistAction::SetPlaylist => {
                                let files: Vec<FileEntry> =
                                    req.files.into_iter().take(mpl).collect();
                                let idx = {
                                    let mut r = r5.lock();
                                    r.playlist = files.clone();
                                    r.playlist_index
                                };
                                (files, idx, from.clone())
                            }
                            PlaylistAction::SetIndex => {
                                let (files, idx) = {
                                    let mut r = r5.lock();
                                    r.playlist_index = req.index;
                                    r.position = 0.0;
                                    r.seq += 1;
                                    (r.playlist.clone(), r.playlist_index)
                                };
                                (files, idx, from.clone())
                            }
                        };
                        // Broadcast the change to all peers
                        let c = c5.clone();
                        tokio::spawn(async move {
                            c.bcast(
                                &PlaylistChangePayload {
                                    files,
                                    index: idx,
                                    set_by,
                                },
                                None,
                            )
                            .await;
                        });
                    }
                    Err(e) => warn!("Bad PlaylistRequest: {e}"),
                }
            },
        );

        // PlaylistChange — peers receive playlist updates from host
        let r6 = room.clone();
        let conn6 = self.conn.clone();
        self.conn.on_msg(
            MessageType::PlaylistChange,
            move |_: MessageType, data: &[u8], from: String| {
                // Read hid/is_host at runtime, not capture time
                if from == conn6.hid() || conn6.is_host() {
                    if let Ok(p) = rmp_serde::from_slice::<PlaylistChangePayload>(data) {
                        let mut room = r6.lock();
                        room.playlist = p.files;
                        room.playlist_index = p.index;
                        info!(
                            "Playlist updated: {} files, index={}",
                            room.playlist.len(),
                            room.playlist_index
                        );
                    }
                }
            },
        );

        // Latency ping → pong
        let c6 = conn.clone();
        self.conn.on_msg(
            MessageType::LatencyPing,
            move |_: MessageType, data: &[u8], from: String| match rmp_serde::from_slice::<
                LatencyPingPayload,
            >(data)
            {
                Ok(ping) => {
                    let pong = LatencyPongPayload::reply(&ping);
                    match wire::encode(&pong) {
                        Ok(frame) => {
                            let c = c6.clone();
                            let f = from.clone();
                            tokio::spawn(async move {
                                if let Err(e) = c.send_one(&f, &frame).await {
                                    warn!("pong to {f}: {e}");
                                }
                            });
                        }
                        Err(e) => error!("encode pong: {e}"),
                    }
                }
                Err(e) => warn!("Bad LatencyPing: {e}"),
            },
        );

        // Latency pong → RTT tracking with threshold warning
        self.conn.on_msg(MessageType::LatencyPong, {
            let lm = lm.clone();
            move |_: MessageType, data: &[u8], from: String| match rmp_serde::from_slice::<
                LatencyPongPayload,
            >(data)
            {
                Ok(pong) => {
                    let rtt = (now_ms() - pong.send_time) as f64 / 1000.0;
                    lm.lock().insert(from.clone(), rtt);
                    if rtt > LATENCY_WARN_MS {
                        warn!("High latency to {from}: {:.0}ms", rtt * 1000.0);
                    }
                }
                Err(e) => warn!("Bad LatencyPong: {e}"),
            }
        });

        // VoiceMute — store peer mute status and host relays to other peers
        let vm = self.voice_mutes.clone();
        let c7 = conn.clone();
        self.conn.on_msg(
            MessageType::VoiceMute,
            move |_: MessageType, data: &[u8], from: String| {
                if let Ok(p) = rmp_serde::from_slice::<VoiceMutePayload>(data) {
                    info!("Peer {from} muted={}", p.muted);
                    vm.lock().insert(from.clone(), p.muted);
                    // Host relays VoiceMute to all other peers
                    if c7.is_host() {
                        let c = c7.clone();
                        let p2 = p;
                        tokio::spawn(async move {
                            c.bcast(&p2, None).await;
                        });
                    }
                }
            },
        );

        // ControllerChange — sync controller set across peers
        // Only accept from host to prevent spoofing
        let ct_room = room.clone();
        let ct_conn = conn.clone();
        self.conn.on_msg(
            MessageType::ControllerChange,
            move |_: MessageType, data: &[u8], _from: String| {
                // Only accept controller changes from the current host
                if _from != ct_conn.hid() {
                    warn!("ControllerChange from non-host {_from} — ignored");
                    return;
                }
                if let Ok(p) = rmp_serde::from_slice::<ControllerChangePayload>(data) {
                    let mut r = ct_room.lock();
                    match p.action {
                        ControllerAction::Add => {
                            r.controllers.insert(p.peer_id.clone());
                        }
                        ControllerAction::Remove => {
                            r.controllers.remove(&p.peer_id);
                        }
                    }
                    info!("Controller {:?}: {}", p.action, p.peer_id);
                }
            },
        );
    }
}

async fn host_loop(
    conn: ConnectionManager,
    room: Arc<Mutex<RoomState>>,
    shutdown: Arc<Notify>,
    interval_ms: u64,
) {
    info!("Host sync loop started (interval={interval_ms}ms)");
    loop {
        tokio::select! {
            _ = shutdown.notified() => {
                info!("Host sync loop stopped");
                break;
            }
            _ = time::sleep(Duration::from_millis(interval_ms)) => {
                // Guard: only broadcast if still host (covers host migration edge case)
                if !conn.is_host() {
                    debug!("Host loop: no longer host, sleeping");
                    continue;
                }
                let (pos, paused, sb, seq, speed) = {
                    let r = room.lock();
                    (r.position, r.paused, r.set_by.clone(), r.seq, r.speed)
                };
                conn.bcast(&PlaystatePayload::with_speed(pos, paused, false, &sb, seq, speed), None).await;
            }
        }
    }
}

async fn ping_loop(conn: ConnectionManager, shutdown: Arc<Notify>, interval_ms: u64) {
    loop {
        tokio::select! {
            _ = shutdown.notified() => {
                info!("Ping loop stopped");
                break;
            }
            _ = time::sleep(Duration::from_millis(interval_ms)) => {
                match wire::encode(&LatencyPingPayload { send_time: now_ms() }) {
                    Ok(frame) => {
                        for pid in conn.peers() {
                            if let Err(e) = conn.send_one(&pid, &frame).await {
                                warn!("Ping to {pid} failed: {e}");
                            }
                        }
                    }
                    Err(e) => error!("encode ping: {e}"),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sync_manager_not_host_initially() {
        let conn = ConnectionManager::new("alice", vec![]);
        let sync = SyncManager::new(conn, P2pConfig::default());
        assert!(!sync.is_host());
    }

    #[test]
    fn test_add_remove_controller() {
        let conn = ConnectionManager::new("alice", vec![]);
        let sync = SyncManager::new(conn, P2pConfig::default());
        assert!(sync.room.lock().controllers.is_empty());
        sync.add_controller("peer-1");
        assert!(sync.room.lock().controllers.contains("peer-1"));
        sync.remove_controller("peer-1");
        assert!(sync.room.lock().controllers.is_empty());
    }

    #[test]
    fn test_latency_empty() {
        assert!(
            SyncManager::new(ConnectionManager::new("a", vec![]), P2pConfig::default())
                .get_latencies()
                .is_empty()
        );
    }

    #[test]
    fn test_room_state_default() {
        let s = RoomState::default();
        assert_eq!(s.position, 0.0);
        assert!(s.paused);
        assert!(s.ready_states.is_empty());
    }

    #[test]
    fn test_host_updates_position() {
        let conn = ConnectionManager::new("alice", vec![]);
        conn.set_id("peer-1", "peer-1");
        let sync = SyncManager::new(conn, P2pConfig::default());
        sync.update_playstate(42.0, false);
        assert_eq!(sync.room.lock().position, 42.0);
    }

    #[test]
    fn test_version_constant() {
        assert!(!PROTOCOL_VERSION.is_empty());
        assert!(PROTOCOL_VERSION.starts_with('2'));
    }

    // ── Helpers ───────────────────────────────────────────────────

    /// Create a SyncManager configured as host (pid == hid).
    fn make_test_sync(host: bool) -> SyncManager {
        let conn = ConnectionManager::new("testuser", vec![]);
        if host {
            conn.set_id("testuser-id", "testuser-id");
        } else {
            conn.set_id("testuser-id", "host-id");
        }
        SyncManager::new(conn, P2pConfig::default())
    }

    fn config_with_max_chat(max_len: usize) -> P2pConfig {
        let mut cfg = P2pConfig::default();
        cfg.sync.max_chat_length = max_len;
        cfg
    }

    fn config_with_max_playlist(max_items: usize) -> P2pConfig {
        let mut cfg = P2pConfig::default();
        cfg.sync.max_playlist_items = max_items;
        cfg
    }

    // ── Async: send_state_to ──────────────────────────────────────

    #[tokio::test]
    async fn test_send_state_to_no_panic() {
        let sync = make_test_sync(false);
        // Should not panic even though target peer doesn't exist.
        sync.send_state_to("nonexistent-peer").await;
    }

    #[tokio::test]
    async fn test_send_state_to_as_host_no_panic() {
        let sync = make_test_sync(true);
        sync.send_state_to("nonexistent-peer").await;
    }

    // ── Async: request_seek / pause / play (non-host) ─────────────

    #[tokio::test]
    async fn test_request_seek_non_host_no_panic() {
        let sync = make_test_sync(false);
        sync.request_seek(99.5).await;
    }

    #[tokio::test]
    async fn test_request_pause_non_host_no_panic() {
        let sync = make_test_sync(false);
        sync.request_pause().await;
    }

    #[tokio::test]
    async fn test_request_play_non_host_no_panic() {
        let sync = make_test_sync(false);
        sync.request_play().await;
    }

    #[tokio::test]
    async fn test_request_seek_as_host_no_panic() {
        let sync = make_test_sync(true);
        // update_playstate so there is state to broadcast
        sync.update_playstate(10.0, false);
        sync.request_seek(42.0).await;
    }

    // ── Async: set_playlist truncation ────────────────────────────

    #[tokio::test]
    async fn test_set_playlist_respects_max_as_host() {
        let conn = ConnectionManager::new("testhost", vec![]);
        conn.set_id("testhost-id", "testhost-id");
        let sync = SyncManager::new(conn, config_with_max_playlist(3));
        // Send more files than max_pl_items; only 3 should be kept
        let files: Vec<FileEntry> = (0..10)
            .map(|i| FileEntry {
                name: format!("file_{i}.mp4"),
                duration: 120.0,
            })
            .collect();
        sync.set_playlist(files).await;
        let snapshot = sync.get_room_state();
        assert_eq!(snapshot.playlist.len(), 3);
        assert_eq!(snapshot.playlist[0].name, "file_0.mp4");
    }

    #[tokio::test]
    async fn test_set_playlist_respects_max_non_host() {
        let sync = make_test_sync(false);
        // Even non-host codepath does truncation before encoding.
        let files: Vec<FileEntry> = (0..5)
            .map(|i| FileEntry {
                name: format!("video_{i}.mkv"),
                duration: 60.0,
            })
            .collect();
        // Default max_pl_items is 250, but this call exercises the codepath.
        sync.set_playlist(files).await;
    }

    // ── Async: send_chat truncation + emoji boundary ─────────────

    #[tokio::test]
    async fn test_send_chat_truncation_no_panic() {
        // max_chat = 10, send a 50-char ASCII string
        let conn = ConnectionManager::new("chatter", vec![]);
        conn.set_id("chatter-id", "host-id");
        let sync = SyncManager::new(conn, config_with_max_chat(10));
        let long_msg = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwx";
        assert!(long_msg.len() > 10);
        sync.send_chat(long_msg).await;
    }

    #[tokio::test]
    async fn test_send_chat_emoji_boundary_no_panic() {
        // Place a multi-byte emoji right at the truncation boundary.
        // '😀' is 4 bytes. Message "aaaaa😀bbbbb" with max_chat=6
        // means the char boundary check kicks in.
        let conn = ConnectionManager::new("chatter", vec![]);
        conn.set_id("chatter-id", "host-id");
        let sync = SyncManager::new(conn, config_with_max_chat(6));
        // "aaaaa" = 5 bytes, then "😀" = 4 bytes (positions 5-8),
        // then "bbbbb" = 5 bytes. max_chat=6 lands inside the emoji.
        sync.send_chat("aaaaa😀bbbbb").await;
    }

    #[tokio::test]
    async fn test_send_chat_short_message_no_truncation() {
        let conn = ConnectionManager::new("chatter", vec![]);
        conn.set_id("chatter-id", "host-id");
        let sync = SyncManager::new(conn, config_with_max_chat(100));
        let short = "hello";
        sync.send_chat(short).await;
    }

    // ── Sync: controller management ───────────────────────────────

    #[test]
    fn test_is_controller() {
        let sync = make_test_sync(false);
        assert!(!sync.is_controller("peer-42"));
        sync.add_controller("peer-42");
        assert!(sync.is_controller("peer-42"));
        sync.remove_controller("peer-42");
        assert!(!sync.is_controller("peer-42"));
    }

    #[test]
    fn test_self_is_always_controller() {
        let sync = make_test_sync(false);
        // pid is "testuser-id" — is_controller always returns true for own pid
        assert!(sync.is_controller("testuser-id"));
    }

    #[test]
    fn test_remove_nonexistent_controller_no_panic() {
        let sync = make_test_sync(false);
        sync.remove_controller("no-such-peer");
    }

    // ── Sync: room state snapshot ─────────────────────────────────

    #[test]
    fn test_get_room_state_snapshot_consistent() {
        let sync = make_test_sync(true);
        sync.update_playstate(12.5, false);
        sync.add_controller("ctrl-1");
        let snap = sync.get_room_state();
        assert_eq!(snap.position, 12.5);
        assert!(!snap.paused);
        assert!(snap.seq > 0);
        assert!(snap.controllers.contains(&"ctrl-1".to_string()));
    }

    #[test]
    fn test_room_state_snapshot_playlist() {
        let sync = make_test_sync(true);
        {
            let mut r = sync.room.lock();
            r.playlist = vec![
                FileEntry {
                    name: "ep1.mp4".into(),
                    duration: 600.0,
                },
                FileEntry {
                    name: "ep2.mp4".into(),
                    duration: 720.0,
                },
            ];
            r.playlist_index = 1;
        }
        let snap = sync.get_room_state();
        assert_eq!(snap.playlist.len(), 2);
        assert_eq!(snap.playlist[0].name, "ep1.mp4");
        assert_eq!(snap.playlist[1].name, "ep2.mp4");
        assert_eq!(snap.playlist_index, 1);
    }

    // ── Sync: latency map ─────────────────────────────────────────

    #[test]
    fn test_latency_map_returns_clone() {
        let sync = make_test_sync(false);
        sync.latency_map.lock().insert("peer-a".into(), 0.123);
        let latencies = sync.get_latencies();
        assert_eq!(latencies.get("peer-a"), Some(&0.123));
        // Mutating the returned clone must not affect the original
        drop(latencies);
        assert!(sync.get_latencies().contains_key("peer-a"));
    }

    // ── Sync: player socket roundtrip ─────────────────────────────

    #[test]
    fn test_set_get_player_socket() {
        let sync = make_test_sync(false);
        assert!(sync.get_player_socket().is_none());
        sync.set_player_socket(Some("/tmp/mpv.sock".into()));
        assert_eq!(sync.get_player_socket(), Some("/tmp/mpv.sock".into()));
        sync.set_player_socket(None);
        assert!(sync.get_player_socket().is_none());
    }

    // ── Sync: update_playstate non-host ───────────────────────────

    #[test]
    fn test_update_playstate_ignored_when_not_host() {
        let sync = make_test_sync(false);
        sync.update_playstate(100.0, false);
        // Room state should remain at default since not host
        assert_eq!(sync.room.lock().position, 0.0);
        assert!(sync.room.lock().paused);
        assert_eq!(sync.room.lock().seq, 0);
    }

    // ── Sync: misc public accessors ───────────────────────────────

    #[test]
    fn test_get_peer_stats_empty() {
        let sync = make_test_sync(false);
        let stats = sync.get_peer_stats();
        assert!(stats.is_empty());
    }

    #[test]
    fn test_get_connection_returns_clone() {
        let sync = make_test_sync(false);
        let conn = sync.get_connection();
        assert_eq!(conn.uname(), "testuser");
        assert!(!conn.is_host());
    }

    // ── Sync: update_speed ────────────────────────────────────────

    #[tokio::test]
    async fn test_update_speed_as_host() {
        let sync = make_test_sync(true);
        sync.update_speed(2.0).await;
        assert_eq!(sync.room.lock().speed, 2.0);
        assert_eq!(sync.room.lock().seq, 1);
    }

    #[tokio::test]
    async fn test_update_speed_ignored_when_not_host() {
        let sync = make_test_sync(false);
        sync.update_speed(3.0).await;
        assert_eq!(sync.room.lock().speed, 1.0); // default
        assert_eq!(sync.room.lock().seq, 0);
    }

    // ── Async: send_controller_change ─────────────────────────────

    #[tokio::test]
    async fn test_send_controller_change_as_host_no_panic() {
        let sync = make_test_sync(true);
        sync.send_controller_change("peer-x", ControllerAction::Add)
            .await;
        sync.send_controller_change("peer-x", ControllerAction::Remove)
            .await;
    }

    #[tokio::test]
    async fn test_send_controller_change_ignored_non_host() {
        let sync = make_test_sync(false);
        sync.send_controller_change("peer-x", ControllerAction::Add)
            .await;
    }

    // ── Async: send_file_info ─────────────────────────────────────

    #[tokio::test]
    async fn test_send_file_info_as_host_no_panic() {
        let sync = make_test_sync(true);
        sync.send_file_info(Some(FileMetadata {
            name: "movie.mkv".into(),
            size: 1_000_000,
            duration: 3600.0,
            checksum: None,
        }))
        .await;
        sync.send_file_info(None).await;
    }

    #[tokio::test]
    async fn test_send_file_info_ignored_non_host() {
        let sync = make_test_sync(false);
        sync.send_file_info(Some(FileMetadata {
            name: "movie.mkv".into(),
            size: 1_000_000,
            duration: 3600.0,
            checksum: None,
        }))
        .await;
    }

    // ── Async: set_ready ──────────────────────────────────────────

    #[tokio::test]
    async fn test_set_ready_non_host_no_panic() {
        let sync = make_test_sync(false);
        sync.set_ready(true, None).await;
        sync.set_ready(false, Some("bob")).await;
    }

    #[tokio::test]
    async fn test_set_ready_as_host_updates_state() {
        let sync = make_test_sync(true);
        sync.set_ready(true, None).await;
        assert!(sync.room.lock().ready_states.get("testuser") == Some(&true));
        sync.set_ready(false, None).await;
        assert!(sync.room.lock().ready_states.get("testuser") == Some(&false));
    }

    // ── Async: send_voice_mute ────────────────────────────────────

    #[tokio::test]
    async fn test_send_voice_mute_non_host_no_panic() {
        let sync = make_test_sync(false);
        sync.send_voice_mute(true).await;
        sync.send_voice_mute(false).await;
    }

    #[tokio::test]
    async fn test_send_voice_mute_as_host_no_panic() {
        let sync = make_test_sync(true);
        sync.send_voice_mute(true).await;
    }

    // ── Async: request_set_speed ──────────────────────────────────

    #[tokio::test]
    async fn test_request_set_speed_non_host_no_panic() {
        let sync = make_test_sync(false);
        sync.request_set_speed(1.5).await;
    }

    #[tokio::test]
    async fn test_request_set_speed_as_host() {
        let sync = make_test_sync(true);
        sync.request_set_speed(2.5).await;
        assert_eq!(sync.room.lock().speed, 2.5);
        assert_eq!(sync.room.lock().seq, 1);
    }

    // ── Async: set_playlist_index ─────────────────────────────────

    #[tokio::test]
    async fn test_set_playlist_index_as_host() {
        let sync = make_test_sync(true);
        // Need playlist first
        {
            let mut r = sync.room.lock();
            r.playlist = vec![
                FileEntry {
                    name: "a.mp4".into(),
                    duration: 100.0,
                },
                FileEntry {
                    name: "b.mp4".into(),
                    duration: 200.0,
                },
            ];
        }
        sync.set_playlist_index(1).await;
        let snap = sync.get_room_state();
        assert_eq!(snap.playlist_index, 1);
        assert_eq!(snap.position, 0.0); // reset on index change
    }

    #[tokio::test]
    async fn test_set_playlist_index_non_host_no_panic() {
        let sync = make_test_sync(false);
        sync.set_playlist_index(0).await;
    }

    // ── Misc: now_ms helper ───────────────────────────────────────

    #[test]
    fn test_now_ms_returns_reasonable_value() {
        let t = now_ms();
        assert!(t > 1_700_000_000_000); // after ~2023
        assert!(t < 3_000_000_000_000); // before ~2065
        let t2 = now_ms();
        assert!(t2 >= t);
    }

    // ── Misc: RoomStateSnapshot derives ───────────────────────────

    #[test]
    fn test_room_state_snapshot_debug_and_clone() {
        let snap = RoomStateSnapshot {
            position: 5.0,
            paused: true,
            set_by: "alice".into(),
            seq: 42,
            playlist: vec![],
            playlist_index: 0,
            ready_states: HashMap::new(),
            controllers: vec![],
        };
        let cloned = snap.clone();
        assert_eq!(cloned.position, 5.0);
        assert_eq!(cloned.seq, 42);
        assert_eq!(cloned.set_by, "alice");
        assert!(format!("{:?}", snap).contains("5.0"));
    }
}
