//! Syncplay P2P Terminal UI
//!
//! Usage:
//!   syncplay-tui [--room ROOM] [--signaling URL] [--username NAME] [--password PASS] [--file FILE]
//!
//! A full-featured ratatui terminal interface. See ? for keybindings.

use std::sync::Arc;

use parking_lot::Mutex;
use syncplay_p2p::config::{ConfigOverrides, P2pConfig};
use syncplay_p2p::connection::ConnectionManager;
use syncplay_p2p::sync::SyncManager;
use syncplay_p2p::tui::{run_tui, UiState};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn,syncplay_p2p=info")).init();

    let mut cfg = P2pConfig::default();

    let args: Vec<String> = std::env::args().collect();
    let mut overrides = ConfigOverrides::default();
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--room" | "-r" => { i += 1; overrides.room = Some(args[i].clone()); }
            "--signaling" | "-s" => { i += 1; overrides.signaling_url = Some(args[i].clone()); }
            "--username" | "-u" => { i += 1; overrides.username = Some(args[i].clone()); }
            "--password" | "-p" => { i += 1; overrides.password = Some(args[i].clone()); }
            "--file" | "-f" => { i += 1; overrides.file = Some(args[i].clone()); }
            _ => { eprintln!("Unknown flag: {}", args[i]); }
        }
        i += 1;
    }
    cfg.apply_overrides(&overrides);

    if cfg.room.is_empty() {
        cfg.room = "syncplay-tui".into();
    }

    println!("Syncplay P2P TUI v{}", env!("CARGO_PKG_VERSION"));
    println!("Room: {}  |  Signaling: {}", cfg.room, cfg.signaling_url);

    // Connect
    let conn = ConnectionManager::new(&cfg.username, cfg.features.clone());
    conn.connect(&cfg.signaling_url, &cfg.room, &cfg.password).await?;
    let sync = SyncManager::new(conn.clone());
    sync.start().await;

    // Auto-detect player
    if cfg.player.path.is_empty() {
        if let Some(dp) = syncplay_p2p::player::default_player() {
            println!("Detected player: {} ({})", dp.player.name, dp.path.display());
        } else {
            println!("No media player detected — install mpv or VLC");
        }
    }

    let state = Arc::new(Mutex::new(UiState {
        room: cfg.room.clone(),
        connected: true,
        ..Default::default()
    }));

    // Register chat callback so incoming messages appear in TUI
    let chat_state = state.clone();
    conn.on_msg(
        syncplay_p2p::messages::MessageType::Chat,
        move |_: syncplay_p2p::messages::MessageType, data: &[u8], _from: String| {
            if let Ok(chat) = rmp_serde::from_slice::<syncplay_p2p::messages::ChatPayload>(data) {
                let msg = format!("<{}> {}", chat.from, chat.message);
                let mut s = chat_state.lock();
                s.chat.push(msg);
                if s.chat.len() > 500 { s.chat.remove(0); }
            }
        },
    );

    // Register readiness callback
    let ready_state = state.clone();
    conn.on_msg(
        syncplay_p2p::messages::MessageType::Readiness,
        move |_: syncplay_p2p::messages::MessageType, data: &[u8], _from: String| {
            if let Ok(r) = rmp_serde::from_slice::<syncplay_p2p::messages::ReadinessPayload>(data) {
                let mut s = ready_state.lock();
                s.ready_states.insert(r.username.clone(), r.is_ready);
                if !r.set_by.is_empty() && r.manually_initiated {
                    s.chat.push(format!("=== {} is now {} ===", r.username, if r.is_ready { "ready" } else { "not ready" }));
                }
            }
        },
    );

    // Register FileInfo callback — show what peers are playing
    let file_state = state.clone();
    conn.on_msg(
        syncplay_p2p::messages::MessageType::FileInfo,
        move |_: syncplay_p2p::messages::MessageType, data: &[u8], _from: String| {
            if let Ok(fi) = rmp_serde::from_slice::<syncplay_p2p::messages::FileInfoPayload>(data) {
                let mut s = file_state.lock();
                if let Some(meta) = &fi.file {
                    s.chat.push(format!("--- {} is playing {} ---", fi.username, meta.name));
                    if s.chat.len() > 500 { s.chat.remove(0); }
                    // Update peer file column
                    for peer in &mut s.peers {
                        if peer.name == fi.username {
                            peer.file = meta.name.clone();
                        }
                    }
                }
            }
        },
    );

    // Register SubtitleInfo callback
    let sub_state = state.clone();
    conn.on_msg(
        syncplay_p2p::messages::MessageType::SubtitleInfo,
        move |_: syncplay_p2p::messages::MessageType, data: &[u8], _from: String| {
            if let Ok(si) = rmp_serde::from_slice::<syncplay_p2p::messages::SubtitleInfoPayload>(data) {
                let mut s = sub_state.lock();
                let track_names: Vec<String> = si.subtitles.iter()
                    .map(|t| format!("{}{}", t.filename, t.language.as_ref().map_or(String::new(), |l| format!(" ({l})"))))
                    .collect();
                let msg = format!("=== {} subtitles available: {} ===", track_names.len(), track_names.join(", "));
                s.subtitle_announcements.push(msg.clone());
                if s.subtitle_announcements.len() > 8 { s.subtitle_announcements.remove(0); }
                s.chat.push(msg);
                if s.chat.len() > 500 { s.chat.remove(0); }
            }
        },
    );

    run_tui(state, sync, cfg.room).await?;
    println!("Goodbye!");
    Ok(())
}
