//! Syncplay P2P Terminal UI
//!
//! Usage:
//!   syncplay-tui \\[OPTIONS\\]
//!
//! Options:
//!   --room, -r ROOM        Room name (default: syncplay-tui)
//!   --signaling, -s URL    Signaling server URL (default: ws://127.0.0.1:8998)
//!   --username, -u NAME    Display name (default: OS username)
//!   --password, -P PASS    Room password
//!   --config, -c PATH      Load config from JSON file
//!   --file, -f FILE        Media file to open on start
//!   --voice                Enable voice chat on start
//!   --sfu                  SFU mode: connect through server (star topology)
//!   --help, -h             Show this help
//!   --version, -V          Show version
//!
//! Keybindings (also press ? inside the TUI):
//!   q/Esc  quit           space  toggle ready
//!   p      pause/play      s     seek +10s
//!   a      seek -10s       m     toggle voice mute
//!   Tab    toggle voice    ?     toggle help screen
//!   Enter  send chat       ↑↓PgUp/Dn scroll chat
//!   j/k    scroll playlist
//!   Commands: /help /send /download /playlist add /playlist index /react /ready
//!             /shrug /tableflip /unflip /lenny

use std::sync::Arc;

use parking_lot::Mutex;
use syncplay_p2p::config::{ConfigOverrides, P2pConfig};
use syncplay_p2p::connection::ConnectionManager;
use syncplay_p2p::file_transfer::FileTransfer;
use syncplay_p2p::state::ConnectionState;
use syncplay_p2p::sync::SyncManager;
use syncplay_p2p::tui::{run_tui, UiState};

fn usage() -> ! {
    println!("syncplay-tui v{}", env!("CARGO_PKG_VERSION"));
    println!();
    println!("Usage: syncplay-tui [OPTIONS]");
    println!();
    println!("Options:");
    println!("  --room, -r ROOM        Room name (default: syncplay-tui)");
    println!("  --signaling, -s URL    Signaling server URL (default: ws://127.0.0.1:8998)");
    println!("  --username, -u NAME    Display name (default: OS username)");
    println!("  --password, -P PASS    Room password");
    println!("  --config, -c PATH      Load config from JSON file");
    println!("  --file, -f FILE        Media file to open on start");
    println!("  --voice                Enable voice chat on start");
    println!("  --sfu                  SFU mode: connect through server (star topology)");
    println!("  --help, -h             Show this help");
    println!("  --version, -V          Show version");
    std::process::exit(0);
}

fn version() -> ! {
    println!("syncplay-tui v{}", env!("CARGO_PKG_VERSION"));
    std::process::exit(0);
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("warn,syncplay_p2p=info"),
    )
    .init();

    let args: Vec<String> = std::env::args().collect();
    let mut overrides = ConfigOverrides::default();
    let mut enable_voice = false;
    let mut config_path: Option<String> = None;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--help" | "-h" => usage(),
            "--version" | "-V" => version(),
            "--room" | "-r" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("Missing value for {}", args[i - 1]);
                    std::process::exit(1);
                }
                overrides.room = Some(args[i].clone());
            }
            "--signaling" | "-s" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("Missing value for {}", args[i - 1]);
                    std::process::exit(1);
                }
                overrides.signaling_url = Some(args[i].clone());
            }
            "--username" | "-u" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("Missing value for {}", args[i - 1]);
                    std::process::exit(1);
                }
                overrides.username = Some(args[i].clone());
            }
            "--password" | "-P" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("Missing value for {}", args[i - 1]);
                    std::process::exit(1);
                }
                overrides.password = Some(args[i].clone());
            }
            "--config" | "-c" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("Missing value for {}", args[i - 1]);
                    std::process::exit(1);
                }
                config_path = Some(args[i].clone());
            }
            "--file" | "-f" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("Missing value for {}", args[i - 1]);
                    std::process::exit(1);
                }
                overrides.file = Some(args[i].clone());
            }
            "--voice" => {
                enable_voice = true;
            }
            "--sfu" => {
                overrides.sfu = Some(true);
            }
            other => {
                eprintln!("Unknown flag: {other}");
                eprintln!("Try --help");
                std::process::exit(1);
            }
        }
        i += 1;
    }

    let mut cfg = if let Some(ref path) = config_path {
        P2pConfig::load(path)?
    } else {
        P2pConfig::default()
    };
    cfg.apply_overrides(&overrides);

    // Wire voice_enabled from config if not set via CLI
    if !enable_voice {
        enable_voice = cfg.voice_enabled;
    }

    if cfg.room.is_empty() {
        cfg.room = "syncplay-tui".into();
    }

    println!("Syncplay P2P TUI v{}", env!("CARGO_PKG_VERSION"));
    println!("Room: {}  |  Signaling: {}", cfg.room, cfg.signaling_url);

    // Connect with retry
    let conn = ConnectionManager::new(&cfg.username, cfg.features.clone());
    conn.connect_with_retry(&cfg.signaling_url, &cfg.room, &cfg.password)
        .await?;
    let sync = SyncManager::new(conn.clone(), cfg.clone());
    sync.start().await;

    // Auto-detect and launch player
    if cfg.player.path.is_empty() {
        if let Some(dp) = syncplay_p2p::player::default_player() {
            cfg.player.path = dp.path.to_string_lossy().to_string();
            println!(
                "Detected player: {} ({})",
                dp.player.name,
                dp.path.display()
            );
        } else {
            println!("No media player detected — install mpv or VLC");
        }
    }

    // Launch player if we have one
    if !cfg.player.path.is_empty() {
        let ptype = if cfg.player.path.contains("mpv") {
            syncplay_p2p::player_controller::PlayerType::Mpv
        } else if cfg.player.path.to_lowercase().contains("iina") {
            syncplay_p2p::player_controller::PlayerType::Iina
        } else {
            syncplay_p2p::player_controller::PlayerType::Vlc
        };
        let mut pc = syncplay_p2p::player_controller::PlayerController::new(ptype);
        let socket = format!("/tmp/syncplay-mpv-{}.sock", std::process::id());
        match pc
            .launch(&cfg.player.path, cfg.player.file.as_deref(), &socket)
            .await
        {
            Ok(mut rx) => {
                // Set player socket BEFORE setting ready to avoid race
                // (readiness broadcast needs the player socket to be available)
                sync.set_player_socket(Some(socket.clone()));
                println!("Player launched — IPC socket: {socket}");
                let _player = pc; // keep alive to prevent Drop killing the child
                                  // Spawn event consumer to feed playstate back to sync
                let sync2 = sync.clone();
                tokio::spawn(async move {
                    while let Some(event) = rx.recv().await {
                        match event {
                            syncplay_p2p::player_controller::PlayerEvent::StateUpdated(st) => {
                                if !st.paused || st.position > 0.1 {
                                    sync2.update_playstate(st.position, st.paused);
                                }
                                // Transmit speed changes to peers
                                if (st.speed - 1.0).abs() > 0.01 {
                                    if sync2.is_host() {
                                        // Host updates room state and broadcasts
                                        sync2.update_speed(st.speed).await;
                                    } else {
                                        sync2.request_set_speed(st.speed).await;
                                    }
                                }
                            }
                            syncplay_p2p::player_controller::PlayerEvent::FileLoaded {
                                filename,
                                duration,
                            } => {
                                let meta = syncplay_p2p::messages::FileMetadata {
                                    name: filename,
                                    duration,
                                    size: 0,
                                    checksum: None,
                                };
                                sync2.send_file_info(Some(meta)).await;
                            }
                            _ => {}
                        }
                    }
                });
            }
            Err(e) => {
                eprintln!("Failed to launch player: {e}");
            }
        }
    }

    // Auto-set ready if configured — now happens AFTER player socket is set
    if cfg.sync.ready_at_start {
        sync.set_ready(true, None).await;
    }

    let state = Arc::new(Mutex::new(UiState {
        room: cfg.room.clone(),
        connected: true,
        connection_state: ConnectionState::Connecting,
        voice_enabled: enable_voice,
        has_turn: !cfg.network.turn_servers.is_empty(),
        ..Default::default()
    }));

    let download_dir = cfg.download_dir.clone();
    println!("Downloads: {}", download_dir);
    if let Err(e) = std::fs::create_dir_all(&download_dir) {
        eprintln!(
            "Warning: could not create download dir {}: {e}",
            download_dir
        );
    }

    // ── File transfer ──────────────────────────────────────────
    let ft = FileTransfer::new(conn.clone());
    ft.register_handlers();
    let ft_state = state.clone();
    let ft_dir = download_dir.clone();
    conn.on_msg(
        syncplay_p2p::messages::MessageType::FileTransfer,
        move |_: syncplay_p2p::messages::MessageType, data: &[u8], _from: String| {
            if let Ok(chunk) =
                rmp_serde::from_slice::<syncplay_p2p::messages::FileTransferPayload>(data)
            {
                let mut s = ft_state.lock();
                // Update transfer progress
                for t in &mut s.transfers {
                    if t.transfer_id == chunk.transfer_id {
                        t.received_bytes = chunk.offset + chunk.chunk_size as u64;
                        if chunk.total_size > 0 {
                            t.progress = t.received_bytes as f64 / chunk.total_size as f64;
                        }
                    }
                }
                drop(s);
                // Save to disk when complete
                if let Ok(Some(path)) = ft.handle_chunk(&chunk, &ft_dir) {
                    let mut s2 = ft_state.lock();
                    s2.chat.push(format!("--- Download complete: {}", path));
                    if s2.chat.len() > 500 {
                        s2.chat.remove(0);
                    }
                }
            }
        },
    );

    // ── Callbacks ──────────────────────────────────────────────

    // Chat — skip self-messages to avoid duplication
    let chat_state = state.clone();
    let my_name = cfg.username.clone();
    conn.on_msg(
        syncplay_p2p::messages::MessageType::Chat,
        move |_: syncplay_p2p::messages::MessageType, data: &[u8], _from: String| {
            if let Ok(chat) = rmp_serde::from_slice::<syncplay_p2p::messages::ChatPayload>(data) {
                if chat.from == my_name {
                    return;
                }
                let msg = format!("<{}> {}", chat.from, chat.message);
                let mut s = chat_state.lock();
                s.chat.push(msg);
                if s.chat.len() > 500 {
                    s.chat.remove(0);
                }
            }
        },
    );

    // Readiness
    let ready_state = state.clone();
    conn.on_msg(
        syncplay_p2p::messages::MessageType::Readiness,
        move |_: syncplay_p2p::messages::MessageType, data: &[u8], _from: String| {
            if let Ok(r) = rmp_serde::from_slice::<syncplay_p2p::messages::ReadinessPayload>(data) {
                let mut s = ready_state.lock();
                s.ready_states.insert(r.username.clone(), r.is_ready);
                if !r.set_by.is_empty() && r.manually_initiated {
                    s.chat.push(format!(
                        "=== {} is now {} ===",
                        r.username,
                        if r.is_ready { "ready" } else { "not ready" }
                    ));
                }
            }
        },
    );

    // FileInfo
    let file_state = state.clone();
    conn.on_msg(
        syncplay_p2p::messages::MessageType::FileInfo,
        move |_: syncplay_p2p::messages::MessageType, data: &[u8], _from: String| {
            if let Ok(fi) = rmp_serde::from_slice::<syncplay_p2p::messages::FileInfoPayload>(data) {
                let mut s = file_state.lock();
                if let Some(meta) = &fi.file {
                    s.chat
                        .push(format!("--- {} is playing {} ---", fi.username, meta.name));
                    if s.chat.len() > 500 {
                        s.chat.remove(0);
                    }
                    for peer in &mut s.peers {
                        if peer.name == fi.username {
                            peer.file = meta.name.clone();
                        }
                    }
                }
            }
        },
    );

    // SubtitleInfo
    let sub_state = state.clone();
    conn.on_msg(
        syncplay_p2p::messages::MessageType::SubtitleInfo,
        move |_: syncplay_p2p::messages::MessageType, data: &[u8], _from: String| {
            if let Ok(si) =
                rmp_serde::from_slice::<syncplay_p2p::messages::SubtitleInfoPayload>(data)
            {
                let mut s = sub_state.lock();
                let track_names: Vec<String> = si
                    .subtitles
                    .iter()
                    .map(|t| {
                        format!(
                            "{}{}",
                            t.filename,
                            t.language
                                .as_ref()
                                .map_or(String::new(), |l| format!(" ({l})"))
                        )
                    })
                    .collect();
                let msg = format!(
                    "=== {} subtitles available: {} ===",
                    track_names.len(),
                    track_names.join(", ")
                );
                s.subtitle_announcements.push(msg.clone());
                if s.subtitle_announcements.len() > 8 {
                    s.subtitle_announcements.remove(0);
                }
                s.chat.push(msg);
                if s.chat.len() > 500 {
                    s.chat.remove(0);
                }
            }
        },
    );

    // VoiceMute — peer mute status
    let mute_state = state.clone();
    conn.on_msg(
        syncplay_p2p::messages::MessageType::VoiceMute,
        move |_: syncplay_p2p::messages::MessageType, data: &[u8], from: String| {
            if let Ok(p) = rmp_serde::from_slice::<syncplay_p2p::messages::VoiceMutePayload>(data) {
                let mut s = mute_state.lock();
                for peer in &mut s.peers {
                    if peer.name == from {
                        peer.muted = p.muted;
                    }
                }
            }
        },
    );

    // Peer join — real-time peer list update
    let join_state = state.clone();
    conn.on_join(move |_pid: String, username: String| {
        let mut s = join_state.lock();
        s.chat.push(format!("=== {username} joined ==="));
        if s.chat.len() > 500 {
            s.chat.remove(0);
        }
    });

    // Peer leave
    let leave_state = state.clone();
    conn.on_leave(move |_pid: String, _reason: String| {
        let username = _pid;
        let reason = _reason;
        let mut s = leave_state.lock();
        s.chat.push(format!("=== {username} left ({reason}) ==="));
        if s.chat.len() > 500 {
            s.chat.remove(0);
        }
    });

    // ── Voice chat (if enabled) ───────────────────────────────

    let mic_muted: Option<Arc<std::sync::atomic::AtomicBool>>;
    let _voice_chat: Option<syncplay_p2p::voice_chat::VoiceChat>;

    if enable_voice {
        let voice_state = state.clone();
        let voice_conn = conn.clone();
        let mut vc = syncplay_p2p::voice_chat::VoiceChat::new(voice_conn);
        mic_muted = Some(vc.mute_flag());
        if vc.create_local_track().is_ok() {
            if let Ok(mut rx) = vc.start_capture() {
                tokio::spawn(async move {
                    while let Some(event) = rx.recv().await {
                        let mut s = voice_state.lock();
                        match event {
                            syncplay_p2p::voice_chat::VoiceEvent::MuteChanged(muted) => {
                                s.voice_muted = muted;
                            }
                            syncplay_p2p::voice_chat::VoiceEvent::PeerSpeaking {
                                peer_id,
                                speaking,
                            } => {
                                for p in &mut s.peers {
                                    if p.name == peer_id {
                                        p.muted = !speaking;
                                    }
                                }
                            }
                            syncplay_p2p::voice_chat::VoiceEvent::Error(e) => {
                                s.chat.push(format!("\u{26a0} voice: {e}"));
                            }
                            _ => {}
                        }
                    }
                });
            }
        }
        _voice_chat = Some(vc);
    } else {
        mic_muted = None;
        _voice_chat = None;
    }

    // Auto-save config for next session before moving room into run_tui
    let config_path = dirs_next().join(".syncplay-config.json");
    if let Err(e) = cfg.save(&config_path.to_string_lossy()) {
        eprintln!("Warning: failed to save config: {e}");
    }

    let room = cfg.room.clone();
    run_tui(state, sync, room, mic_muted).await?;

    println!("Goodbye!");
    Ok(())
}

fn dirs_next() -> std::path::PathBuf {
    std::env::var("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
}
