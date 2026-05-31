//! Media player controller — launches and controls mpv/VLC via IPC.
//!
//! Uses mpv's JSON IPC protocol over Unix sockets (macOS/Linux)
//! or named pipes (Windows). VLC uses its telnet/RC interface.
//!
//! Replaces: mpv.py (771 lines) + vlc.py (546 lines) + playerFactory.py

use std::process::{Child, Command, Stdio};
use std::time::Duration;

use anyhow::{Context, Result};
use log::{debug, error, info};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as AsyncBufReader};
use tokio::net::UnixStream;
use tokio::sync::mpsc;
use tokio::time;

/// Player state reported by the media player.
#[derive(Debug, Clone, Default)]
pub struct PlayerState {
    pub position: f64,
    pub duration: f64,
    pub paused: bool,
    pub filename: Option<String>,
    pub filepath: Option<String>,
    pub speed: f64,
}

/// Supported player types.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayerType {
    Mpv,
    Vlc,
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

/// High-level player controller.
pub struct PlayerController {
    player_type: PlayerType,
    child: Option<Child>,
    event_tx: Option<mpsc::Sender<PlayerEvent>>,
}

impl PlayerController {
    pub fn new(player_type: PlayerType) -> Self {
        Self {
            player_type,
            child: None,
            event_tx: None,
        }
    }

    /// Launch the player with an optional file.
    pub async fn launch(
        &mut self,
        player_path: &str,
        file: Option<&str>,
        ipc_socket: &str,
    ) -> Result<mpsc::Receiver<PlayerEvent>> {
        // Clean up old socket
        let _ = std::fs::remove_file(ipc_socket);

        let mut cmd = Command::new(player_path);

        match self.player_type {
            PlayerType::Mpv => {
                cmd.arg(format!("--input-ipc-server={ipc_socket}"))
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
                cmd.arg(format!("--rc-host=127.0.0.1:{vlc_port}"))
                    .arg("--no-video-title-show")
                    .arg("--quiet")
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                if let Some(f) = file {
                    cmd.arg(f);
                }
            }
        }

        let child = cmd.spawn().context("Failed to launch player")?;
        self.child = Some(child);
        info!(
            "Launched {} player (pid: {:?})",
            match self.player_type {
                PlayerType::Mpv => "mpv",
                PlayerType::Vlc => "VLC",
            },
            self.child.as_ref().map(|c| c.id())
        );

        // Wait briefly for socket to be created
        for _ in 0..20 {
            if std::path::Path::new(ipc_socket).exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        let (tx, rx) = mpsc::channel(256);
        self.event_tx = Some(tx.clone());

        // Spawn the IPC reader task
        if let PlayerType::Mpv = self.player_type {
            let socket = ipc_socket.to_string();
            let tx2 = tx.clone();
            tokio::spawn(async move {
                if let Err(e) = mpv_ipc_loop(&socket, tx2).await {
                    error!("mpv IPC loop error: {e}");
                }
            });
        }

        // Spawn child process watcher
        if let Some(mut child) = self.child.take() {
            let tx3 = tx.clone();
            tokio::spawn(async move {
                let status = child.wait();
                let code = status.ok().and_then(|s| s.code());
                let _ = tx3.send(PlayerEvent::PlayerExited { code }).await;
            });
        } else {
            error!("No child process to watch — launch may have failed");
            let _ = tx
                .send(PlayerEvent::Error("player process not started".into()))
                .await;
        }

        Ok(rx)
    }

    /// Write a raw command to the mpv IPC socket.
    pub async fn mpv_command(socket_path: &str, cmd: &Value) -> Result<Value> {
        let mut stream = UnixStream::connect(socket_path)
            .await
            .context("connect to mpv socket")?;

        let mut msg = serde_json::to_vec(cmd)?;
        msg.push(b'\n');
        stream.write_all(&msg).await?;

        // Read response
        let mut buf = Vec::new();
        let mut reader = AsyncBufReader::new(&mut stream);
        reader.read_until(b'\n', &mut buf).await?;

        let resp: Value = serde_json::from_slice(&buf)?;
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
        let cmd = serde_json::json!({"command": ["set_property", "time-pos", position]});
        Self::mpv_command(socket_path, &cmd).await?;
        Ok(())
    }

    pub async fn set_speed(socket_path: &str, speed: f64) -> Result<()> {
        let cmd = serde_json::json!({"command": ["set_property", "speed", speed]});
        Self::mpv_command(socket_path, &cmd).await?;
        Ok(())
    }

    pub async fn open_file(socket_path: &str, path: &str) -> Result<()> {
        let cmd = serde_json::json!({"command": ["loadfile", path]});
        Self::mpv_command(socket_path, &cmd).await?;
        Ok(())
    }

    pub async fn get_position(socket_path: &str) -> Result<f64> {
        let cmd = serde_json::json!({"command": ["get_property", "time-pos"]});
        let resp = Self::mpv_command(socket_path, &cmd).await?;
        resp["data"].as_f64().context("no position data")
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

    pub async fn quit(socket_path: &str) -> Result<()> {
        let cmd = serde_json::json!({"command": ["quit"]});
        let _ = Self::mpv_command(socket_path, &cmd).await;
        Ok(())
    }
}

impl Drop for PlayerController {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Background task that reads mpv JSON IPC events.
async fn mpv_ipc_loop(socket_path: &str, tx: mpsc::Sender<PlayerEvent>) -> Result<()> {
    // Wait for socket
    for _ in 0..50 {
        if std::path::Path::new(socket_path).exists() {
            break;
        }
        time::sleep(Duration::from_millis(100)).await;
    }

    let stream = UnixStream::connect(socket_path)
        .await
        .context("connect to mpv socket")?;

    let (reader, _writer) = stream.into_split();
    let mut reader = AsyncBufReader::new(reader);

    // Set up property observation
    {
        let obs_cmds = [
            r#"{"command":["observe_property",1,"time-pos"]}"#,
            r#"{"command":["observe_property",2,"pause"]}"#,
            r#"{"command":["observe_property",3,"duration"]}"#,
            r#"{"command":["observe_property",4,"filename"]}"#,
            r#"{"command":["observe_property",5,"path"]}"#,
            r#"{"command":["observe_property",6,"speed"]}"#,
        ];
        // Reconnect to send observe commands (the stream we split is read-only)
        for obs_cmd in obs_cmds {
            if let Ok(mut s) = UnixStream::connect(socket_path).await {
                let _ = s.write_all(format!("{obs_cmd}\n").as_bytes()).await;
            }
        }
    }

    let mut state = PlayerState::default();

    loop {
        let mut line = String::new();
        match reader.read_line(&mut line).await {
            Ok(0) => break, // EOF
            Ok(_) => {
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
                                _ => {}
                            }
                            let _ = tx.send(PlayerEvent::StateUpdated(state.clone())).await;
                        }
                        // File loaded event
                        else if msg["event"].as_str() == Some("file-loaded") {
                            let _ = tx
                                .send(PlayerEvent::FileLoaded {
                                    filename: state.filename.clone().unwrap_or_default(),
                                    duration: state.duration,
                                })
                                .await;
                        }
                        // End file
                        else if msg["event"].as_str() == Some("end-file") {
                            let _ = tx.send(PlayerEvent::EndOfFile).await;
                        }
                    }
                    Err(e) => {
                        debug!("mpv non-JSON: {trimmed} ({e})");
                    }
                }
            }
            Err(e) => {
                error!("mpv read error: {e}");
                break;
            }
        }
    }

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
    }
}
