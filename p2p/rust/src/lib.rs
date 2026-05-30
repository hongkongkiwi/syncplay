//! Syncplay P2P — Pure Rust WebRTC Core
//!
//! This crate provides:
//!   - `syncplay-signaling` binary: lightweight WebSocket signaling server
//!   - `syncplay-tui` binary: ratatui terminal UI for watching together

pub mod config;
pub mod error;
pub mod file_transfer;
pub mod messages;
pub mod player;
pub mod player_controller;
pub mod voice_chat;
pub mod wire;
pub mod connection;
pub mod signalling;
pub mod sync;

/// Current UNIX timestamp in milliseconds.
pub fn now_ms() -> u64 {
    use std::time::SystemTime;
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(feature = "tui")]
pub mod tui;
