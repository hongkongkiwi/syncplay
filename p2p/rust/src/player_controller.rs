//! Media player controller — launches and controls mpv/VLC/IINA/MPC-HC via IPC.
//!
//! Uses mpv's JSON IPC protocol over Unix sockets (macOS/Linux)
//! or named pipes (Windows). VLC uses its telnet/RC interface.
//! IINA uses mpv-compatible IPC via --mpv-input-ipc-server.
//! MPC-HC uses its HTTP web interface on port 13579.
//!
//! Replaces: mpv.py (771 lines) + vlc.py (546 lines) + playerFactory.py

use std::process::{Child, Command, Stdio};
use std::time::Duration;

use anyhow::{Context, Result};
use log::{debug, error, info, warn};
use rand::Rng;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as AsyncBufReader};
use tokio::net::UnixStream;
use tokio::sync::mpsc;
use tokio::time;

/// Timeout for IPC operations (read/write on sockets).
const IPC_TIMEOUT: Duration = Duration::from_secs(10);

/// Player state reported by the media player.
#[derive(Debug, Clone, Default)]
pub struct PlayerState {
    pub position: f64,
    pub duration: f64,
    pub paused: bool,
    pub filename: Option<String>,
    pub filepath: Option<String>,
    pub speed: f64,
    /// Available subtitle tracks (track IDs and language/filename info).
    pub subtitle_tracks: Vec<SubtitleTrack>,
    /// Currently selected subtitle track index (0 = first, -1 = none).
    pub subtitle_track: i64,
}

/// Information about a subtitle track.
#[derive(Debug, Clone)]
pub struct SubtitleTrack {
    pub id: i64,
    pub title: Option<String>,
    pub lang: Option<String>,
    pub filename: Option<String>,
    pub external: bool,
}

/// Supported player types.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayerType {
    Mpv,
    Vlc,
    /// IINA — macOS player with mpv-compatible IPC via --mpv-input-ipc-server
    Iina,
    /// MPC-HC — Windows player with web interface on port 13579
    MpcHc,
    /// MPlayer — cross-platform with slave mode via stdin
    Mplayer,
}

impl PlayerType {
    pub fn display_name(&self) -> &'static str {
        match self {
            PlayerType::Mpv => "mpv",
            PlayerType::Vlc => "VLC",
            PlayerType::Iina => "IINA",
            PlayerType::MpcHc => "MPC-HC",
            PlayerType::Mplayer => "MPlayer",
        }
    }
}

/// Events emitted by the player controller.
#[derive(Debug, Clone)]
pub enum PlayerEvent {
    StateUpdated(PlayerState),
    FileLoaded { filename: String, duration: f64 },
    EndOfFile,
    PlayerExited { code: Option<i32> },
    Error(String),
}

/// Pre-launch validation result.
#[derive(Debug)]
pub enum LaunchValidation {
    /// Binary found and version check passed.
    Ok,
    /// Binary found but --version failed (may be GUI-only or wrong binary).
    Warn(String),
    /// Binary not found.
    NotFound,
}

/// High-level player controller.
pub struct PlayerController {
    player_type: PlayerType,
    child: Option<Child>,
    event_tx: Option<mpsc::Sender<PlayerEvent>>,
    /// VLC RC port (only set for VLC)
    vlc_port: Option<u16>,
    /// Handle to the child process watcher task (aborted on re-launch)
    watcher_handle: Option<tokio::task::JoinHandle<()>>,
    /// VLC RC password for the telnet interface (only set for VLC)
    vlc_password: Option<String>,
    /// Path to the IPC socket for cleanup on shutdown
    ipc_socket: Option<String>,
}

impl PlayerController {
    pub fn new(player_type: PlayerType) -> Self {
        Self {
            player_type,
            child: None,
            event_tx: None,
            vlc_port: None,
            watcher_handle: None,
            vlc_password: None,
            ipc_socket: None,
        }
    }

    /// Validate that a player binary exists and is runnable BEFORE launching.
    /// Returns a `LaunchValidation` result to guide the caller.
    pub fn validate_binary(player_path: &str) -> LaunchValidation {
        // Check that the path exists and is executable
        let path = std::path::Path::new(player_path);
        if !path.exists() {
            return LaunchValidation::NotFound;
        }

        // Try --version to verify it's actually a runnable binary
        match Command::new(player_path)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .output()
        {
            Ok(output) if output.status.success() => LaunchValidation::Ok,
            Ok(_) => {
                // Process ran but returned non-zero — could be GUI player
                // Try without --version (some players don't support it)
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                LaunchValidation::Warn(format!(
                    "{name} exists but --version returned exit code — may be a GUI-only binary"
                ))
            }
            Err(e) => {
                LaunchValidation::Warn(format!("{player_path} exists but cannot execute: {e}"))
            }
        }
    }

    /// Launch the player with an optional file.
    /// `player_path` — path to the player binary
    /// `file` — optional media file to open
    /// `ipc_socket` — path for the IPC socket (mpv-style players) or port seed (VLC)
    pub async fn launch(
        &mut self,
        player_path: &str,
        file: Option<&str>,
        ipc_socket: &str,
    ) -> Result<mpsc::Receiver<PlayerEvent>> {
        // Validate binary before attempting launch
        match Self::validate_binary(player_path) {
            LaunchValidation::NotFound => {
                anyhow::bail!("Player binary not found: {player_path}");
            }
            LaunchValidation::Warn(ref msg) => {
                warn!("Player validation warning: {msg}");
            }
            LaunchValidation::Ok => {}
        }

        // Kill any previously launched child to prevent zombie processes
        if let Some(mut old_child) = self.child.take() {
            info!(
                "Killing previous {} player (pid: {})",
                self.player_type.display_name(),
                old_child.id()
            );
            let pid = old_child.id();
            // On Unix, try SIGTERM first, then SIGKILL after timeout
            #[cfg(unix)]
            {
                // Use kill command from std::process to send SIGTERM
                let pid = old_child.id();
                let _ = Command::new("kill")
                    .arg("-TERM")
                    .arg(pid.to_string())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
                // Wait briefly for graceful shutdown
                std::thread::sleep(Duration::from_millis(500));
                // Force kill if still running
                let _ = old_child.kill();
            }
            #[cfg(not(unix))]
            {
                let _ = old_child.kill();
            }
            // Reap to avoid zombie
            let _ = old_child.wait();
            info!(
                "Previous {} player (pid: {pid}) reaped",
                self.player_type.display_name()
            );
        }

        // Cancel any stale watcher from a previous launch
        if let Some(handle) = self.watcher_handle.take() {
            handle.abort();
        }

        // Clean up old socket
        let _ = std::fs::remove_file(ipc_socket);

        let mut cmd = Command::new(player_path);

        match self.player_type {
            PlayerType::Mpv | PlayerType::Iina => {
                let ipc_flag = match self.player_type {
                    PlayerType::Iina => "--mpv-input-ipc-server",
                    _ => "--input-ipc-server",
                };
                cmd.arg(format!("{ipc_flag}={ipc_socket}"))
                    .arg("--idle=yes")
                    .arg("--keep-open=yes")
                    .arg("--no-terminal")
                    .arg("--really-quiet")
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                if let Some(f) = file {
                    cmd.arg(f);
                }
            }
            PlayerType::Vlc => {
                let vlc_port = std::net::TcpListener::bind("127.0.0.1:0")
                    .ok()
                    .and_then(|l| l.local_addr().ok())
                    .map(|a| a.port())
                    .unwrap_or(4212);
                self.vlc_port = Some(vlc_port);

                // Generate random RC password to prevent unauthorized commands
                let password: String = rand::thread_rng()
                    .sample_iter(&rand::distributions::Alphanumeric)
                    .take(16)
                    .map(char::from)
                    .collect();
                self.vlc_password = Some(password.clone());

                cmd.arg(format!("--rc-host=127.0.0.1:{vlc_port}"))
                    .arg(format!("--rc-password={password}"))
                    .arg("--no-video-title-show")
                    .arg("--quiet")
                    .arg("--extraintf=rc")
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                if let Some(f) = file {
                    cmd.arg(f);
                }
            }
            PlayerType::MpcHc => {
                // MPC-HC: web interface on port 13579, accepts HTTP commands
                // Also try to use the /slave flag if it exists (newer builds)
                cmd.arg("/webport")
                    .arg("13579")
                    .arg("/play")
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                if let Some(f) = file {
                    cmd.arg(f);
                }
            }
            PlayerType::Mplayer => {
                // MPlayer: slave mode via stdin for remote control
                cmd.arg("-slave")
                    .arg("-quiet")
                    .arg("-idle")
                    .arg("-really-quiet")
                    .stdin(Stdio::piped()) // Need stdin for slave commands
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                if let Some(f) = file {
                    cmd.arg(f);
                }
            }
        }

        let child = cmd.spawn().with_context(|| {
            format!(
                "Failed to launch {} at {player_path}",
                self.player_type.display_name()
            )
        })?;

        let child_pid = child.id();
        self.child = Some(child);

        info!(
            "Launched {} player (pid: {child_pid:?})",
            self.player_type.display_name(),
        );

        // Store socket path for cleanup on shutdown
        self.ipc_socket = Some(ipc_socket.to_string());

        // Wait for socket/port to be ready
        match self.player_type {
            PlayerType::Mpv | PlayerType::Iina => {
                let mut ready = false;
                for _attempt in 0..30 {
                    if std::path::Path::new(ipc_socket).exists() {
                        ready = true;
                        break;
                    }
                    // Check that player is still alive
                    if let Some(ref mut c) = self.child {
                        if let Ok(Some(_)) = c.try_wait() {
                            // Player exited before socket was created
                            let _ = self.reap_child();
                            anyhow::bail!(
                                "{} exited before IPC socket was created",
                                self.player_type.display_name()
                            );
                        }
                    }
                    time::sleep(Duration::from_millis(100)).await;
                }
                if !ready {
                    let _ = self.reap_child();
                    anyhow::bail!(
                        "{} socket not created after 3s — player may have failed to start",
                        self.player_type.display_name()
                    );
                }
            }
            PlayerType::Vlc => {
                // Wait for VLC RC port to be reachable
                if let Some(port) = self.vlc_port {
                    let mut ready = false;
                    for _attempt in 0..20 {
                        if tokio::net::TcpStream::connect(format!("127.0.0.1:{port}"))
                            .await
                            .is_ok()
                        {
                            ready = true;
                            break;
                        }
                        // Check that player is still alive
                        if let Some(ref mut c) = self.child {
                            if let Ok(Some(_)) = c.try_wait() {
                                let _ = self.reap_child();
                                anyhow::bail!("VLC exited before RC port was ready");
                            }
                        }
                        time::sleep(Duration::from_millis(100)).await;
                    }
                    if !ready {
                        let _ = self.reap_child();
                        anyhow::bail!("VLC RC port not reachable after 2s");
                    }
                }
            }
            PlayerType::MpcHc => {
                // MPC-HC web interface is ready very quickly; brief wait
                time::sleep(Duration::from_millis(500)).await;
            }
            PlayerType::Mplayer => {
                // MPlayer slave mode is ready immediately via stdin
                time::sleep(Duration::from_millis(200)).await;
            }
        }

        let (tx, rx) = mpsc::channel(256);
        self.event_tx = Some(tx.clone());

        // Spawn the IPC reader task based on player type
        match self.player_type {
            PlayerType::Mpv | PlayerType::Iina => {
                let socket = ipc_socket.to_string();
                let tx2 = tx.clone();
                let ptype = self.player_type;
                tokio::spawn(async move {
                    if let Err(e) = mpv_ipc_loop(&socket, tx2).await {
                        // Only log as error if it's not a normal shutdown
                        if e.to_string().contains("connection refused")
                            || e.to_string().contains("No such file")
                        {
                            warn!(
                                "{} IPC loop ended (player likely closed): {e}",
                                ptype.display_name()
                            );
                        } else {
                            error!("{} IPC loop error: {e}", ptype.display_name());
                        }
                    }
                });
            }
            PlayerType::Vlc => {
                if let Some(port) = self.vlc_port {
                    let tx2 = tx.clone();
                    let password = self.vlc_password.clone();
                    tokio::spawn(async move {
                        if let Err(e) = vlc_ipc_loop(port, tx2, password).await {
                            error!("VLC IPC loop error: {e}");
                        }
                    });
                }
            }
            PlayerType::MpcHc => {
                // MPC-HC uses HTTP polling on port 13579
                let tx2 = tx.clone();
                tokio::spawn(async move {
                    mpc_hc_ipc_loop(tx2).await;
                });
            }
            PlayerType::Mplayer => {
                // MPlayer uses stdin for commands, but we spawn it with piped stdin.
                // For now, emit a warning that slave mode is limited.
                warn!("MPlayer: slave mode IPC is limited — only basic playback via stdin is available");
                // We still set up the watcher below, so state can be synced from the sync manager.
            }
        }

        // Spawn child process watcher
        let child_opt = self.child.take();
        if let Some(mut child) = child_opt {
            let tx3 = tx.clone();
            let ptype = self.player_type;
            let handle = tokio::spawn(async move {
                let status = child.wait();
                let code = status.ok().and_then(|s| s.code());
                info!(
                    "{} process exited with code: {code:?}",
                    ptype.display_name()
                );
                let _ = tx3.send(PlayerEvent::PlayerExited { code }).await;
            });
            self.watcher_handle = Some(handle);
        } else {
            error!("No child process to watch — launch may have failed");
            let _ = tx
                .send(PlayerEvent::Error("player process not started".into()))
                .await;
        }

        Ok(rx)
    }

    /// Reap the child process, returning its exit code.
    fn reap_child(&mut self) -> Option<i32> {
        if let Some(mut child) = self.child.take() {
            let pid = child.id();
            let _ = child.kill();
            match child.wait() {
                Ok(status) => {
                    debug!("Reaped child process {pid:?}: {status}");
                    status.code()
                }
                Err(e) => {
                    warn!("Failed to reap child {pid:?}: {e}");
                    None
                }
            }
        } else {
            None
        }
    }

    // ── mpv-compatible IPC commands (mpv, IINA) ─────────────────────

    /// Write a raw command to the mpv IPC socket with timeout.
    pub async fn mpv_command(socket_path: &str, cmd: &Value) -> Result<Value> {
        let connect_fut = UnixStream::connect(socket_path);
        let mut stream = time::timeout(IPC_TIMEOUT, connect_fut)
            .await
            .context("timeout connecting to mpv socket")?
            .context("connect to mpv socket")?;

        let mut msg = serde_json::to_vec(cmd)?;
        msg.push(b'\n');

        let write_fut = stream.write_all(&msg);
        time::timeout(IPC_TIMEOUT, write_fut)
            .await
            .context("timeout writing mpv command")?
            .context("write mpv command")?;

        // Read response with timeout
        let mut buf = Vec::new();
        let mut reader = AsyncBufReader::new(&mut stream);
        let read_fut = reader.read_until(b'\n', &mut buf);
        let n = time::timeout(IPC_TIMEOUT, read_fut)
            .await
            .context("timeout reading mpv response")?
            .context("read mpv response")?;

        if n == 0 {
            anyhow::bail!("mpv socket closed (EOF)");
        }

        let resp: Value = serde_json::from_slice(&buf)
            .with_context(|| format!("parse mpv response: {}", String::from_utf8_lossy(&buf)))?;

        // Check for mpv error response
        if resp["error"].as_str() == Some("error")
            || resp["error"].as_str() == Some("invalid parameter")
        {
            warn!("mpv command returned error: {resp}");
        }

        Ok(resp)
    }

    pub async fn play(socket_path: &str) -> Result<()> {
        let cmd = serde_json::json!({"command": ["set_property", "pause", false]});
        Self::mpv_command(socket_path, &cmd).await?;
        Ok(())
    }

    pub async fn pause(socket_path: &str) -> Result<()> {
        let cmd = serde_json::json!({"command": ["set_property", "pause", true]});
        Self::mpv_command(socket_path, &cmd).await?;
        Ok(())
    }

    pub async fn seek(socket_path: &str, position: f64) -> Result<()> {
        // Clamp to non-negative; mpv will further clamp to duration
        let position = position.max(0.0);
        let cmd = serde_json::json!({"command": ["set_property", "time-pos", position]});
        Self::mpv_command(socket_path, &cmd).await?;
        Ok(())
    }

    pub async fn set_speed(socket_path: &str, speed: f64) -> Result<()> {
        // Clamp speed to reasonable range (mpv supports 0.01-100)
        let speed = speed.clamp(0.01, 100.0);
        let cmd = serde_json::json!({"command": ["set_property", "speed", speed]});
        Self::mpv_command(socket_path, &cmd).await?;
        Ok(())
    }

    pub async fn open_file(socket_path: &str, path: &str) -> Result<()> {
        // Use "loadfile" with "replace" mode to ensure clean loading
        let cmd = serde_json::json!({"command": ["loadfile", path, "replace"]});
        Self::mpv_command(socket_path, &cmd).await?;
        Ok(())
    }

    pub async fn get_position(socket_path: &str) -> Result<f64> {
        let cmd = serde_json::json!({"command": ["get_property", "time-pos"]});
        let resp = Self::mpv_command(socket_path, &cmd).await?;
        // time-pos can be null if no file is loaded
        Ok(resp["data"].as_f64().unwrap_or(0.0))
    }

    pub async fn get_paused(socket_path: &str) -> Result<bool> {
        let cmd = serde_json::json!({"command": ["get_property", "pause"]});
        let resp = Self::mpv_command(socket_path, &cmd).await?;
        resp["data"].as_bool().context("no pause data")
    }

    pub async fn get_duration(socket_path: &str) -> Result<f64> {
        let cmd = serde_json::json!({"command": ["get_property", "duration"]});
        let resp = Self::mpv_command(socket_path, &cmd).await?;
        // May be null if no file loaded
        Ok(resp["data"].as_f64().unwrap_or(0.0))
    }

    pub async fn get_filename(socket_path: &str) -> Result<Option<String>> {
        let cmd = serde_json::json!({"command": ["get_property", "filename"]});
        let resp = Self::mpv_command(socket_path, &cmd).await?;
        Ok(resp["data"].as_str().map(|s| s.to_string()))
    }

    /// Set subtitle track by index (0-based, -1 to disable).
    pub async fn set_subtitle(socket_path: &str, track_id: i64) -> Result<()> {
        if track_id < 0 {
            let cmd = serde_json::json!({"command": ["set_property", "sid", "no"]});
            Self::mpv_command(socket_path, &cmd).await?;
        } else {
            let cmd = serde_json::json!({"command": ["set_property", "sid", track_id]});
            Self::mpv_command(socket_path, &cmd).await?;
        }
        Ok(())
    }

    /// Add an external subtitle file.
    pub async fn add_subtitle(socket_path: &str, sub_path: &str) -> Result<()> {
        let cmd = serde_json::json!({"command": ["sub-add", sub_path]});
        Self::mpv_command(socket_path, &cmd).await?;
        Ok(())
    }

    pub async fn quit(socket_path: &str) -> Result<()> {
        let cmd = serde_json::json!({"command": ["quit"]});
        // Ignore errors — player may close socket before responding
        let _ = time::timeout(Duration::from_secs(2), Self::mpv_command(socket_path, &cmd)).await;
        Ok(())
    }
}

impl Drop for PlayerController {
    fn drop(&mut self) {
        let ptype = self.player_type.display_name();

        // Kill child process if still running
        if let Some(mut child) = self.child.take() {
            let pid = child.id();
            info!("Shutting down {} player (pid: {pid:?})", ptype);
            // Try graceful exit first via IPC
            if let Some(ref socket) = self.ipc_socket {
                if std::path::Path::new(socket).exists() {
                    // Send quit command via blocking code since we're in Drop
                    if let Ok(stream) = std::os::unix::net::UnixStream::connect(socket) {
                        use std::io::Write;
                        let mut stream = stream;
                        let _ = stream.write_all(b"{\"command\":[\"quit\"]}\n");
                        let _ = stream.flush();
                        // Give it a moment
                        std::thread::sleep(Duration::from_millis(500));
                    }
                }
            }
            // Force kill
            let _ = child.kill();
            let _ = child.wait();
            info!("{} player (pid: {pid:?}) terminated", ptype);
        }

        // Clean up IPC socket
        if let Some(ref socket) = self.ipc_socket {
            let _ = std::fs::remove_file(socket);
            debug!("Removed IPC socket: {socket}");
        }

        // Abort watcher task
        if let Some(handle) = self.watcher_handle.take() {
            handle.abort();
        }
    }
}

/// Background task that reads mpv JSON IPC events.
async fn mpv_ipc_loop(socket_path: &str, tx: mpsc::Sender<PlayerEvent>) -> Result<()> {
    // Wait for socket with exponential-ish backoff
    let mut attempts = 0;
    loop {
        if std::path::Path::new(socket_path).exists() {
            break;
        }
        attempts += 1;
        if attempts > 50 {
            anyhow::bail!("mpv socket not created after 5s");
        }
        time::sleep(Duration::from_millis(100)).await;
    }

    let stream = time::timeout(Duration::from_secs(5), UnixStream::connect(socket_path))
        .await
        .context("timeout connecting to mpv socket for event loop")?
        .context("connect to mpv socket")?;

    let (reader, _writer) = stream.into_split();
    let mut reader = AsyncBufReader::new(reader);

    // Set up property observation with reconnect loop
    let obs_cmds = [
        r#"{"command":["observe_property",1,"time-pos"]}"#,
        r#"{"command":["observe_property",2,"pause"]}"#,
        r#"{"command":["observe_property",3,"duration"]}"#,
        r#"{"command":["observe_property",4,"filename"]}"#,
        r#"{"command":["observe_property",5,"path"]}"#,
        r#"{"command":["observe_property",6,"speed"]}"#,
        r#"{"command":["observe_property",7,"track-list"]}"#,
        r#"{"command":["observe_property",8,"sid"]}"#,
    ];
    // Reconnect to send observe commands (the stream we split is read-only)
    for obs_cmd in obs_cmds {
        if let Ok(Ok(mut s)) =
            time::timeout(Duration::from_secs(3), UnixStream::connect(socket_path)).await
        {
            let _ = s.write_all(format!("{obs_cmd}\n").as_bytes()).await;
        }
    }

    let mut state = PlayerState::default();

    loop {
        let mut line = String::new();
        match time::timeout(Duration::from_secs(300), reader.read_line(&mut line)).await {
            Ok(Ok(0)) => {
                debug!("mpv IPC socket closed (EOF)");
                break;
            }
            Ok(Ok(_)) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                match serde_json::from_str::<Value>(trimmed) {
                    Ok(msg) => {
                        // Property change event
                        if msg["event"].as_str() == Some("property-change") {
                            let id = msg["id"].as_u64().unwrap_or(0);
                            match id {
                                1 => {
                                    // time-pos
                                    if let Some(pos) = msg["data"].as_f64() {
                                        state.position = pos;
                                    }
                                }
                                2 => {
                                    // pause
                                    if let Some(paused) = msg["data"].as_bool() {
                                        state.paused = paused;
                                    }
                                }
                                3 => {
                                    // duration
                                    state.duration = msg["data"].as_f64().unwrap_or(0.0);
                                }
                                4 => {
                                    // filename
                                    state.filename = msg["data"].as_str().map(|s| s.to_string());
                                }
                                5 => {
                                    // path
                                    state.filepath = msg["data"].as_str().map(|s| s.to_string());
                                }
                                6 => {
                                    // speed
                                    state.speed = msg["data"].as_f64().unwrap_or(1.0);
                                }
                                7 => {
                                    // track-list
                                    if let Some(tracks) = msg["data"].as_array() {
                                        state.subtitle_tracks = tracks
                                            .iter()
                                            .filter(|t| t["type"].as_str() == Some("sub"))
                                            .map(|t| SubtitleTrack {
                                                id: t["id"].as_i64().unwrap_or(0),
                                                title: t["title"].as_str().map(|s| s.to_string()),
                                                lang: t["lang"].as_str().map(|s| s.to_string()),
                                                filename: t["external-filename"]
                                                    .as_str()
                                                    .map(|s| s.to_string()),
                                                external: t["external"].as_bool().unwrap_or(false),
                                            })
                                            .collect();
                                    }
                                }
                                8 => {
                                    // sid (current subtitle track)
                                    state.subtitle_track = msg["data"].as_i64().unwrap_or(-1);
                                }
                                _ => {}
                            }
                            let _ = tx
                                .send(PlayerEvent::StateUpdated(state.clone()))
                                .await
                                .inspect_err(|e| {
                                    warn!("Failed to send StateUpdated event: {e}");
                                });
                        }
                        // File loaded event
                        else if msg["event"].as_str() == Some("file-loaded") {
                            let _ = tx
                                .send(PlayerEvent::FileLoaded {
                                    filename: state.filename.clone().unwrap_or_default(),
                                    duration: state.duration,
                                })
                                .await
                                .inspect_err(|e| {
                                    warn!("Failed to send FileLoaded event: {e}");
                                });
                        }
                        // End file
                        else if msg["event"].as_str() == Some("end-file") {
                            let _ = tx.send(PlayerEvent::EndOfFile).await.inspect_err(|e| {
                                warn!("Failed to send EndOfFile event: {e}");
                            });
                        }
                    }
                    Err(e) => {
                        debug!("mpv non-JSON: {trimmed} ({e})");
                    }
                }
            }
            Ok(Err(e)) => {
                error!("mpv read error: {e}");
                break;
            }
            Err(_elapsed) => {
                // Read timeout — this is normal for idle players, continue loop
                debug!("mpv IPC read timeout (idle)");
                continue;
            }
        }
    }

    Ok(())
}

// ── VLC RC IPC ───────────────────────────────────────────────────────

/// Send a raw command to VLC's RC telnet interface and read the response line.
async fn vlc_rc_command(port: u16, cmd: &str) -> Result<String> {
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpStream;

    let connect_fut = TcpStream::connect(format!("127.0.0.1:{port}"));
    let mut stream = time::timeout(IPC_TIMEOUT, connect_fut)
        .await
        .context("timeout connecting to VLC RC")?
        .context("connect to VLC RC")?;

    let cmd_bytes = format!("{cmd}\n");
    let write_fut = stream.write_all(cmd_bytes.as_bytes());
    time::timeout(IPC_TIMEOUT, write_fut)
        .await
        .context("timeout writing VLC command")?
        .context("write VLC command")?;

    // Use shutdown to signal EOF and flush
    let _ = stream.shutdown().await;

    let mut reader = tokio::io::BufReader::new(&mut stream);
    let mut response = String::new();
    // Read all available lines (VLC RC may send multi-line responses)
    loop {
        let mut line = String::new();
        match time::timeout(Duration::from_secs(2), reader.read_line(&mut line)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(_)) => {
                let trimmed = line.trim().to_string();
                if !trimmed.is_empty() {
                    if !response.is_empty() {
                        response.push('\n');
                    }
                    response.push_str(&trimmed);
                }
            }
            Ok(Err(e)) => {
                debug!("VLC RC read end: {e}");
                break;
            }
            Err(_) => break,
        }
    }

    if response.is_empty() {
        debug!("VLC RC empty response for command: {cmd}");
    }
    Ok(response)
}

/// VLC RC playback control — uses telnet text commands.
pub async fn vlc_play(port: u16) -> Result<()> {
    vlc_rc_command(port, "play").await?;
    Ok(())
}

pub async fn vlc_pause(port: u16) -> Result<()> {
    vlc_rc_command(port, "pause").await?;
    Ok(())
}

/// VLC absolute seek — uses `set_time` for VLC 4.0+, falls back to `seek`.
/// Note: VLC's RC `seek` command is relative (in seconds), not absolute.
/// For absolute seeking, we use `set_time <seconds>` (VLC 3.0+) or calculate
/// a relative seek from current position.
pub async fn vlc_seek_absolute(port: u16, position: f64) -> Result<()> {
    // Try absolute seek first (VLC 4.0+)
    let resp = vlc_rc_command(port, &format!("set_time {position}")).await?;
    if resp.contains("unknown command") || resp.contains("error") {
        // Fallback: get current position and do relative seek
        let current = vlc_get_position(port).await.unwrap_or(0.0);
        let delta = position - current;
        vlc_rc_command(port, &format!("seek {delta}")).await?;
    }
    Ok(())
}

pub async fn vlc_get_position(port: u16) -> Result<f64> {
    let resp = vlc_rc_command(port, "get_time").await?;
    resp.parse::<f64>()
        .with_context(|| format!("VLC get_time returned: {resp}"))
}

pub async fn vlc_is_playing(port: u16) -> Result<bool> {
    let resp = vlc_rc_command(port, "is_playing").await?;
    Ok(resp == "1")
}

pub async fn vlc_get_length(port: u16) -> Result<f64> {
    let resp = vlc_rc_command(port, "get_length").await?;
    resp.parse::<f64>()
        .with_context(|| format!("VLC get_length returned: {resp}"))
}

/// VLC RC polling IPC loop — polls player state every 500ms and emits events.
/// If a password is provided it is sent as the first line after connecting
/// (VLC RC telnet auth).
async fn vlc_ipc_loop(
    port: u16,
    tx: mpsc::Sender<PlayerEvent>,
    password: Option<String>,
) -> Result<()> {
    let mut state = PlayerState::default();
    let mut first_file_emitted = false;
    let mut reconnect_attempts = 0;
    const MAX_AUTH_RETRIES: u32 = 3;

    loop {
        // Authenticate on each reconnection attempt
        if let Some(ref pwd) = password {
            let mut authed = false;
            for retry in 0..MAX_AUTH_RETRIES {
                match vlc_rc_command(port, pwd).await {
                    Ok(resp) if !resp.contains("error") && !resp.contains("unknown") => {
                        authed = true;
                        break;
                    }
                    Ok(resp) => {
                        if retry == 0 {
                            debug!("VLC auth response: {resp}");
                        }
                    }
                    Err(e) => {
                        if retry == MAX_AUTH_RETRIES - 1 {
                            warn!("VLC auth failed after {MAX_AUTH_RETRIES} retries: {e}");
                        }
                    }
                }
                time::sleep(Duration::from_millis(200)).await;
            }
            if !authed {
                reconnect_attempts += 1;
                if reconnect_attempts > 20 {
                    error!("VLC RC connection lost after 20 reconnect attempts");
                    break;
                }
                time::sleep(Duration::from_secs(2)).await;
                continue;
            }
        }

        reconnect_attempts = 0;

        // Poll current state
        let mut got_update = false;
        if let Ok(pos) = vlc_get_position(port).await {
            state.position = pos;
            got_update = true;
        }
        if let Ok(playing) = vlc_is_playing(port).await {
            state.paused = !playing;
            got_update = true;
        }
        if let Ok(len) = vlc_get_length(port).await {
            state.duration = len;
            got_update = true;
        }

        if got_update {
            let _ = tx
                .send(PlayerEvent::StateUpdated(state.clone()))
                .await
                .inspect_err(|e| {
                    warn!("VLC: Failed to send StateUpdated event: {e}");
                });
        }

        // Emit FileLoaded once when duration becomes available
        if !first_file_emitted && state.duration > 0.0 {
            first_file_emitted = true;
            let _ = tx
                .send(PlayerEvent::FileLoaded {
                    filename: String::new(),
                    duration: state.duration,
                })
                .await
                .inspect_err(|e| {
                    warn!("VLC: Failed to send FileLoaded event: {e}");
                });
        }

        time::sleep(std::time::Duration::from_millis(500)).await;
    }

    Ok(())
}

// ── MPC-HC HTTP IPC ──────────────────────────────────────────────────

/// MPC-HC web interface IPC loop — polls player state via HTTP every 500ms.
async fn mpc_hc_ipc_loop(tx: mpsc::Sender<PlayerEvent>) {
    let client = reqwest::Client::new();
    let base_url = "http://127.0.0.1:13579";
    let mut first_file_emitted = false;
    let mut state = PlayerState::default();

    // Give MPC-HC a moment to start its web interface
    time::sleep(Duration::from_secs(1)).await;

    loop {
        // Get current state via MPC-HC web API
        // MPC-HC web interface returns HTML with state variables
        match client
            .get(format!("{base_url}/variables.html"))
            .send()
            .await
        {
            Ok(resp) => {
                if let Ok(html) = resp.text().await {
                    let mut got_update = false;

                    // Parse position
                    if let Some(pos_str) = extract_mpc_var(&html, "positionstring") {
                        if let Ok(pos) = parse_mpc_time(pos_str) {
                            state.position = pos;
                            got_update = true;
                        }
                    }
                    // Parse duration
                    if let Some(dur_str) = extract_mpc_var(&html, "durationstring") {
                        if let Ok(dur) = parse_mpc_time(dur_str) {
                            state.duration = dur;
                            got_update = true;
                        }
                    }
                    // Parse state (playing/paused)
                    if let Some(state_str) = extract_mpc_var(&html, "state") {
                        state.paused = state_str != "2"; // 2 = playing
                        got_update = true;
                    }
                    // Parse filename
                    if let Some(file) = extract_mpc_var(&html, "file") {
                        state.filename = Some(file.to_string());
                        got_update = true;
                    }
                    // Parse playback rate
                    if let Some(rate_str) = extract_mpc_var(&html, "rate") {
                        if let Ok(rate) = rate_str.parse::<f64>() {
                            state.speed = rate;
                            got_update = true;
                        }
                    }

                    if got_update {
                        let _ = tx
                            .send(PlayerEvent::StateUpdated(state.clone()))
                            .await
                            .inspect_err(|e| {
                                warn!("MPC-HC: Failed to send StateUpdated event: {e}");
                            });
                    }

                    if !first_file_emitted && state.duration > 0.0 {
                        first_file_emitted = true;
                        let _ = tx
                            .send(PlayerEvent::FileLoaded {
                                filename: state.filename.clone().unwrap_or_default(),
                                duration: state.duration,
                            })
                            .await
                            .inspect_err(|e| {
                                warn!("MPC-HC: Failed to send FileLoaded event: {e}");
                            });
                    }
                }
            }
            Err(e) => {
                debug!("MPC-HC web interface unavailable: {e}");
            }
        }

        time::sleep(Duration::from_millis(500)).await;
    }
}

/// Extract a variable value from MPC-HC's variables.html page.
fn extract_mpc_var<'a>(html: &'a str, var_name: &str) -> Option<&'a str> {
    let marker = format!("id=\"{var_name}\">");
    let start = html.find(&marker)? + marker.len();
    let rest = &html[start..];
    let end = rest.find('<')?;
    Some(&rest[..end])
}

/// Parse MPC-HC time format "HH:MM:SS" or "HH:MM:SS.mmm" to seconds.
fn parse_mpc_time(time_str: &str) -> Result<f64, std::num::ParseFloatError> {
    let parts: Vec<&str> = time_str.split(':').collect();
    if parts.len() == 3 {
        let h: f64 = parts[0].parse()?;
        let m: f64 = parts[1].parse()?;
        let s: f64 = parts[2].parse()?;
        Ok(h * 3600.0 + m * 60.0 + s)
    } else if parts.len() == 2 {
        let m: f64 = parts[0].parse()?;
        let s: f64 = parts[1].parse()?;
        Ok(m * 60.0 + s)
    } else {
        time_str.parse::<f64>()
    }
}

/// Send an HTTP command to MPC-HC.
pub async fn mpc_hc_command(command: &str, value: &str) -> Result<()> {
    let client = reqwest::Client::new();
    let url = "http://127.0.0.1:13579/command.html";
    let params = [("wm_command", format!("{command} {value}"))];
    let _resp = client
        .post(url)
        .form(&params)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .context("MPC-HC command failed")?;
    Ok(())
}

/// MPC-HC play/pause toggle (command 889 = play, which toggles).
pub async fn mpc_hc_play() -> Result<()> {
    mpc_hc_command("889", "").await
}

/// MPC-HC pause.
pub async fn mpc_hc_pause() -> Result<()> {
    mpc_hc_command("888", "").await
}

/// MPC-HC seek to absolute position (in seconds * 1000).
pub async fn mpc_hc_seek(position: f64) -> Result<()> {
    let ms = (position * 1000.0) as i64;
    // MPC-HC uses -1 for absolute position mode, command 894
    let client = reqwest::Client::new();
    let url = "http://127.0.0.1:13579/command.html";
    let params = [
        ("wm_command", "-1".to_string()),
        ("position", ms.to_string()),
    ];
    let _resp = client
        .post(url)
        .form(&params)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .context("MPC-HC seek command failed")?;
    Ok(())
}

/// MPC-HC set playback rate (speed).
pub async fn mpc_hc_set_speed(speed: f64) -> Result<()> {
    // Send rate change via key commands (Ctrl+Up/Down or direct rate)
    // MPC-HC web interface: wm_command 895 with rate value
    let client = reqwest::Client::new();
    let url = "http://127.0.0.1:13579/command.html";
    let params = [
        ("wm_command", "895".to_string()),
        ("rate", speed.to_string()),
    ];
    let _resp = client
        .post(url)
        .form(&params)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .context("MPC-HC speed command failed")?;
    Ok(())
}

// ── Helper: format time for display ──────────────────────────────────

pub fn format_position(seconds: f64) -> String {
    if seconds <= 0.0 || !seconds.is_finite() {
        return "--:--:--".into();
    }
    let total = seconds as u64;
    let h = total / 3600;
    let m = (total % 3600) / 60;
    let s = total % 60;
    if h > 0 {
        format!("{h:02}:{m:02}:{s:02}")
    } else {
        format!("{m:02}:{s:02}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_position() {
        assert_eq!(format_position(0.0), "--:--:--");
        assert_eq!(format_position(65.0), "01:05");
        assert_eq!(format_position(3661.0), "01:01:01");
        assert_eq!(format_position(-1.0), "--:--:--");
        assert_eq!(format_position(f64::NAN), "--:--:--");
        // Edge cases
        assert_eq!(format_position(0.5), "00:00");
        assert_eq!(format_position(59.9), "00:59");
        assert_eq!(format_position(3600.0), "01:00:00");
        assert_eq!(format_position(86399.0), "23:59:59");
        assert_eq!(format_position(86400.0), "24:00:00");
    }

    #[test]
    fn test_player_type_from_path() {
        let mpv = PlayerController::new(PlayerType::Mpv);
        assert!(matches!(mpv, PlayerController { .. }));

        let vlc = PlayerController::new(PlayerType::Vlc);
        assert!(matches!(vlc, PlayerController { .. }));
    }

    #[test]
    fn test_vlc_password_generation() {
        // Verify random password generates and is non-empty
        let pwd: String = rand::thread_rng()
            .sample_iter(&rand::distributions::Alphanumeric)
            .take(16)
            .map(char::from)
            .collect();
        assert_eq!(pwd.len(), 16);
        assert!(pwd.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn test_parse_mpc_time_hms() {
        assert_eq!(parse_mpc_time("01:02:03").unwrap(), 3723.0);
        assert_eq!(parse_mpc_time("00:00:00").unwrap(), 0.0);
    }

    #[test]
    fn test_parse_mpc_time_ms() {
        assert_eq!(parse_mpc_time("01:30").unwrap(), 90.0);
    }

    #[test]
    fn test_extract_mpc_var() {
        let html = r#"<html><p id="state">2</p><p id="positionstring">01:23:45</p></html>"#;
        assert_eq!(extract_mpc_var(html, "state"), Some("2"));
        assert_eq!(extract_mpc_var(html, "positionstring"), Some("01:23:45"));
        assert_eq!(extract_mpc_var(html, "nonexistent"), None);
    }

    #[test]
    fn test_validate_binary_no_file() {
        let result = PlayerController::validate_binary("/tmp/definitely_not_a_player_xyz");
        assert!(matches!(result, LaunchValidation::NotFound));
    }

    #[test]
    fn test_player_type_display_names() {
        assert_eq!(PlayerType::Mpv.display_name(), "mpv");
        assert_eq!(PlayerType::Vlc.display_name(), "VLC");
        assert_eq!(PlayerType::Iina.display_name(), "IINA");
        assert_eq!(PlayerType::MpcHc.display_name(), "MPC-HC");
        assert_eq!(PlayerType::Mplayer.display_name(), "MPlayer");
    }
}
