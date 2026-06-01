//! Terminal UI for Syncplay P2P (ratatui + crossterm).
//!
//! Adaptive 6-panel layout with two-column main area.
//! Status bar → [Peers | Playback+Playlist] → Chat → Input → Help.

use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use crossterm::ExecutableCommand;
use parking_lot::Mutex;
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Gauge, List, ListItem, Paragraph};
use ratatui::Frame;

use crate::connection::IceState;
use crate::messages::FileEntry;
use crate::state::ConnectionState;
use crate::sync::SyncManager;

// ── Theme ──────────────────────────────────────────────────────────────

mod theme {
    use super::*;
    pub const BG: Color = Color::Rgb(14, 14, 20);
    pub const SURFACE: Color = Color::Rgb(22, 22, 32);
    pub const BORDER: Color = Color::Rgb(55, 55, 70);
    pub const TEXT: Color = Color::Rgb(225, 225, 240);
    pub const DIM: Color = Color::Rgb(110, 110, 130);
    pub const ACCENT: Color = Color::Rgb(90, 175, 255);
    pub const SUCCESS: Color = Color::Rgb(70, 215, 115);
    pub const WARN: Color = Color::Rgb(255, 195, 50);
    pub const ERROR: Color = Color::Rgb(255, 70, 70);
    pub const HOST: Color = Color::Rgb(195, 135, 255);
    pub const SEEK: Color = Color::Rgb(90, 215, 195);

    pub fn border(title: &str) -> Block<'_> {
        Block::default()
            .title(title)
            .borders(Borders::ALL)
            .border_style(Style::default().fg(BORDER))
            .style(Style::default().bg(SURFACE))
    }
}

// ── State ──────────────────────────────────────────────────────────────

/// A single row in the TUI peer list, holding display data for one connected peer.
pub struct PeerRow {
    pub name: String,
    pub ice: String,
    pub rtt: String,
    pub ready: bool,
    pub file: String,
    pub muted: bool,
    pub is_host: bool,
}

/// Tracks the progress and metadata of an active file transfer in the TUI.
#[derive(Default)]
pub struct TransferState {
    pub transfer_id: String,
    pub filename: String,
    pub direction: TransferDirection,
    pub progress: f64,
    pub total_bytes: u64,
    pub received_bytes: u64,
}

#[derive(Default)]
pub enum TransferDirection {
    #[default]
    Sending,
    Receiving,
}

/// Complete aggregate state for the terminal UI, including playback, peers, chat, playlist, and transfers.
pub struct UiState {
    pub playstate: String,
    pub position_secs: f64,
    pub paused: bool,
    pub current_file: String,
    pub current_duration: f64,
    pub peers: Vec<PeerRow>,
    pub chat: Vec<String>,
    pub chat_scroll: usize,
    pub playlist: Vec<FileEntry>,
    pub playlist_scroll: usize,
    pub playlist_index: usize,
    pub ready_states: HashMap<String, bool>,
    pub room: String,
    pub connected: bool,
    pub connection_state: ConnectionState,
    pub host: bool,
    pub input: String,
    pub input_cursor: usize,
    pub input_history: Vec<String>,
    pub input_history_idx: usize,
    pub transfers: Vec<TransferState>,
    pub voice_enabled: bool,
    pub voice_muted: bool,
    pub subtitle_announcements: Vec<String>,
    pub latency_warnings: Vec<String>,
    pub help_expanded: bool,
    pub has_turn: bool,
    pub reconnecting: bool,
}

impl Default for UiState {
    fn default() -> Self {
        Self {
            playstate: "Waiting...".into(),
            position_secs: 0.0,
            paused: true,
            current_file: String::new(),
            current_duration: 0.0,
            peers: vec![],
            chat: vec![],
            chat_scroll: 0,
            playlist: vec![],
            playlist_scroll: 0,
            playlist_index: 0,
            ready_states: HashMap::new(),
            room: "---".into(),
            connected: false,
            connection_state: ConnectionState::Offline,
            host: false,
            input: String::new(),
            input_cursor: 0,
            input_history: Vec::new(),
            input_history_idx: 0,
            transfers: vec![],
            voice_enabled: false,
            voice_muted: false,
            subtitle_announcements: vec![],
            latency_warnings: vec![],
            help_expanded: false,
            has_turn: false,
            reconnecting: false,
        }
    }
}

// ── Constants ──────────────────────────────────────────────────────────

const CHAT_VISIBLE: usize = 15;
const CHAT_MAX_SCROLL: usize = 200;
const PLAYLIST_VISIBLE: usize = 10;

// ── Main loop ──────────────────────────────────────────────────────────

/// Run the terminal UI event loop, rendering a 6-panel adaptive layout and handling keyboard input.
pub async fn run_tui(
    state: Arc<Mutex<UiState>>,
    sync: SyncManager,
    room: String,
    mic_muted: Option<Arc<AtomicBool>>,
) -> io::Result<()> {
    let mut stdout = io::stdout();
    stdout.execute(EnterAlternateScreen)?;
    enable_raw_mode()?;
    let mut terminal = ratatui::init();
    terminal.clear()?;

    let tick_rate = Duration::from_millis(100);
    let mut last_tick = Instant::now();
    {
        let mut s = state.lock();
        s.room = room;
    }

    let mm = mic_muted.clone();
    loop {
        if last_tick.elapsed() >= tick_rate {
            let snapshot = sync.get_room_state();
            let latencies = sync.get_latencies();
            let conn_stats = sync.get_peer_stats();
            let hid = sync.get_connection().hid();
            let mut s = state.lock();
            s.host = sync.is_host();
            s.connected = conn_stats
                .iter()
                .any(|(_, _, ice, _)| ice == &IceState::Connected)
                || conn_stats.is_empty(); // "connected" if no peers but signaling is up
            s.connection_state = sync.get_connection().connection_state();
            if let Some(ref m) = mm {
                s.voice_muted = m.load(Ordering::SeqCst);
            }
            s.position_secs = snapshot.position;
            s.paused = snapshot.paused;
            s.playstate = fmt_time(snapshot.position);
            s.playlist = snapshot.playlist;
            s.playlist_index = snapshot.playlist_index;
            s.ready_states = snapshot.ready_states;
            let (file_name, file_dur) = {
                if let Some(entry) = s.playlist.get(s.playlist_index) {
                    (entry.name.clone(), entry.duration)
                } else {
                    (String::new(), 0.0)
                }
            };
            s.current_file = file_name;
            s.current_duration = file_dur;

            let rs = s.ready_states.clone();
            for (pid, uname, _ice, display) in &conn_stats {
                if let Some(peer) = s
                    .peers
                    .iter_mut()
                    .find(|p| p.name == *uname || p.name == *pid)
                {
                    peer.ice = display.clone();
                    if let Some(rtt) = latencies.get(uname) {
                        peer.rtt = format!("{:.0}ms", rtt * 1000.0);
                    }
                    peer.ready = rs.get(uname).copied().unwrap_or(false);
                    peer.is_host = *uname == hid || *pid == hid;
                } else {
                    s.peers.push(PeerRow {
                        name: if uname == "unknown" {
                            pid.clone()
                        } else {
                            uname.clone()
                        },
                        ice: display.clone(),
                        rtt: latencies
                            .get(uname)
                            .map(|r| format!("{:.0}ms", r * 1000.0))
                            .unwrap_or_default(),
                        ready: rs.get(uname).copied().unwrap_or(false),
                        file: String::new(),
                        muted: false,
                        is_host: *uname == hid || *pid == hid,
                    });
                }
            }
            s.peers
                .retain(|p| conn_stats.iter().any(|(_, u, _, _)| u == &p.name));
            s.transfers.retain(|t| t.progress < 1.0);
            for (name, rtt) in &latencies {
                if *rtt > 0.5 && !s.latency_warnings.iter().any(|w| w.contains(name)) {
                    s.latency_warnings
                        .push(format!("High latency to {name}: {:.0}ms", rtt * 1000.0));
                    if s.latency_warnings.len() > 5 {
                        s.latency_warnings.remove(0);
                    }
                }
            }
            last_tick = Instant::now();
        }

        terminal.draw(|f| draw(f, &state.lock()))?;
        let timeout = tick_rate
            .checked_sub(last_tick.elapsed())
            .unwrap_or(Duration::from_millis(0));
        if event::poll(timeout)? {
            let ev = event::read()?;
            let should_quit = handle_input(ev, &state, &sync, &mm).await;
            if should_quit {
                break;
            }
        }
    }

    sync.stop().await;
    disable_raw_mode()?;
    stdout.execute(LeaveAlternateScreen)?;
    Ok(())
}

// ── Input ──────────────────────────────────────────────────────────────

// Guard held across match, but dropped before await in every async branch.
#[allow(clippy::await_holding_lock)]
async fn handle_input(
    ev: Event,
    state: &Arc<Mutex<UiState>>,
    sync: &SyncManager,
    mic_muted: &Option<Arc<AtomicBool>>,
) -> bool {
    match ev {
        Event::Key(key) if key.kind == KeyEventKind::Press => {
            let mut s = state.lock();
            match key.code {
                KeyCode::Char('q') | KeyCode::Esc => {
                    if s.input.is_empty() {
                        drop(s);
                        // Graceful quit: notify peers before disconnecting
                        sync.get_connection().disconnect().await;
                        return true;
                    }
                    s.input.clear();
                    s.input_cursor = 0;
                }
                KeyCode::Char('?') => {
                    s.help_expanded = !s.help_expanded;
                }
                KeyCode::Char(' ') => {
                    if s.connected {
                        drop(s);
                        sync.set_ready(true, None).await;
                    }
                }
                KeyCode::Char('p') => {
                    if s.connected {
                        let paused = s.paused;
                        drop(s);
                        if paused {
                            sync.request_play().await;
                        } else {
                            sync.request_pause().await;
                        }
                    }
                }
                KeyCode::Char('s') => {
                    if s.connected {
                        let pos = s.position_secs + 10.0;
                        drop(s);
                        sync.request_seek(pos).await;
                    }
                }
                KeyCode::Char('a') => {
                    if s.connected {
                        let pos = (s.position_secs - 10.0).max(0.0);
                        drop(s);
                        sync.request_seek(pos).await;
                    }
                }
                KeyCode::Char('<') | KeyCode::Char(',') => {
                    if s.connected {
                        drop(s);
                        sync.request_set_speed(0.5).await;
                    }
                }
                KeyCode::Char('>') | KeyCode::Char('.') => {
                    if s.connected {
                        drop(s);
                        sync.request_set_speed(2.0).await;
                    }
                }
                KeyCode::Char('/') => {
                    if s.connected {
                        drop(s);
                        sync.request_set_speed(1.0).await;
                    }
                }
                KeyCode::Char('m') => {
                    s.voice_muted = !s.voice_muted;
                    if let Some(ref m) = mic_muted {
                        m.store(s.voice_muted, Ordering::SeqCst);
                    }
                    if s.connected {
                        let muted = s.voice_muted;
                        drop(s);
                        sync.send_voice_mute(muted).await;
                    }
                }
                KeyCode::PageUp => {
                    s.chat_scroll = (s.chat_scroll + CHAT_VISIBLE).min(CHAT_MAX_SCROLL);
                }
                KeyCode::PageDown => {
                    s.chat_scroll = s.chat_scroll.saturating_sub(CHAT_VISIBLE);
                }
                KeyCode::Up => {
                    if !s.input_history.is_empty() && s.input_history_idx > 0 {
                        s.input_history_idx -= 1;
                        s.input = s
                            .input_history
                            .get(s.input_history_idx)
                            .cloned()
                            .unwrap_or_default();
                        s.input_cursor = s.input.len();
                    }
                }
                KeyCode::Down => {
                    if !s.input_history.is_empty() {
                        if s.input_history_idx < s.input_history.len() {
                            s.input_history_idx += 1;
                        }
                        s.input = if s.input_history_idx < s.input_history.len() {
                            s.input_history[s.input_history_idx].clone()
                        } else {
                            String::new()
                        };
                        s.input_cursor = s.input.len();
                    }
                }
                KeyCode::Enter => {
                    let msg = s.input.clone();
                    if !msg.is_empty() && s.connected {
                        s.input_history.push(msg.clone());
                        s.input_history_idx = s.input_history.len();
                        s.input.clear();
                        s.input_cursor = 0;
                        let is_cmd = msg.starts_with('/');
                        drop(s);
                        if is_cmd {
                            handle_command(&msg, state, sync).await;
                        } else {
                            let expanded = expand_emojis(&msg);
                            sync.send_chat(&expanded).await;
                            let mut s2 = state.lock();
                            s2.chat.push(format!("<you> {expanded}"));
                            if s2.chat.len() > 500 {
                                s2.chat.remove(0);
                            }
                        }
                    }
                }
                KeyCode::Backspace => {
                    let pos = s.input_cursor.saturating_sub(1);
                    if pos < s.input.len() {
                        s.input.remove(pos);
                    }
                    s.input_cursor = pos;
                }
                KeyCode::Delete => {
                    let pos = s.input_cursor;
                    if pos < s.input.len() {
                        s.input.remove(pos);
                    }
                }
                KeyCode::Left => {
                    s.input_cursor = s.input_cursor.saturating_sub(1);
                }
                KeyCode::Right => {
                    s.input_cursor = (s.input_cursor + 1).min(s.input.len());
                }
                KeyCode::Home => s.input_cursor = 0,
                KeyCode::End => s.input_cursor = s.input.len(),
                KeyCode::Char(c) => {
                    let pos = s.input_cursor;
                    if pos <= s.input.len() {
                        s.input.insert(pos, c);
                        s.input_cursor = pos + 1;
                    }
                }
                KeyCode::Tab => {
                    s.voice_enabled = !s.voice_enabled;
                }
                _ => {}
            }
        }
        _ => {}
    }
    false
}

// ── Layout ─────────────────────────────────────────────────────────────

fn draw(f: &mut Frame, state: &UiState) {
    f.render_widget(
        Block::default().style(Style::default().bg(theme::BG)),
        f.area(),
    );
    let area = f.area();
    let help_h = if state.help_expanded { 9 } else { 1 };

    // Adaptive: if terminal is very narrow (< 100 cols), stack instead of side-by-side
    let use_wide = area.width >= 100;

    if use_wide {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(1),
                Constraint::Min(1),
                Constraint::Length(3),
                Constraint::Length(1),
                Constraint::Length(help_h),
            ])
            .split(area);
        draw_status(f, chunks[0], state);

        let main = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(30), Constraint::Percentage(70)])
            .split(chunks[1]);
        draw_peers(f, main[0], state);

        let right = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Length(5), Constraint::Min(0)])
            .split(main[1]);
        draw_playback(f, right[0], state);
        draw_playlist(f, right[1], state);

        draw_chat(f, chunks[2], state);
        draw_input(f, chunks[3], state);
        draw_help(f, chunks[4], state);
    } else {
        // Narrow layout: stack everything vertically
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(1),
                Constraint::Length(4),
                Constraint::Length(6),
                Constraint::Min(1),
                Constraint::Length(1),
                Constraint::Length(help_h),
            ])
            .split(area);
        draw_status(f, chunks[0], state);
        draw_playback(f, chunks[1], state);
        draw_peers_compact(f, chunks[2], state);
        draw_playlist(f, chunks[3], state);
        draw_input(f, chunks[4], state);
        draw_help(f, chunks[5], state);
    }
}

// ── Widgets ────────────────────────────────────────────────────────────

fn draw_status(f: &mut Frame, area: Rect, state: &UiState) {
    let mut spans = vec![];
    match state.connection_state {
        ConnectionState::Offline => {
            spans.push(Span::styled(
                " ○ OFFLINE",
                Style::default().fg(theme::ERROR),
            ));
        }
        ConnectionState::Connecting | ConnectionState::Handshaking => {
            spans.push(Span::styled(
                " ◐ CONNECTING...",
                Style::default().fg(theme::WARN),
            ));
        }
        ConnectionState::ConnectingPeers { peer_count } => {
            spans.push(Span::styled(
                format!(" ◐ JOINING ({peer_count})..."),
                Style::default().fg(theme::WARN),
            ));
        }
        ConnectionState::Ready { peer_count } => {
            spans.push(Span::styled(
                format!(" ● ONLINE ({peer_count})"),
                Style::default().fg(theme::SUCCESS),
            ));
            spans.push(Span::styled("  ", Style::default().fg(theme::DIM)));
            spans.push(Span::styled(
                &state.room,
                Style::default().fg(theme::ACCENT),
            ));
        }
        ConnectionState::Reconnecting {
            attempt,
            max_attempts,
        } => {
            spans.push(Span::styled(
                format!(" ◐ RECONNECTING ({attempt}/{max_attempts})"),
                Style::default().fg(theme::WARN),
            ));
        }
        ConnectionState::Error { ref message } => {
            spans.push(Span::styled(
                format!(" ⚠ ERROR: {message}"),
                Style::default().fg(theme::ERROR),
            ));
        }
    }
    f.render_widget(
        Paragraph::new(Line::from(spans)).style(Style::default().bg(theme::SURFACE)),
        area,
    );
}

fn draw_playback(f: &mut Frame, area: Rect, state: &UiState) {
    let block = theme::border("Playback");
    let inner = block.inner(area);
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
        ])
        .split(inner);

    let icon = if state.paused { "⏸" } else { "▶" };
    let color = if state.paused {
        theme::WARN
    } else {
        theme::SUCCESS
    };
    let file_line = if state.current_file.is_empty() {
        Line::from(Span::styled(
            "No file loaded",
            Style::default().fg(theme::DIM),
        ))
    } else {
        Line::from(Span::styled(
            &state.current_file,
            Style::default().fg(theme::TEXT),
        ))
    };

    f.render_widget(
        Paragraph::new(Line::from(vec![Span::styled(
            format!("{icon}  {}", state.playstate),
            Style::default().fg(color),
        )]))
        .block(block),
        area,
    );
    f.render_widget(Paragraph::new(file_line), rows[1]);

    let dur = state.current_duration;
    let ratio = if dur > 0.0 {
        (state.position_secs / dur).clamp(0.0, 1.0)
    } else {
        0.0
    };
    f.render_widget(
        Gauge::default()
            .ratio(ratio)
            .label(format!(" {:.0}%", ratio * 100.0))
            .gauge_style(Style::default().fg(theme::SEEK))
            .style(Style::default().bg(theme::BG)),
        rows[2],
    );
}

fn draw_peers(f: &mut Frame, area: Rect, state: &UiState) {
    let title = format!("Peers ({})", state.peers.len());
    let block = theme::border(&title);
    let items: Vec<ListItem> = state
        .peers
        .iter()
        .map(|p| {
            let ice_color = match p.ice.as_str() {
                "connected" => theme::SUCCESS,
                "connecting..." => theme::WARN,
                _ => theme::ERROR,
            };
            let ice_dot = match p.ice.as_str() {
                "connected" => "●",
                "connecting..." => "◐",
                _ => "○",
            };
            let ready = if p.ready { "✓" } else { " " };
            let rc = if p.ready { theme::SUCCESS } else { theme::DIM };
            let host_tag = if p.is_host { "(host)" } else { "" };
            let mut spans = vec![
                Span::styled(format!("{ice_dot} "), Style::default().fg(ice_color)),
                Span::styled(
                    format!("{:<14}", p.name),
                    Style::default().fg(if p.is_host { theme::HOST } else { theme::TEXT }),
                ),
                Span::styled(host_tag, Style::default().fg(theme::DIM)),
            ];
            if !p.rtt.is_empty() {
                spans.push(Span::styled(
                    format!(" {:>6}", p.rtt),
                    Style::default().fg(theme::DIM),
                ));
            }
            spans.push(Span::styled(format!(" {ready}"), Style::default().fg(rc)));
            if !p.file.is_empty() {
                spans.push(Span::styled(" 📁", Style::default().fg(theme::DIM)));
            }
            if p.muted {
                spans.push(Span::styled(" 🔇", Style::default().fg(theme::ERROR)));
            }
            ListItem::new(Line::from(spans))
        })
        .collect();
    f.render_widget(List::new(items).block(block), area);
}

fn draw_peers_compact(f: &mut Frame, area: Rect, state: &UiState) {
    let names: Vec<String> = state
        .peers
        .iter()
        .map(|p| {
            let dot = match p.ice.as_str() {
                "connected" => "●",
                "connecting..." => "◐",
                _ => "○",
            };
            let host = if p.is_host { "★" } else { "" };
            format!("{dot}{host} {}", p.name)
        })
        .collect();
    let text: Vec<Line> = names.iter().map(|n| Line::from(n.as_str())).collect();
    f.render_widget(
        Paragraph::new(text).block(theme::border(&format!("Peers ({})", state.peers.len()))),
        area,
    );
}

fn draw_playlist(f: &mut Frame, area: Rect, state: &UiState) {
    let title = format!("Playlist ({})", state.playlist.len());
    let block = theme::border(&title);
    if state.playlist.is_empty() {
        f.render_widget(
            Paragraph::new("Add files with /playlist add <path>").block(block),
            area,
        );
    } else {
        let inner = block.inner(area);
        let visible = PLAYLIST_VISIBLE.min(inner.height as usize);
        let start = state
            .playlist_scroll
            .min(state.playlist.len().saturating_sub(visible));
        let items: Vec<ListItem> = state
            .playlist
            .iter()
            .enumerate()
            .skip(start)
            .take(visible)
            .map(|(i, entry)| {
                let prefix = if i == state.playlist_index {
                    "▶"
                } else {
                    " "
                };
                let dur = if entry.duration > 0.0 {
                    fmt_time(entry.duration)
                } else {
                    "".into()
                };
                let style = if i == state.playlist_index {
                    Style::default()
                        .fg(theme::SUCCESS)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(theme::TEXT)
                };
                ListItem::new(Line::from(vec![
                    Span::styled(format!("{prefix} {:2}. {:<40} ", i + 1, entry.name), style),
                    Span::styled(dur, Style::default().fg(theme::DIM)),
                ]))
            })
            .collect();
        f.render_widget(List::new(items).block(block), area);
    }
}

fn draw_chat(f: &mut Frame, area: Rect, state: &UiState) {
    let block = theme::border("Chat");
    let inner = block.inner(area);
    let total = state.chat.len();
    let visible = CHAT_VISIBLE.min(inner.height as usize);
    let start = if state.chat_scroll > 0 {
        total.saturating_sub(visible + state.chat_scroll)
    } else {
        total.saturating_sub(visible)
    };
    let messages: Vec<Line> = state
        .chat
        .iter()
        .skip(start)
        .take(visible)
        .map(|msg| {
            if msg.starts_with("<you>") {
                Line::from(Span::styled(
                    msg,
                    Style::default()
                        .fg(theme::ACCENT)
                        .add_modifier(Modifier::BOLD),
                ))
            } else if msg.starts_with("---") || msg.starts_with("===") {
                Line::from(Span::styled(msg, Style::default().fg(theme::DIM)))
            } else if msg.contains("latency") {
                Line::from(Span::styled(msg, Style::default().fg(theme::WARN)))
            } else {
                Line::from(Span::styled(msg, Style::default().fg(theme::TEXT)))
            }
        })
        .collect();
    f.render_widget(
        if messages.is_empty() {
            Paragraph::new("No messages").block(block)
        } else {
            Paragraph::new(messages).block(block)
        },
        area,
    );
    if state.chat_scroll > 0 {
        let indicator = format!(" ↑ +{}", state.chat_scroll);
        f.render_widget(
            Paragraph::new(Line::from(Span::styled(
                indicator,
                Style::default().fg(theme::WARN),
            )))
            .alignment(Alignment::Right),
            Rect {
                y: area.y,
                x: area.x + area.width.saturating_sub(12),
                width: 11,
                height: 1,
            },
        );
    }
}

fn draw_input(f: &mut Frame, area: Rect, state: &UiState) {
    let mut spans = vec![Span::styled(" chat> ", Style::default().fg(theme::DIM))];
    if state.input.is_empty() {
        spans.push(Span::styled(
            "type a message, Enter to send",
            Style::default().fg(theme::DIM),
        ));
    } else {
        let cur = state.input_cursor.min(state.input.len());
        let pre = &state.input[..cur];
        let at_char = state
            .input
            .chars()
            .nth(cur)
            .map(|c| c.to_string())
            .unwrap_or_else(|| " ".to_string());
        let post = if cur < state.input.len() {
            &state.input[cur + 1..]
        } else {
            ""
        };
        spans.push(Span::styled(pre, Style::default().fg(theme::TEXT)));
        spans.push(Span::styled(
            at_char,
            Style::default().fg(theme::BG).bg(theme::ACCENT),
        ));
        spans.push(Span::styled(post, Style::default().fg(theme::TEXT)));
    }
    let block = Block::default()
        .borders(Borders::TOP)
        .border_style(Style::default().fg(theme::BORDER))
        .style(Style::default().bg(theme::SURFACE));
    f.render_widget(Paragraph::new(Line::from(spans)).block(block), area);
}

fn draw_help(f: &mut Frame, area: Rect, state: &UiState) {
    if state.help_expanded {
        let h = vec![
            Line::from(Span::styled("KEYBOARD SHORTCUTS", Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD))),
            Line::from(""),
            Line::from(vec![Span::styled(" q/Esc  ", Style::default().fg(theme::DIM)), Span::raw("quit                 "), Span::styled(" ?      ", Style::default().fg(theme::DIM)), Span::raw("toggle help")]),
            Line::from(vec![Span::styled(" space  ", Style::default().fg(theme::DIM)), Span::raw("toggle ready         "), Span::styled(" p      ", Style::default().fg(theme::DIM)), Span::raw("pause/play")]),
            Line::from(vec![Span::styled(" s/a    ", Style::default().fg(theme::DIM)), Span::raw("seek ±10s           "), Span::styled(" m      ", Style::default().fg(theme::DIM)), Span::raw("mute mic")]),
            Line::from(vec![Span::styled(" ↑↓PgUp ", Style::default().fg(theme::DIM)), Span::raw("scroll chat         "), Span::styled(" j/k    ", Style::default().fg(theme::DIM)), Span::raw("scroll playlist")]),
            Line::from(vec![Span::styled(" Enter  ", Style::default().fg(theme::DIM)), Span::raw("send chat           "), Span::styled(" Tab    ", Style::default().fg(theme::DIM)), Span::raw("toggle voice")]),
            Line::from(Span::styled("COMMANDS", Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD))),
            Line::from(Span::styled(" /send <file>  /playlist add/index/clear  /users  /nick <name>  /ready  /controller add/remove <name>  /cancel", Style::default().fg(theme::DIM))),
            Line::from(Span::styled(" /react <n> :emoji:  /shrug  /tableflip  /lenny  /file <path>  /help  /settings", Style::default().fg(theme::DIM))),
        ];
        f.render_widget(
            Paragraph::new(h).block(
                Block::default()
                    .borders(Borders::TOP)
                    .border_style(Style::default().fg(theme::BORDER))
                    .style(Style::default().bg(theme::SURFACE)),
            ),
            area,
        );
    } else {
        let help = Span::styled(" q:quit ?:help space:ready p:pause s:+10s a:-10s <:0.5x >:2x /:1x m:mute enter:chat  /help for commands", Style::default().fg(theme::DIM));
        f.render_widget(
            Paragraph::new(Line::from(help)).style(Style::default().bg(theme::SURFACE)),
            area,
        );
    }
}

// ── Helpers ────────────────────────────────────────────────────────────

fn fmt_time(secs: f64) -> String {
    if secs <= 0.0 || !secs.is_finite() {
        return "--:--:--".into();
    }
    let total = secs as u64;
    let h = total / 3600;
    let m = (total % 3600) / 60;
    let s = total % 60;
    if h > 0 {
        format!("{h:02}:{m:02}:{s:02}")
    } else {
        format!("{m:02}:{s:02}")
    }
}

// ── Emoji / Commands ───────────────────────────────────────────────────

fn expand_emojis(msg: &str) -> String {
    let mut r = msg.to_string();
    for (code, emoji) in emoji_map().iter() {
        r = r.replace(code, emoji);
    }
    r
}

fn emoji_map() -> &'static [(&'static str, &'static str)] {
    &[
        (":smile:", "😊"),
        (":joy:", "😂"),
        (":heart:", "❤️"),
        (":thumbsup:", "👍"),
        (":thumbsdown:", "👎"),
        (":clap:", "👏"),
        (":wave:", "👋"),
        (":fire:", "🔥"),
        (":star:", "⭐"),
        (":tada:", "🎉"),
        (":100:", "💯"),
        (":ok_hand:", "👌"),
        (":sob:", "😭"),
        (":cry:", "😢"),
        (":angry:", "😠"),
        (":skull:", "💀"),
        (":rocket:", "🚀"),
        (":check:", "✅"),
        (":x:", "❌"),
        (":warning:", "⚠️"),
        (":popcorn:", "🍿"),
        (":movie_camera:", "🎥"),
        (":beer:", "🍺"),
        (":coffee:", "☕"),
        (":sunglasses:", "😎"),
        (":wink:", "😉"),
        (":pray:", "🙏"),
        (":muscle:", "💪"),
        (":party:", "🥳"),
        (":robot:", "🤖"),
        (":alien:", "👽"),
        (":ghost:", "👻"),
        (":sleepy:", "😴"),
        (":zap:", "⚡"),
        (":bulb:", "💡"),
        (":lock:", "🔒"),
        (":headphones:", "🎧"),
        (":mic:", "🎤"),
        (":mute:", "🔇"),
    ]
}

const SHRUG: &str = "¯\\_(ツ)_/¯";
const TABLEFLIP: &str = "(╯°□°）╯︵ ┻━┻";
const UNFLIP: &str = "┬─┬ ノ( ゜-゜ノ)";
const LENNY: &str = "( ͡° ͜ʖ ͡°)";

// Guard dropped before await in each async branch.
#[allow(clippy::await_holding_lock)]
async fn handle_command(input: &str, state: &Arc<Mutex<UiState>>, sync: &SyncManager) {
    let parts: Vec<&str> = input.splitn(3, ' ').collect();
    let cmd = parts[0];
    let arg1 = parts.get(1).copied().unwrap_or("");
    let arg2 = parts.get(2).copied().unwrap_or("");
    let response = match cmd {
        "/help" | "/h" => "/send <file> [peer] /playlist add/index/clear /controller add/remove /ready /react /users /nick <name> /cancel /shrug /tableflip /lenny /file <path> /settings".to_string(),
        "/send" | "/download" | "/dl" => {
            if arg1.is_empty() { "Usage: /send <filepath>".to_string() }
            else {
                let conn = sync.get_connection();
                if let Some(target) = conn.peers().first() {
                    match crate::file_transfer::send_file_with_subs(&conn, target, arg1, 0).await {
                        Ok(sent) => format!("Sent {} file(s)", sent.len()),
                        Err(e) => format!("Failed: {e}"),
                    }
                } else { "No peers connected".to_string() }
            }
        }
        "/file" => {
            if arg1.is_empty() { "Usage: /file <path> — load file in player".to_string() }
            else {
                let sock = sync.get_player_socket();
                if let Some(s) = sock {
                    match crate::player_controller::PlayerController::open_file(&s, arg1).await {
                        Ok(()) => format!("Loaded: {arg1}"),
                        Err(e) => format!("Failed: {e}"),
                    }
                } else { "No player running — start with a player installed".to_string() }
            }
        }
        "/playlist" if arg1 == "add" => {
            if arg2.is_empty() { "Usage: /playlist add <filepath>".to_string() }
            else {
                let files: Vec<FileEntry> = arg2.split(',').map(|f| FileEntry { name: f.trim().to_string(), duration: 0.0 }).collect();
                sync.set_playlist(files).await;
                format!("Added {} file(s)", arg2.split(',').count())
            }
        }
        "/playlist" if arg1 == "index" => {
            if let Ok(n) = arg2.parse::<usize>() { sync.set_playlist_index(n).await; format!("Jumping to item {n}") }
            else { "Usage: /playlist index <n>".to_string() }
        }
        "/playlist" if arg1 == "clear" => {
            sync.set_playlist(vec![]).await;
            "Playlist cleared".to_string()
        }
        "/ready" => { sync.set_ready(true, None).await; "You are now ready".to_string() }
        "/users" | "/who" => {
            let stats = sync.get_peer_stats();
            let names: Vec<String> = stats.iter().map(|(_, name, _, _)| name.clone()).collect();
            format!("{} peers: {}", names.len(), names.join(", "))
        }
        "/nick" => {
            if arg1.is_empty() { "Usage: /nick <newname>".to_string() }
            else { format!("Nick change requires reconnect — restart with --username {arg1}") }
        }
        "/cancel" => {
            "To cancel a transfer, restart the client — transfers cannot be cancelled mid-flight".to_string()
        }
        cmd if cmd.starts_with("/controller") => {
            if !sync.is_host() { "Only host can manage controllers".to_string() }
            else if arg1 == "add" && !arg2.is_empty() { sync.add_controller(arg2); sync.send_controller_change(arg2, crate::messages::ControllerAction::Add).await; format!("{arg2} can now control playback") }
            else if arg1 == "remove" && !arg2.is_empty() { sync.remove_controller(arg2); sync.send_controller_change(arg2, crate::messages::ControllerAction::Remove).await; format!("{arg2} removed from controllers") }
            else { "Usage: /controller add <name> or /controller remove <name>".to_string() }
        }
        "/settings" => {
            format!("Room: {} | Player: {} | TURN: {} | DL: {}",
                state.lock().room,
                if sync.get_player_socket().is_some() { "running" } else { "none" },
                if state.lock().has_turn { "yes" } else { "no" },
                "~/Downloads/syncplay")
        }
        "/shrug" => format!("<you> {}", SHRUG),
        "/tableflip" => format!("<you> {}", TABLEFLIP),
        "/unflip" => format!("<you> {}", UNFLIP),
        "/lenny" => format!("<you> {}", LENNY),
        "/flip" => format!("<you> {}", TABLEFLIP),
        cmd if cmd.starts_with("/react") => {
            if arg1.is_empty() { "Usage: /react <n> :emoji:".to_string() }
            else if let Ok(n) = arg1.parse::<usize>() {
                let emoji = if arg2.is_empty() { "👍" } else { arg2 };
                let expanded = expand_emojis(emoji);
                let msg = format!("reaction: {expanded}");
                let mut s = state.lock();
                if let Some(original) = s.chat.iter().rev().nth(n) {
                    let preview = if original.len() > 30 { format!("{}...", &original[..30]) } else { original.clone() };
                    s.chat.push(format!("{:>12} reacted with {expanded} to \"{preview}\"", "you"));
                    if s.chat.len() > 500 { s.chat.remove(0); }
                    drop(s); sync.send_chat(&msg).await; "Reaction sent!".to_string()
                } else { format!("No message at index {n}") }
            } else { "Usage: /react <n> :emoji:".to_string() }
        }
        _ => format!("Unknown: {cmd}. Try /help"),
    };
    if !response.is_empty() {
        let mut s = state.lock();
        s.chat.push(format!("--- {}", expand_emojis(&response)));
        if s.chat.len() > 500 {
            s.chat.remove(0);
        }
    }
}
