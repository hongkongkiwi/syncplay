//! P2P configuration with sensible defaults.
//!
//! Replaces the ~100 Twisted-era config options with ~20 P2P-relevant ones.

use serde::{Deserialize, Serialize};

/// Complete P2P client configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct P2pConfig {
    /// Display name in rooms
    #[serde(default = "default_username")]
    pub username: String,

    /// Signaling server WebSocket URL
    #[serde(default = "default_signaling_url")]
    pub signaling_url: String,

    /// Room name to join/create
    #[serde(default)]
    pub room: String,

    /// Room password (empty = no password)
    #[serde(default)]
    pub password: String,

    /// Media player settings
    #[serde(default)]
    pub player: PlayerConfig,

    /// Network settings
    #[serde(default)]
    pub network: NetworkConfig,

    /// Sync behaviour
    #[serde(default)]
    pub sync: SyncConfig,

    /// Features to advertise
    #[serde(default = "default_features")]
    pub features: Vec<String>,

    /// Enable voice chat
    #[serde(default)]
    pub voice_enabled: bool,

    /// SFU mode — connect to server as single peer (star topology)
    #[serde(default)]
    pub sfu_enabled: bool,

    /// Directory for downloaded files (default: ~/Downloads/syncplay)
    #[serde(default = "default_download_dir")]
    pub download_dir: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct PlayerConfig {
    /// Path to player binary (auto-detected if empty)
    #[serde(default)]
    pub path: String,

    /// Extra arguments passed to player
    #[serde(default)]
    pub args: Vec<String>,

    /// File to open on start
    #[serde(default)]
    pub file: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkConfig {
    /// Custom STUN servers (defaults to Google STUN)
    #[serde(default = "default_stun")]
    pub stun_servers: Vec<String>,

    /// Custom TURN servers (format: "turn:user:pass@host:port")
    #[serde(default)]
    pub turn_servers: Vec<String>,

    /// Signaling server reconnect delay (seconds)
    #[serde(default = "default_reconnect_delay")]
    pub reconnect_delay_secs: u64,

    /// Max signaling reconnect attempts (0 = unlimited)
    #[serde(default)]
    pub max_reconnect_attempts: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncConfig {
    /// Playstate broadcast interval (milliseconds)
    #[serde(default = "default_sync_interval")]
    pub sync_interval_ms: u64,

    /// Latency ping interval (milliseconds)
    #[serde(default = "default_ping_interval")]
    pub ping_interval_ms: u64,

    /// Max playlist items
    #[serde(default = "default_max_playlist")]
    pub max_playlist_items: usize,

    /// Max chat message length
    #[serde(default = "default_max_chat")]
    pub max_chat_length: usize,

    /// Whether to be ready on join
    #[serde(default)]
    pub ready_at_start: bool,
}

// ── Defaults ────────────────────────────────────────────────────────────

fn default_username() -> String {
    whoami::fallible::username().unwrap_or_else(|_| "anonymous".into())
}

fn default_signaling_url() -> String {
    "ws://127.0.0.1:8998".into()
}

fn default_features() -> Vec<String> {
    vec!["chat".into(), "readiness".into(), "playlist".into()]
}

fn default_stun() -> Vec<String> {
    vec![
        "stun:stun.l.google.com:19302".into(),
        "stun:stun1.l.google.com:19302".into(),
    ]
}

fn default_reconnect_delay() -> u64 {
    5
}
fn default_sync_interval() -> u64 {
    500
}
fn default_ping_interval() -> u64 {
    2000
}
fn default_max_playlist() -> usize {
    250
}
fn default_max_chat() -> usize {
    2000
}

fn default_download_dir() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    format!("{home}/Downloads/syncplay")
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            stun_servers: default_stun(),
            turn_servers: vec![],
            reconnect_delay_secs: 5,
            max_reconnect_attempts: 5,
        }
    }
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            sync_interval_ms: 500,
            ping_interval_ms: 2000,
            max_playlist_items: 250,
            max_chat_length: 2000,
            ready_at_start: false,
        }
    }
}

impl Default for P2pConfig {
    fn default() -> Self {
        Self {
            username: default_username(),
            signaling_url: default_signaling_url(),
            room: String::new(),
            password: String::new(),
            player: PlayerConfig::default(),
            network: NetworkConfig::default(),
            sync: SyncConfig::default(),
            features: default_features(),
            voice_enabled: false,
            sfu_enabled: false,
            download_dir: default_download_dir(),
        }
    }
}

impl P2pConfig {
    /// Load from a JSON file, falling back to defaults.
    pub fn load(path: &str) -> anyhow::Result<Self> {
        let data = std::fs::read_to_string(path)?;
        let cfg: Self = serde_json::from_str(&data)?;
        Ok(cfg)
    }

    /// Save current config to a JSON file.
    pub fn save(&self, path: &str) -> anyhow::Result<()> {
        let data = serde_json::to_string_pretty(self)?;
        std::fs::write(path, data)?;
        Ok(())
    }

    /// Merge CLI overrides into config.
    pub fn apply_overrides(&mut self, overrides: &ConfigOverrides) {
        if let Some(ref u) = overrides.username {
            self.username = u.clone();
        }
        if let Some(ref r) = overrides.room {
            self.room = r.clone();
        }
        if let Some(ref p) = overrides.password {
            self.password = p.clone();
        }
        if let Some(ref url) = overrides.signaling_url {
            self.signaling_url = url.clone();
        }
        if let Some(ref path) = overrides.player_path {
            self.player.path = path.clone();
        }
        if let Some(ref file) = overrides.file {
            self.player.file = Some(file.clone());
        }
        if let Some(sfu) = overrides.sfu {
            self.sfu_enabled = sfu;
        }
    }

    /// Build ICE server config from STUN + TURN servers.
    pub fn ice_servers(&self) -> Vec<webrtc::ice_transport::ice_server::RTCIceServer> {
        let mut servers = Vec::new();
        if !self.network.stun_servers.is_empty() {
            servers.push(webrtc::ice_transport::ice_server::RTCIceServer {
                urls: self.network.stun_servers.clone(),
                ..Default::default()
            });
        }
        for turn_url in &self.network.turn_servers {
            // Parse "turn:user:pass@host:port" or "turns:user:pass@host:port"
            let (url, username, credential) = parse_turn_url(turn_url);
            servers.push(webrtc::ice_transport::ice_server::RTCIceServer {
                urls: vec![url],
                username,
                credential,
            });
        }
        if servers.is_empty() {
            servers.push(webrtc::ice_transport::ice_server::RTCIceServer {
                urls: default_stun(),
                ..Default::default()
            });
        }
        servers
    }
}

/// Parse a TURN URL like "turn:username:password@host:port"
fn parse_turn_url(raw: &str) -> (String, String, String) {
    // Format: turn:user:pass@host:port or turns:user:pass@host:port
    if let Some(rest) = raw.strip_prefix("turn:") {
        if let Some((userpass, host)) = rest.rsplit_once('@') {
            if let Some((user, pass)) = userpass.rsplit_once(':') {
                return (format!("turn:{host}"), user.to_string(), pass.to_string());
            }
            return (format!("turn:{host}"), userpass.to_string(), String::new());
        }
        return (raw.to_string(), String::new(), String::new());
    }
    if let Some(rest) = raw.strip_prefix("turns:") {
        if let Some((userpass, host)) = rest.rsplit_once('@') {
            if let Some((user, pass)) = userpass.rsplit_once(':') {
                return (format!("turns:{host}"), user.to_string(), pass.to_string());
            }
            return (format!("turns:{host}"), userpass.to_string(), String::new());
        }
        return (raw.to_string(), String::new(), String::new());
    }
    (raw.to_string(), String::new(), String::new())
}

/// CLI overrides for quick config changes.
#[derive(Debug, Default, Clone)]
pub struct ConfigOverrides {
    pub username: Option<String>,
    pub room: Option<String>,
    pub password: Option<String>,
    pub signaling_url: Option<String>,
    pub player_path: Option<String>,
    pub file: Option<String>,
    pub sfu: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let cfg = P2pConfig::default();
        assert_eq!(cfg.sync.sync_interval_ms, 500);
        assert_eq!(cfg.sync.ping_interval_ms, 2000);
        assert!(!cfg.features.is_empty());
    }

    #[test]
    fn test_parse_turn_url() {
        let (url, user, pass) = parse_turn_url("turn:alice:secret@turn.example.com:3478");
        assert_eq!(url, "turn:turn.example.com:3478");
        assert_eq!(user, "alice");
        assert_eq!(pass, "secret");
    }

    #[test]
    fn test_ice_servers_with_turn() {
        let mut cfg = P2pConfig::default();
        cfg.network.turn_servers = vec!["turn:alice:secret@turn.example.com:3478".into()];
        let servers = cfg.ice_servers();
        assert_eq!(servers.len(), 2); // STUN + TURN
        assert!(servers[1].username == "alice");
    }

    #[test]
    fn test_apply_overrides() {
        let mut cfg = P2pConfig::default();
        let overrides = ConfigOverrides {
            room: Some("movie-night".into()),
            password: Some("letmein".into()),
            ..Default::default()
        };
        cfg.apply_overrides(&overrides);
        assert_eq!(cfg.room, "movie-night");
        assert_eq!(cfg.password, "letmein");
    }
    #[test]
    fn test_default_stun_not_empty() {
        let servers = default_stun();
        assert!(!servers.is_empty());
        assert!(servers[0].starts_with("stun:"));
    }

    #[test]
    fn test_config_json_roundtrip() {
        let cfg = P2pConfig::default();
        let json = serde_json::to_string_pretty(&cfg).unwrap();
        let parsed: P2pConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.sync.sync_interval_ms, cfg.sync.sync_interval_ms);
        assert_eq!(parsed.features, cfg.features);
    }

    #[test]
    fn test_config_save_load() {
        let cfg = P2pConfig::default();
        let tmp = std::env::temp_dir().join("syncplay-test-config.json");
        cfg.save(&tmp.to_string_lossy()).unwrap();
        let loaded = P2pConfig::load(&tmp.to_string_lossy()).unwrap();
        let _ = std::fs::remove_file(&tmp);
        assert_eq!(loaded.sync.ping_interval_ms, cfg.sync.ping_interval_ms);
    }

    #[test]
    fn test_ice_servers_empty_config() {
        let mut cfg = P2pConfig::default();
        cfg.network.stun_servers = vec![];
        cfg.network.turn_servers = vec![];
        let servers = cfg.ice_servers();
        assert_eq!(servers.len(), 1); // falls back to default STUN
    }

    #[test]
    fn test_parse_turn_url_no_auth() {
        let (url, user, pass) = parse_turn_url("turn:relay.example.com:3478");
        assert_eq!(url, "turn:relay.example.com:3478");
        assert!(user.is_empty());
        assert!(pass.is_empty());
    }

    #[test]
    fn test_parse_turn_url_turns() {
        let (url, user, pass) = parse_turn_url("turns:alice:secret@relay.example.com:5349");
        assert_eq!(url, "turns:relay.example.com:5349");
        assert_eq!(user, "alice");
        assert_eq!(pass, "secret");
    }

    #[test]
    fn test_config_apply_all_overrides() {
        let mut cfg = P2pConfig::default();
        let overrides = ConfigOverrides {
            username: Some("testuser".into()),
            room: Some("testroom".into()),
            password: Some("secret".into()),
            signaling_url: Some("ws://example.com:8998".into()),
            player_path: Some("/usr/bin/mpv".into()),
            file: Some("test.mkv".into()),
            sfu: None,
        };
        cfg.apply_overrides(&overrides);
        assert_eq!(cfg.username, "testuser");
        assert_eq!(cfg.room, "testroom");
        assert_eq!(cfg.password, "secret");
        assert_eq!(cfg.signaling_url, "ws://example.com:8998");
        assert_eq!(cfg.player.path, "/usr/bin/mpv");
        assert_eq!(cfg.player.file, Some("test.mkv".into()));
    }

    #[test]
    fn test_config_defaults_sensible() {
        let cfg = P2pConfig::default();
        assert!(!cfg.username.is_empty());
        assert_eq!(cfg.sync.sync_interval_ms, 500);
        assert_eq!(cfg.sync.ping_interval_ms, 2000);
        assert_eq!(cfg.sync.max_playlist_items, 250);
        assert_eq!(cfg.sync.max_chat_length, 2000);
        assert!(!cfg.sync.ready_at_start);
        assert_eq!(cfg.network.reconnect_delay_secs, 5);
        assert_eq!(cfg.network.max_reconnect_attempts, 5);
        assert!(!cfg.features.is_empty());
        assert!(cfg.features.contains(&"chat".to_string()));
    }
}
