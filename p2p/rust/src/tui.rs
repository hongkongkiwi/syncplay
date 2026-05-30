//! Terminal UI for Syncplay P2P (ratatui + crossterm).
//!
//! Multi-panel layout: status bar → [peers+playback | chat+playlist] → input → help.
//! Event-driven updates via callbacks registered on SyncManager/ConnectionManager.
//! Chat input with cursor, scrolling, progress bars, color theme.

use std::collections::HashMap;
use std::io;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use crossterm::terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen};
use crossterm::ExecutableCommand;
use parking_lot::Mutex;
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Gauge, List, ListItem, Paragraph};
use ratatui::Frame;

use crate::sync::SyncManager;
use crate::messages::FileEntry;

// ── Theme ──────────────────────────────────────────────────────────────

mod theme {
    use super::*;

    pub const BG: Color = Color::Rgb(18, 18, 24);
    pub const SURFACE: Color = Color::Rgb(28, 28, 38);
    pub const BORDER: Color = Color::Rgb(60, 60, 75);
    pub const TEXT: Color = Color::Rgb(220, 220, 230);
    pub const DIM: Color = Color::Rgb(120, 120, 140);
    pub const ACCENT: Color = Color::Rgb(100, 180, 255);   // blue
    pub const SUCCESS: Color = Color::Rgb(80, 220, 120);    // green
    pub const WARN: Color = Color::Rgb(255, 200, 60);       // amber
    pub const ERROR: Color = Color::Rgb(255, 80, 80);       // red
    pub const HOST: Color = Color::Rgb(200, 140, 255);      // purple
    pub const SEEK: Color = Color::Rgb(100, 220, 200);      // teal

    pub fn border_block(title: &str) -> Block<'_> {
        Block::default()
            .title(title)
            .borders(Borders::ALL)
            .border_style(Style::default().fg(BORDER))
            .style(Style::default().bg(SURFACE))
    }
}

// ── Shared UI state ────────────────────────────────────────────────────

pub struct PeerRow {
    pub name: String,
    pub ice: String,
    pub rtt: String,
    pub ready: bool,
    pub file: String,
    pub muted: bool,
}

#[derive(Default)]
pub struct TransferState {
    pub transfer_id: String,
    pub filename: String,
    pub direction: TransferDirection,
    pub progress: f64,      // 0.0 – 1.0
    pub total_bytes: u64,
    pub received_bytes: u64,
}

#[derive(Default)]
pub enum TransferDirection {
    #[default] Sending,
    Receiving,
}

pub struct UiState {
    pub playstate: String,
    pub position_secs: f64,
    pub paused: bool,
    pub peers: Vec<PeerRow>,
    pub chat: Vec<String>,
    pub chat_scroll: usize,      // scroll offset for chat (0 = bottom)
    pub playlist: Vec<FileEntry>,
    pub playlist_scroll: usize,
    pub playlist_index: usize,
    pub ready_states: HashMap<String, bool>,
    pub room: String,
    pub connected: bool,
    pub host: bool,
    pub input: String,           // chat input buffer
    pub input_cursor: usize,
    pub transfers: Vec<TransferState>,
    pub voice_enabled: bool,
    pub voice_muted: bool,
    pub subtitle_announcements: Vec<String>,
    pub latency_warnings: Vec<String>,
    pub help_expanded: bool,
}

impl Default for UiState {
    fn default() -> Self {
        Self {
            playstate: "Waiting...".into(),
            position_secs: 0.0,
            paused: true,
            peers: vec![],
            chat: vec![],
            chat_scroll: 0,
            playlist: vec![],
            playlist_scroll: 0,
            playlist_index: 0,
            ready_states: HashMap::new(),
            room: "---".into(),
            connected: false,
            host: false,
            input: String::new(),
            input_cursor: 0,
            transfers: vec![],
            voice_enabled: false,
            voice_muted: false,
            subtitle_announcements: vec![],
            latency_warnings: vec![],
            help_expanded: false,
        }
    }
}

// ── Layout ─────────────────────────────────────────────────────────────

/// Number of chat messages visible per panel (scrollable).
const CHAT_VISIBLE: usize = 15;
/// Max chat scrollback (0 = bottom/newest).
const CHAT_MAX_SCROLL: usize = 200;
/// Number of playlist items visible.
const PLAYLIST_VISIBLE: usize = 12;

pub async fn run_tui(
    state: Arc<Mutex<UiState>>,
    sync: SyncManager,
    room: String,
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

    let sync_shutdown = std::sync::Arc::new(tokio::sync::Notify::new());
    let ss = sync_shutdown.clone();

    loop {
        // Heartbeat: poll room state from SyncManager
        if last_tick.elapsed() >= tick_rate {
            let snapshot = sync.get_room_state();
            let latencies = sync.get_latencies();
            let conn_stats = sync.get_peer_stats();
            let mut s = state.lock();
            s.host = sync.is_host();
            s.position_secs = snapshot.position;
            s.paused = snapshot.paused;
            s.playstate = fmt_playstate(snapshot.position, snapshot.paused);
            s.playlist = snapshot.playlist;
            s.playlist_index = snapshot.playlist_index;
            s.ready_states = snapshot.ready_states;

            // Merge peer stats
            for (pid, uname, _ice, display) in &conn_stats {
                let rs = s.ready_states.clone();
                if let Some(peer) = s.peers.iter_mut().find(|p| p.name == *uname || p.name == *pid) {
                    peer.ice = display.clone();
                    if let Some(rtt) = latencies.get(uname) {
                        peer.rtt = format!("{:.0}ms", rtt * 1000.0);
                    }
                    peer.ready = rs.get(uname).copied().unwrap_or(false);
                } else {
                    s.peers.push(PeerRow {
                        name: if uname == "unknown" { pid.clone() } else { uname.clone() },
                        ice: display.clone(),
                        rtt: latencies.get(uname).map(|r| format!("{:.0}ms", r * 1000.0)).unwrap_or_default(),
                        ready: rs.get(uname).copied().unwrap_or(false),
                        file: String::new(),
                        muted: false,
                    });
                }
            }
            // Remove stale peers
            s.peers.retain(|p| conn_stats.iter().any(|(_, u, _, _)| u == &p.name));

            // Remove expired transfer states (completed ones after 5s)
            s.transfers.retain(|t| t.progress < 1.0);

            // Drain latency warnings into chat-style messages
            for (name, rtt) in &latencies {
                if *rtt > 0.5 && !s.latency_warnings.iter().any(|w| w.contains(name)) {
                    s.latency_warnings.push(format!("⚠ {name} latency {:.0}ms", rtt * 1000.0));
                    if s.latency_warnings.len() > 5 { s.latency_warnings.remove(0); }
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
            let should_quit = handle_input(ev, &state, &sync).await;
            if should_quit {
                break;
            }
        }
    }

    // Graceful shutdown
    sync.stop().await;
    disable_raw_mode()?;
    stdout.execute(LeaveAlternateScreen)?;
    let _ = ss.notified();
    Ok(())
}

// ── Input ──────────────────────────────────────────────────────────────

async fn handle_input(ev: Event, state: &Arc<Mutex<UiState>>, sync: &SyncManager) -> bool {
    match ev {
        Event::Key(key) if key.kind == KeyEventKind::Press => {
            let mut s = state.lock();
            match key.code {
                KeyCode::Char('q') | KeyCode::Esc => {
                    if s.input.is_empty() { return true; }
                    s.input.clear();
                    s.input_cursor = 0;
                }
                KeyCode::Char('?') => {
                    s.help_expanded = !s.help_expanded;
                }
                // Playback
                KeyCode::Char(' ') => {
                    if s.connected { drop(s); sync.set_ready(true, None).await; }
                }
                KeyCode::Char('p') => {
                    if s.connected { drop(s); sync.request_pause().await; }
                }
                KeyCode::Char('s') => {
                    // Seek forward 10 seconds
                    if s.connected {
                        let pos = s.position_secs + 10.0;
                        drop(s); sync.request_seek(pos).await;
                    }
                }
                KeyCode::Char('a') => {
                    // Seek backward 10 seconds
                    if s.connected {
                        let pos = (s.position_secs - 10.0).max(0.0);
                        drop(s); sync.request_seek(pos).await;
                    }
                }
                KeyCode::Char('m') => {
                    s.voice_muted = !s.voice_muted;
                    // TODO: wire to VoiceChat::set_muted when integrated
                }
                // Chat scrolling
                KeyCode::PageUp => {
                    s.chat_scroll = (s.chat_scroll + CHAT_VISIBLE).min(CHAT_MAX_SCROLL);
                }
                KeyCode::PageDown => {
                    s.chat_scroll = s.chat_scroll.saturating_sub(CHAT_VISIBLE);
                }
                KeyCode::Up => {
                    if s.chat_scroll < CHAT_MAX_SCROLL { s.chat_scroll += 1; }
                }
                KeyCode::Down => {
                    s.chat_scroll = s.chat_scroll.saturating_sub(1);
                }
                // Playlist scrolling
                KeyCode::Char('j') => {
                    s.playlist_scroll = (s.playlist_scroll + 1).min(s.playlist.len().saturating_sub(PLAYLIST_VISIBLE));
                }
                KeyCode::Char('k') => {
                    s.playlist_scroll = s.playlist_scroll.saturating_sub(1);
                }
                // Chat input
                KeyCode::Enter => {
                    let msg = s.input.clone();
                    if !msg.is_empty() && s.connected {
                        s.input.clear();
                        s.input_cursor = 0;
                        drop(s);
                        sync.send_chat(&msg).await;
                        let mut s2 = state.lock();
                        s2.chat.push(format!("<you> {msg}"));
                        if s2.chat.len() > 500 { s2.chat.remove(0); }
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
                    if c == '/' {
                        s.input.push(c);
                        s.input_cursor += 1;
                    } else {
                        let pos = s.input_cursor;
                        if pos <= s.input.len() {
                            s.input.insert(pos, c);
                            s.input_cursor = pos + 1;
                        }
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

// ── Draw ───────────────────────────────────────────────────────────────

fn draw(f: &mut Frame, state: &UiState) {
    let bg = Style::default().bg(theme::BG);
    f.render_widget(Block::default().style(bg), f.area());

    let area = f.area();
    let help_height = if state.help_expanded { 8 } else { 1 };
    let input_height = 1;

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),                // status bar
            Constraint::Min(1),                    // main area
            Constraint::Length(input_height),      // chat input
            Constraint::Length(help_height),       // help bar
        ])
        .split(area);

    draw_status(f, chunks[0], state);

    let main = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(35), Constraint::Percentage(65)])
        .split(chunks[1]);

    // Left column: peers + playback
    let left = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(5), Constraint::Min(0)])
        .split(main[0]);
    draw_playback(f, left[0], state);
    draw_peers(f, left[1], state);

    // Right column: chat + playlist (or transfers if active)
    let right = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage(55),
            Constraint::Percentage(30),
            Constraint::Percentage(15),
        ])
        .split(main[1]);
    draw_chat(f, right[0], state);
    draw_playlist(f, right[1], state);
    draw_transfers(f, right[2], state);

    draw_input(f, chunks[2], state);
    draw_help(f, chunks[3], state);
}

// ── Widgets ────────────────────────────────────────────────────────────

fn draw_status(f: &mut Frame, area: Rect, state: &UiState) {
    let mut spans = vec![];

    if state.connected {
        spans.push(Span::styled(" ● ", Style::default().fg(theme::SUCCESS)));
        spans.push(Span::styled(&state.room, Style::default().fg(theme::ACCENT)));
        spans.push(Span::styled("  |  ", Style::default().fg(theme::DIM)));

        let role = if state.host { "HOST" } else { "peer" };
        let role_color = if state.host { theme::HOST } else { theme::ACCENT };
        spans.push(Span::styled(role, Style::default().fg(role_color)));
        spans.push(Span::styled("  |  ", Style::default().fg(theme::DIM)));
        spans.push(Span::styled(format!("{} peer{}", state.peers.len(), if state.peers.len() == 1 { "" } else { "s" }), Style::default().fg(theme::TEXT)));

        if state.voice_enabled {
            spans.push(Span::styled("  |  ", Style::default().fg(theme::DIM)));
            let (icon, color) = if state.voice_muted {
                ("🎤✗", theme::ERROR)
            } else {
                ("🎤", theme::SUCCESS)
            };
            spans.push(Span::styled(icon, Style::default().fg(color)));
        }
    } else {
        spans.push(Span::styled(" ○ Disconnected — connecting...", Style::default().fg(theme::ERROR)));
    }

    f.render_widget(
        Paragraph::new(Line::from(spans)).style(Style::default().bg(theme::SURFACE)),
        area,
    );
}

fn draw_playback(f: &mut Frame, area: Rect, state: &UiState) {
    let block = theme::border_block("Playback");
    let _inner = block.inner(area);

    let text = if state.paused {
        Line::from(vec![
            Span::styled("⏸ ", Style::default().fg(theme::WARN)),
            Span::styled(&state.playstate, Style::default().fg(theme::TEXT)),
        ])
    } else {
        Line::from(vec![
            Span::styled("▶ ", Style::default().fg(theme::SUCCESS)),
            Span::styled(&state.playstate, Style::default().fg(theme::TEXT)),
        ])
    };

    f.render_widget(Paragraph::new(text).block(block), area);
}

fn draw_peers(f: &mut Frame, area: Rect, state: &UiState) {
    let title = format!("Peers ({})", state.peers.len());
    let block = theme::border_block(&title);
    let _inner = block.inner(area);

    let items: Vec<ListItem> = state
        .peers
        .iter()
        .map(|p| {
            let ice_color = match p.ice.as_str() {
                "connected" => theme::SUCCESS,
                "connecting..." => theme::WARN,
                _ => theme::ERROR,
            };
            let ice_icon = match p.ice.as_str() {
                "connected" => "●",
                "connecting..." => "◐",
                _ => "○",
            };
            let ready_icon = if p.ready { "✓" } else { " " };
            let ready_color = if p.ready { theme::SUCCESS } else { theme::DIM };
            let mute_icon = if p.muted { "🔇" } else { "" };

            let mut spans = vec![
                Span::styled(format!("{:12} ", p.name), Style::default().fg(theme::TEXT)),
                Span::styled(format!("{ice_icon} "), Style::default().fg(ice_color)),
                Span::styled(format!("{:<12}", p.ice), Style::default().fg(ice_color)),
            ];
            if !p.rtt.is_empty() {
                spans.push(Span::styled(format!(" {:>6} ", p.rtt), Style::default().fg(theme::DIM)));
            }
            if !p.file.is_empty() {
                spans.push(Span::styled(format!("📁{} ", p.file), Style::default().fg(theme::DIM)));
            }
            spans.push(Span::styled(format!(" {ready_icon} "), Style::default().fg(ready_color)));
            if !mute_icon.is_empty() {
                spans.push(Span::styled(mute_icon, Style::default().fg(theme::ERROR)));
            }

            ListItem::new(Line::from(spans))
        })
        .collect();

    f.render_widget(List::new(items).block(block), area);
}

fn draw_chat(f: &mut Frame, area: Rect, state: &UiState) {
    let block = theme::border_block("Chat");
    let inner = block.inner(area);

    let total = state.chat.len();
    let visible = CHAT_VISIBLE.min(inner.height as usize);
    let start = if state.chat_scroll > 0 {
        total.saturating_sub(visible + state.chat_scroll)
    } else {
        total.saturating_sub(visible)
    };

    let messages: Vec<Line> = state.chat
        .iter()
        .skip(start)
        .take(visible)
        .map(|msg| {
            if msg.starts_with("<you>") {
                Line::from(vec![
                    Span::styled(msg, Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD)),
                ])
            } else if msg.starts_with("---") || msg.starts_with("===") {
                Line::from(vec![
                    Span::styled(msg, Style::default().fg(theme::DIM)),
                ])
            } else if msg.starts_with("⚠") {
                Line::from(vec![
                    Span::styled(msg, Style::default().fg(theme::WARN)),
                ])
            } else {
                Line::from(vec![
                    Span::styled(msg, Style::default().fg(theme::TEXT)),
                ])
            }
        })
        .collect();

    if messages.is_empty() {
        f.render_widget(
            Paragraph::new(Line::from(Span::styled("No messages yet", Style::default().fg(theme::DIM)))).block(block),
            area,
        );
    } else {
        f.render_widget(Paragraph::new(messages).block(block), area);
    }

    // Scroll indicator
    if state.chat_scroll > 0 {
        let indicator = format!(" ↑ +{} more", state.chat_scroll);
        f.render_widget(
            Paragraph::new(Line::from(Span::styled(indicator, Style::default().fg(theme::WARN)))).alignment(Alignment::Right),
            Rect { y: area.y, x: area.x + area.width.saturating_sub(15), width: 14, height: 1 },
        );
    }
}

fn draw_playlist(f: &mut Frame, area: Rect, state: &UiState) {
    let title = format!("Playlist ({})", state.playlist.len());
    let block = theme::border_block(&title);
    let inner = block.inner(area);

    let total = state.playlist.len();
    let visible = PLAYLIST_VISIBLE.min(inner.height as usize);
    let start = state.playlist_scroll.min(total.saturating_sub(visible));

    let items: Vec<ListItem> = state.playlist
        .iter()
        .enumerate()
        .skip(start)
        .take(visible)
        .map(|(i, entry)| {
            let prefix = if i == state.playlist_index { "▶" } else { " " };
            let dur = if entry.duration > 0.0 { fmt_duration(entry.duration) } else { "".into() };
            let style = if i == state.playlist_index {
                Style::default().fg(theme::SUCCESS).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(theme::TEXT)
            };
            ListItem::new(Line::from(vec![
                Span::styled(format!("{prefix} {:2}. {:40} ", i + 1, entry.name), style),
                Span::styled(dur, Style::default().fg(theme::DIM)),
            ]))
        })
        .collect();

    if items.is_empty() {
        f.render_widget(
            Paragraph::new(Line::from(Span::styled("Playlist empty", Style::default().fg(theme::DIM)))).block(block),
            area,
        );
    } else {
        f.render_widget(List::new(items).block(block), area);
    }
}

fn draw_transfers(f: &mut Frame, area: Rect, state: &UiState) {
    if state.transfers.is_empty() {
        // Show subtitle announcements if any
        if !state.subtitle_announcements.is_empty() {
            let text: Vec<Line> = state.subtitle_announcements
                .iter()
                .map(|a| Line::from(Span::styled(a.as_str(), Style::default().fg(theme::SEEK))))
                .collect();
            f.render_widget(Paragraph::new(text).block(theme::border_block("Subtitles")), area);
        }
        return;
    }

    let block = theme::border_block("Transfers");
    let inner = block.inner(area);
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(state.transfers.iter().map(|_| Constraint::Length(1)).collect::<Vec<_>>())
        .split(inner);

    for (i, t) in state.transfers.iter().enumerate() {
        if i >= chunks.len() { break; }
        let dir_icon = match t.direction {
            TransferDirection::Sending => "↑",
            TransferDirection::Receiving => "↓",
        };
        let label = format!("{dir_icon} {} [{:.0}%]", t.filename, t.progress * 100.0);
        let gauge = Gauge::default()
            .label(label)
            .ratio(t.progress as f64)
            .gauge_style(Style::default().fg(theme::SEEK))
            .block(Block::default().style(Style::default().bg(theme::SURFACE)));
        f.render_widget(gauge, chunks[i]);
    }
}

fn draw_input(f: &mut Frame, area: Rect, state: &UiState) {
    let mut spans = vec![
        Span::styled(" chat> ", Style::default().fg(theme::DIM)),
    ];

    if state.input.is_empty() {
        spans.push(Span::styled("type /h for help, enter to send", Style::default().fg(theme::DIM)));
    } else {
        // Show text with cursor
        let pre = &state.input[..state.input_cursor.min(state.input.len())];
        let at = state.input.chars().nth(state.input_cursor).unwrap_or(' ');
        let post = &state.input[state.input_cursor + state.input.len().min(state.input_cursor + 1).min(state.input.len())..];

        spans.push(Span::styled(pre, Style::default().fg(theme::TEXT)));
        spans.push(Span::styled(format!("{at}"), Style::default().fg(theme::BG).bg(theme::ACCENT)));
        spans.push(Span::styled(post, Style::default().fg(theme::TEXT)));
        spans.push(Span::styled(" ", Style::default().bg(theme::ACCENT))); // show cursor at end
    }

    let block = Block::default()
        .borders(Borders::TOP)
        .border_style(Style::default().fg(theme::BORDER))
        .style(Style::default().bg(theme::SURFACE));

    f.render_widget(Paragraph::new(Line::from(spans)).block(block), area);
}

fn draw_help(f: &mut Frame, area: Rect, state: &UiState) {
    if state.help_expanded {
        let help_text = vec![
            Line::from(Span::styled("KEYS", Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD))),
            Line::from(""),
            Line::from(vec![
                Span::styled(" q/Esc  ", Style::default().fg(theme::DIM)),
                Span::raw("quit              "),
                Span::styled(" ?      ", Style::default().fg(theme::DIM)),
                Span::raw("toggle help"),
            ]),
            Line::from(vec![
                Span::styled(" space  ", Style::default().fg(theme::DIM)),
                Span::raw("toggle ready      "),
                Span::styled(" p      ", Style::default().fg(theme::DIM)),
                Span::raw("pause/play"),
            ]),
            Line::from(vec![
                Span::styled(" s      ", Style::default().fg(theme::DIM)),
                Span::raw("seek +10s        "),
                Span::styled(" a      ", Style::default().fg(theme::DIM)),
                Span::raw("seek -10s"),
            ]),
            Line::from(vec![
                Span::styled(" m      ", Style::default().fg(theme::DIM)),
                Span::raw("toggle voice mute  "),
                Span::styled(" Tab    ", Style::default().fg(theme::DIM)),
                Span::raw("toggle voice"),
            ]),
            Line::from(vec![
                Span::styled(" ↑↓PgUp/Dn ", Style::default().fg(theme::DIM)),
                Span::raw("scroll chat       "),
                Span::styled(" j/k    ", Style::default().fg(theme::DIM)),
                Span::raw("scroll playlist"),
            ]),
            Line::from(vec![
                Span::styled(" Enter  ", Style::default().fg(theme::DIM)),
                Span::raw("send chat message"),
            ]),
        ];
        let block = Block::default()
            .borders(Borders::TOP)
            .border_style(Style::default().fg(theme::BORDER))
            .style(Style::default().bg(theme::SURFACE));
        f.render_widget(Paragraph::new(help_text).block(block), area);
    } else {
        let help = Span::styled(
            " q:quit  ?:help  space:ready  p:pause  s:+10s  a:-10s  m:mute  ↑↓:scroll  enter:chat",
            Style::default().fg(theme::DIM),
        );
        f.render_widget(
            Paragraph::new(Line::from(help)).style(Style::default().bg(theme::SURFACE)),
            area,
        );
    }
}

// ── Helpers ────────────────────────────────────────────────────────────

fn fmt_playstate(secs: f64, paused: bool) -> String {
    let h = secs as u64 / 3600;
    let m = (secs as u64 % 3600) / 60;
    let s = secs as u64 % 60;
    let state = if paused { "⏸" } else { "▶" };
    format!("{state} {:02}:{:02}:{:02}", h, m, s)
}

fn fmt_duration(secs: f64) -> String {
    let h = secs as u64 / 3600;
    let m = (secs as u64 % 3600) / 60;
    let s = secs as u64 % 60;
    format!("{:02}:{:02}:{:02}", h, m, s)
}
