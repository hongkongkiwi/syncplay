//! Message types and builders for the Syncplay P2P protocol.
//!
//! All P2P communication over WebRTC data channels uses these message types,
//! encoded as length-prefixed MessagePack frames.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// All message types that flow over WebRTC data channels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(u8)]
pub enum MessageType {
    Hello = 0x01,
    Playstate = 0x02,        // host → peers: authoritative position/paused
    PlaystateRequest = 0x03, // peer → host: "I want to seek/pause/play"
    Chat = 0x04,             // peer → host → all (relayed)
    Readiness = 0x05,        // peer → host → all: ready/not-ready
    PlaylistChange = 0x06,   // host → peers: playlist updated
    PlaylistRequest = 0x07,  // peer → host: request playlist change
    FileInfo = 0x08,         // broadcast current file metadata
    FileTransfer = 0x09,     // P2P direct file chunk
    FileRequest = 0x0A,      // request file from peer
    FileResponse = 0x0B,     // accept/reject file request
    LatencyPing = 0x0C,      // RTT measurement
    LatencyPong = 0x0D,      // RTT response
    HostElected = 0x0E,      // new host announcement
    UserInfo = 0x0F,         // username + features on connect
    PeerDisconnect = 0x10,   // graceful disconnect notification
    VoiceMute = 0x11,        // peer muted/unmuted voice
    SubtitleInfo = 0x12,     // available subtitle tracks for a file
    ControllerChange = 0x13, // host adds/removes playback controller
}

// ── Payload types ────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HelloPayload {
    pub username: String,
    pub version: String,
    pub features: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlaystatePayload {
    pub position: f64,
    pub paused: bool,
    #[serde(rename = "doSeek")]
    pub do_seek: bool,
    #[serde(rename = "setBy")]
    pub set_by: String,
    pub seq: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlaystateRequestPayload {
    pub action: PlaystateAction,
    pub position: f64,
    #[serde(rename = "requestId")]
    pub request_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlaystateAction {
    Seek,
    Pause,
    Play,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatPayload {
    pub from: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReadinessPayload {
    pub username: String,
    #[serde(rename = "isReady")]
    pub is_ready: bool,
    #[serde(rename = "manuallyInitiated")]
    pub manually_initiated: bool,
    #[serde(rename = "setBy")]
    pub set_by: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub duration: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlaylistChangePayload {
    pub files: Vec<FileEntry>,
    pub index: usize,
    #[serde(rename = "setBy")]
    pub set_by: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlaylistRequestPayload {
    pub action: PlaylistAction,
    pub files: Vec<FileEntry>,
    pub index: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaylistAction {
    SetPlaylist,
    SetIndex,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileInfoPayload {
    pub username: String,
    pub file: Option<FileMetadata>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileMetadata {
    pub name: String,
    pub duration: f64,
    pub size: u64,
    pub checksum: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileTransferPayload {
    #[serde(rename = "transferId")]
    pub transfer_id: String,
    #[serde(rename = "chunkIndex")]
    pub chunk_index: u64,
    pub offset: u64,
    #[serde(rename = "totalSize")]
    pub total_size: u64,
    #[serde(rename = "chunkSize")]
    pub chunk_size: u32,
    #[serde(with = "serde_bytes")]
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileRequestPayload {
    #[serde(rename = "transferId")]
    pub transfer_id: String,
    pub filename: String,
    pub offset: u64,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileResponsePayload {
    #[serde(rename = "transferId")]
    pub transfer_id: String,
    pub accepted: bool,
    pub reason: String,
    pub fingerprint: String,
    #[serde(rename = "chunkSize")]
    pub chunk_size: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LatencyPingPayload {
    #[serde(rename = "sendTime")]
    pub send_time: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LatencyPongPayload {
    #[serde(rename = "sendTime")]
    pub send_time: u64,
    #[serde(rename = "receiveTime")]
    pub receive_time: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HostElectedPayload {
    #[serde(rename = "hostId")]
    pub host_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UserInfoPayload {
    pub username: String,
    pub features: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PeerDisconnectPayload {
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VoiceMutePayload {
    pub muted: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubtitleInfoPayload {
    /// List of subtitle files available alongside the main file.
    pub subtitles: Vec<SubtitleTrack>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubtitleTrack {
    pub filename: String,
    pub size: u64,
    pub language: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ControllerChangePayload {
    pub peer_id: String,
    pub action: String, // "add" or "remove"
}

impl SubtitleInfoPayload {
    pub fn new(subtitles: Vec<SubtitleTrack>) -> Self {
        Self { subtitles }
    }
}

// ── Convenience builders ─────────────────────────────────────────────

impl HelloPayload {
    pub fn new(username: &str, version: &str, features: Vec<String>) -> Self {
        Self {
            username: username.into(),
            version: version.into(),
            features,
        }
    }
}

impl PlaystatePayload {
    pub fn new(position: f64, paused: bool, do_seek: bool, set_by: &str, seq: u64) -> Self {
        Self {
            position,
            paused,
            do_seek,
            set_by: set_by.into(),
            seq,
        }
    }
}

impl PlaystateRequestPayload {
    pub fn seek(position: f64) -> Self {
        Self {
            action: PlaystateAction::Seek,
            position,
            request_id: Uuid::new_v4().to_string(),
        }
    }
    pub fn pause() -> Self {
        Self {
            action: PlaystateAction::Pause,
            position: 0.0,
            request_id: Uuid::new_v4().to_string(),
        }
    }
    pub fn play() -> Self {
        Self {
            action: PlaystateAction::Play,
            position: 0.0,
            request_id: Uuid::new_v4().to_string(),
        }
    }
}

impl ChatPayload {
    pub fn new(from: &str, message: &str) -> Self {
        Self {
            from: from.into(),
            message: message.into(),
        }
    }
}

impl ReadinessPayload {
    pub fn new(username: &str, is_ready: bool, manually_initiated: bool, set_by: &str) -> Self {
        Self {
            username: username.into(),
            is_ready,
            manually_initiated,
            set_by: set_by.into(),
        }
    }
}

impl FileRequestPayload {
    pub fn new(filename: &str, offset: u64, fingerprint: &str) -> Self {
        Self {
            transfer_id: Uuid::new_v4().to_string(),
            filename: filename.into(),
            offset,
            fingerprint: fingerprint.into(),
        }
    }
}

impl FileResponsePayload {
    pub fn accept(transfer_id: &str, fingerprint: &str, chunk_size: u32) -> Self {
        Self {
            transfer_id: transfer_id.into(),
            accepted: true,
            reason: String::new(),
            fingerprint: fingerprint.into(),
            chunk_size,
        }
    }
    pub fn reject(transfer_id: &str, reason: &str) -> Self {
        Self {
            transfer_id: transfer_id.into(),
            accepted: false,
            reason: reason.into(),
            fingerprint: String::new(),
            chunk_size: 0,
        }
    }
}

impl LatencyPingPayload {
    pub fn now() -> Self {
        Self {
            send_time: crate::now_ms(),
        }
    }
}

impl LatencyPongPayload {
    pub fn reply(ping: &LatencyPingPayload) -> Self {
        Self {
            send_time: ping.send_time,
            receive_time: crate::now_ms(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_message_type_values() {
        // Verify enum values match wire protocol spec
        assert_eq!(MessageType::Hello as u8, 0x01);
        assert_eq!(MessageType::Playstate as u8, 0x02);
        assert_eq!(MessageType::PlaystateRequest as u8, 0x03);
        assert_eq!(MessageType::Chat as u8, 0x04);
        assert_eq!(MessageType::Readiness as u8, 0x05);
        assert_eq!(MessageType::PlaylistChange as u8, 0x06);
        assert_eq!(MessageType::PlaylistRequest as u8, 0x07);
        assert_eq!(MessageType::FileInfo as u8, 0x08);
        assert_eq!(MessageType::FileTransfer as u8, 0x09);
        assert_eq!(MessageType::FileRequest as u8, 0x0A);
        assert_eq!(MessageType::FileResponse as u8, 0x0B);
        assert_eq!(MessageType::LatencyPing as u8, 0x0C);
        assert_eq!(MessageType::LatencyPong as u8, 0x0D);
        assert_eq!(MessageType::HostElected as u8, 0x0E);
        assert_eq!(MessageType::UserInfo as u8, 0x0F);
        assert_eq!(MessageType::PeerDisconnect as u8, 0x10);
        assert_eq!(MessageType::VoiceMute as u8, 0x11);
        assert_eq!(MessageType::SubtitleInfo as u8, 0x12);
        assert_eq!(MessageType::ControllerChange as u8, 0x13);
    }

    #[test]
    fn test_hello_builder() {
        let p = HelloPayload::new("alice", "2.0.0", vec!["chat".into(), "playlist".into()]);
        assert_eq!(p.username, "alice");
        assert_eq!(p.version, "2.0.0");
        assert_eq!(p.features.len(), 2);
        assert!(p.features.contains(&"chat".to_string()));
    }

    #[test]
    fn test_playstate_builder() {
        let p = PlaystatePayload::new(123.45, false, true, "alice", 42);
        assert!((p.position - 123.45).abs() < 0.001);
        assert!(!p.paused);
        assert!(p.do_seek);
        assert_eq!(p.set_by, "alice");
        assert_eq!(p.seq, 42);
    }

    #[test]
    fn test_playstate_request_builders() {
        let seek = PlaystateRequestPayload::seek(300.0);
        assert!(matches!(seek.action, PlaystateAction::Seek));
        assert!((seek.position - 300.0).abs() < 0.001);
        assert!(!seek.request_id.is_empty());

        let pause = PlaystateRequestPayload::pause();
        assert!(matches!(pause.action, PlaystateAction::Pause));
        assert_eq!(pause.position, 0.0);

        let play = PlaystateRequestPayload::play();
        assert!(matches!(play.action, PlaystateAction::Play));
        assert_eq!(play.position, 0.0);

        // request_id should be unique
        assert_ne!(seek.request_id, pause.request_id);
        assert_ne!(pause.request_id, play.request_id);
    }

    #[test]
    fn test_chat_builder() {
        let p = ChatPayload::new("bob", "hello world!");
        assert_eq!(p.from, "bob");
        assert_eq!(p.message, "hello world!");

        // Empty message
        let empty = ChatPayload::new("carol", "");
        assert_eq!(empty.message, "");
    }

    #[test]
    fn test_readiness_builder() {
        let p = ReadinessPayload::new("alice", true, true, "host");
        assert_eq!(p.username, "alice");
        assert!(p.is_ready);
        assert!(p.manually_initiated);
        assert_eq!(p.set_by, "host");

        let not_ready = ReadinessPayload::new("bob", false, false, "bob");
        assert!(!not_ready.is_ready);
        assert!(!not_ready.manually_initiated);
    }

    #[test]
    fn test_file_request_builder() {
        let req = FileRequestPayload::new("movie.mkv", 0, "");
        assert_eq!(req.filename, "movie.mkv");
        assert_eq!(req.offset, 0);
        assert_eq!(req.fingerprint, "");
        assert!(!req.transfer_id.is_empty());

        let req2 = FileRequestPayload::new("movie.mkv", 1048576, "sha256:abc");
        assert_eq!(req2.offset, 1048576);
        assert_eq!(req2.fingerprint, "sha256:abc");
        assert_ne!(req.transfer_id, req2.transfer_id); // unique per call
    }

    #[test]
    fn test_file_response_builders() {
        let accept = FileResponsePayload::accept("tid-1", "sha256:abc", 262144);
        assert!(accept.accepted);
        assert_eq!(accept.transfer_id, "tid-1");
        assert_eq!(accept.chunk_size, 262144);
        assert!(accept.reason.is_empty());

        let reject = FileResponsePayload::reject("tid-2", "file not found");
        assert!(!reject.accepted);
        assert_eq!(reject.reason, "file not found");
        assert_eq!(reject.chunk_size, 0);
        assert!(reject.fingerprint.is_empty());
    }

    #[test]
    fn test_latency_ping_pong() {
        let ping = LatencyPingPayload::now();
        assert!(ping.send_time > 0);

        let pong = LatencyPongPayload::reply(&ping);
        assert_eq!(pong.send_time, ping.send_time);
        assert!(pong.receive_time >= ping.send_time);
    }

    #[test]
    fn test_all_payloads_clone_and_debug() {
        // Every payload type must be Clone + Debug + PartialEq
        let hello = HelloPayload::new("x", "1.0", vec![]);
        let _c = hello.clone();
        let _s = format!("{hello:?}");

        let ps = PlaystatePayload::new(0.0, true, false, "x", 1);
        let _c = ps.clone();
        let _s = format!("{ps:?}");

        let psr = PlaystateRequestPayload::seek(0.0);
        let _c = psr.clone();
        let _s = format!("{psr:?}");

        let chat = ChatPayload::new("x", "x");
        let _c = chat.clone();
        let _s = format!("{chat:?}");

        let ready = ReadinessPayload::new("x", true, false, "x");
        let _c = ready.clone();
        let _s = format!("{ready:?}");

        let pl = PlaylistChangePayload {
            files: vec![],
            index: 0,
            set_by: "x".into(),
        };
        let _c = pl.clone();
        let _s = format!("{pl:?}");

        let fi = FileInfoPayload {
            username: "x".into(),
            file: None,
        };
        let _c = fi.clone();
        let _s = format!("{fi:?}");

        let ft = FileTransferPayload {
            transfer_id: "x".into(),
            chunk_index: 0,
            offset: 0,
            total_size: 0,
            chunk_size: 0,
            data: vec![],
        };
        let _c = ft.clone();
        let _s = format!("{ft:?}");

        let latency = LatencyPingPayload { send_time: 0 };
        let _c = latency.clone();
        let _s = format!("{latency:?}");

        let host = HostElectedPayload {
            host_id: "x".into(),
            reason: "x".into(),
        };
        let _c = host.clone();
        let _s = format!("{host:?}");

        let ui = UserInfoPayload {
            username: "x".into(),
            features: vec![],
        };
        let _c = ui.clone();
        let _s = format!("{ui:?}");

        let pd = PeerDisconnectPayload { reason: "x".into() };
        let _c = pd.clone();
        let _s = format!("{pd:?}");
    }

    #[test]
    fn test_playstate_action_serialization() {
        // Verify serde rename serializes correctly
        let json = serde_json::to_string(&PlaystateAction::Seek).unwrap();
        assert_eq!(json, r#""seek""#);
        let json = serde_json::to_string(&PlaystateAction::Pause).unwrap();
        assert_eq!(json, r#""pause""#);
        let json = serde_json::to_string(&PlaystateAction::Play).unwrap();
        assert_eq!(json, r#""play""#);
    }

    #[test]
    fn test_file_entry() {
        let entry = FileEntry {
            name: "test.mkv".into(),
            duration: 3600.0,
        };
        assert_eq!(entry.name, "test.mkv");
        assert!((entry.duration - 3600.0).abs() < 0.001);
    }

    #[test]
    fn test_file_metadata() {
        let meta = FileMetadata {
            name: "movie.mkv".into(),
            duration: 7200.5,
            size: 2_147_483_648,
            checksum: Some("sha256:abc".into()),
        };
        assert_eq!(meta.name, "movie.mkv");
        assert_eq!(meta.size, 2_147_483_648);
        assert_eq!(meta.checksum.as_deref(), Some("sha256:abc"));

        let no_checksum = FileMetadata {
            name: "x".into(),
            duration: 0.0,
            size: 0,
            checksum: None,
        };
        assert!(no_checksum.checksum.is_none());
    }
}
