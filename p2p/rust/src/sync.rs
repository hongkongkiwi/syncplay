//! Host-authoritative state sync manager.
//!
//! Manages playstate sync, chat relay, readiness, playlist, controllers,
//! latency measurements, and handshake protocol.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use log::{debug, error, info, warn};
use parking_lot::Mutex;
use tokio::sync::Notify;
use tokio::time;

use crate::connection::{ConnectionManager, PROTOCOL_VERSION};
use crate::messages::*;
use crate::wire;

const SYNC_MS: u64 = 500;
const LATENCY_MS: u64 = 2000;
const MAX_PL_ITEMS: usize = 250;
const MAX_CHAT: usize = 2000;
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
        }
    }
}

impl SyncManager {
    pub fn new(conn: ConnectionManager) -> Self {
        let mgr = Self {
            conn: conn.clone(),
            room: Arc::new(Mutex::new(RoomState::default())),
            latency_map: Arc::new(Mutex::new(HashMap::new())),
            voice_mutes: Arc::new(Mutex::new(HashMap::new())),
            shutdown: Arc::new(Notify::new()),
            player_socket: Arc::new(Mutex::new(None)),
        };
        mgr.register_handlers();
        let c = conn.clone();
        let r = mgr.room.clone();
        let s = mgr.shutdown.clone();
        let m2 = mgr.clone();
        conn.on_host(move |_new_id: String, reason: String| {
            if c.is_host() {
                info!("I am now the host ({reason}) — starting sync loop");
                m2.add_controller(&c.pid());
                let c2 = c.clone();
                let r2 = r.clone();
                let s2 = s.clone();
                tokio::spawn(async move {
                    host_loop(c2, r2, s2).await;
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
            let c = self.conn.clone();
            let r = self.room.clone();
            let s = self.shutdown.clone();
            tokio::spawn(async move {
                host_loop(c, r, s).await;
            });
        }
        let c = self.conn.clone();
        let s = self.shutdown.clone();
        tokio::spawn(async move {
            ping_loop(c, s).await;
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
        let (pos, paused, sb, seq, files, idx, ready_states) = {
            let r = self.room.lock();
            (
                r.position,
                r.paused,
                r.set_by.clone(),
                r.seq,
                r.playlist.clone(),
                r.playlist_index,
                r.ready_states.clone(),
            )
        };
        // Send playstate
        let ps = PlaystatePayload::new(pos, paused, true, &sb, seq);
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

    // ── Chat ──────────────────────────────────────────────────────

    pub async fn send_chat(&self, msg: &str) {
        let truncated = if msg.len() > MAX_CHAT {
            // Truncate at char boundary to avoid breaking multi-byte/emoji
            let mut end = MAX_CHAT;
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
        let p = crate::messages::VoiceMutePayload { muted };
        if self.conn.is_host() {
            self.conn.bcast(&p, None).await;
        } else {
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
        let files = files.into_iter().take(MAX_PL_ITEMS).collect::<Vec<_>>();
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

    pub async fn send_file_info(&self, file: Option<FileMetadata>) {
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
    pub async fn send_controller_change(&self, peer_id: &str, action: &str) {
        self.conn
            .bcast(
                &ControllerChangePayload {
                    peer_id: peer_id.into(),
                    action: action.into(),
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
        let (pos, paused, sb, seq) = {
            let r = self.room.lock();
            (r.position, r.paused, r.set_by.clone(), r.seq)
        };
        self.conn
            .bcast(&PlaystatePayload::new(pos, paused, do_seek, &sb, seq), None)
            .await;
    }

    fn register_handlers(&self) {
        let conn = self.conn.clone();
        let room = self.room.clone();
        let lm = self.latency_map.clone();

        // Hello — version check
        let c0 = conn.clone();
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
                        // Respond with our own Hello
                        let c = c0.clone();
                        let f = from.clone();
                        tokio::spawn(async move {
                            let features =
                                vec!["chat".into(), "readiness".into(), "playlist".into()];
                            let p = HelloPayload::new(&c.uname(), PROTOCOL_VERSION, features);
                            if let Ok(data) = wire::encode(&p) {
                                let _ = c.send_one(&f, &data).await;
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
                        r.position = p.position;
                        r.paused = p.paused;
                        r.set_by = p.set_by;
                        r.seq = p.seq;
                        drop(r);
                        // Drive local player to match
                        if let Some(ref sock) = *psock.lock() {
                            let sock_path = sock.clone();
                            if p.do_seek {
                                let s = sock_path.clone();
                                tokio::spawn(async move {
                                    if let Err(e) =
                                        crate::player_controller::PlayerController::seek(
                                            &s, p.position,
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
                            }
                        }
                        let (pos, paused, sb, seq) = {
                            let r = r2.lock();
                            (r.position, r.paused, r.set_by.clone(), r.seq)
                        };
                        match wire::encode(&PlaystatePayload::new(pos, paused, do_seek, &sb, seq)) {
                            Ok(frame) => {
                                let c = c2.clone();
                                tokio::spawn(async move {
                                    c.send_all(&frame, None).await;
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
        self.conn.on_msg(
            MessageType::PlaylistRequest,
            move |_: MessageType, data: &[u8], from: String| {
                if !c5.is_host() {
                    warn!("PlaylistRequest from non-host {from}");
                    return;
                }
                match rmp_serde::from_slice::<PlaylistRequestPayload>(data) {
                    Ok(req) => {
                        let (files, idx, set_by) = match req.action {
                            PlaylistAction::SetPlaylist => {
                                let files: Vec<FileEntry> =
                                    req.files.into_iter().take(MAX_PL_ITEMS).collect();
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

        // VoiceMute — store peer mute status in dedicated map
        let vm = self.voice_mutes.clone();
        self.conn.on_msg(
            MessageType::VoiceMute,
            move |_: MessageType, data: &[u8], from: String| {
                if let Ok(p) = rmp_serde::from_slice::<crate::messages::VoiceMutePayload>(data) {
                    info!("Peer {from} muted={}", p.muted);
                    vm.lock().insert(from, p.muted);
                }
            },
        );

        // ControllerChange — sync controller set across peers
        let ct_room = room.clone();
        self.conn.on_msg(
            MessageType::ControllerChange,
            move |_: MessageType, data: &[u8], _from: String| {
                if let Ok(p) = rmp_serde::from_slice::<ControllerChangePayload>(data) {
                    let mut r = ct_room.lock();
                    match p.action.as_str() {
                        "add" => {
                            r.controllers.insert(p.peer_id.clone());
                        }
                        "remove" => {
                            r.controllers.remove(&p.peer_id);
                        }
                        _ => {}
                    }
                    info!("Controller {}: {}", p.action, p.peer_id);
                }
            },
        );
    }
}

async fn host_loop(conn: ConnectionManager, room: Arc<Mutex<RoomState>>, shutdown: Arc<Notify>) {
    info!("Host sync loop started");
    loop {
        tokio::select! {
            _ = shutdown.notified() => {
                info!("Host sync loop stopped");
                break;
            }
            _ = time::sleep(Duration::from_millis(SYNC_MS)) => {
                let (pos, paused, sb, seq) = {
                    let r = room.lock();
                    (r.position, r.paused, r.set_by.clone(), r.seq)
                };
                conn.bcast(&PlaystatePayload::new(pos, paused, false, &sb, seq), None).await;
            }
        }
    }
}

async fn ping_loop(conn: ConnectionManager, shutdown: Arc<Notify>) {
    loop {
        tokio::select! {
            _ = shutdown.notified() => {
                info!("Ping loop stopped");
                break;
            }
            _ = time::sleep(Duration::from_millis(LATENCY_MS)) => {
                match wire::encode(&LatencyPingPayload { send_time: now_ms() }) {
                    Ok(frame) => conn.send_all(&frame, None).await,
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
        let sync = SyncManager::new(conn);
        assert!(!sync.is_host());
    }

    #[test]
    fn test_add_remove_controller() {
        let conn = ConnectionManager::new("alice", vec![]);
        let sync = SyncManager::new(conn);
        assert!(sync.room.lock().controllers.is_empty());
        sync.add_controller("peer-1");
        assert!(sync.room.lock().controllers.contains("peer-1"));
        sync.remove_controller("peer-1");
        assert!(sync.room.lock().controllers.is_empty());
    }

    #[test]
    fn test_latency_empty() {
        assert!(SyncManager::new(ConnectionManager::new("a", vec![]))
            .get_latencies()
            .is_empty());
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
        let sync = SyncManager::new(conn);
        sync.update_playstate(42.0, false);
        assert_eq!(sync.room.lock().position, 42.0);
    }

    #[test]
    fn test_version_constant() {
        assert!(!PROTOCOL_VERSION.is_empty());
        assert!(PROTOCOL_VERSION.starts_with('2'));
    }
}
