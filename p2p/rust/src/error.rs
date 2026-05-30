//! Error types for syncplay-p2p.
use thiserror::Error;

#[derive(Error, Debug)]
pub enum WireError {
    #[error("incomplete frame: have {have} bytes, need at least 8 for header")]
    IncompleteHeader { have: usize },

    #[error("incomplete frame: need {need} bytes, only have {have}")]
    Incomplete { need: usize, have: usize },

    #[error("unknown message type: 0x{type_byte:02x}")]
    UnknownType { type_byte: u32 },

    #[error("msgpack encode error: {0}")]
    Encode(#[from] rmp_serde::encode::Error),

    #[error("msgpack decode error: {0}")]
    Decode(#[from] rmp_serde::decode::Error),
}

#[derive(Error, Debug)]
pub enum ConnectionError {
    #[error("peer {peer_id} not found")]
    PeerNotFound { peer_id: String },

    #[error("not connected to any room")]
    NotConnected,

    #[error("WebSocket error: {0}")]
    WebSocket(#[from] tokio_tungstenite::tungstenite::Error),

    #[error("WebRTC error: {0}")]
    WebRtc(#[from] webrtc::error::Error),

    #[error("wire protocol error: {0}")]
    Wire(#[from] WireError),

    #[error("signaling error: {code} — {message}")]
    Signaling { code: String, message: String },

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Error, Debug)]
pub enum SyncError {
    #[error("send failed to {peer_id}: {reason}")]
    SendFailed { peer_id: String, reason: String },

    #[error("broadcast failed: {reason}")]
    BroadcastFailed { reason: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_wire_error_display() {
        let e = WireError::IncompleteHeader { have: 3 };
        assert!(e.to_string().contains("incomplete"));
        assert!(e.to_string().contains("3"));

        let e = WireError::UnknownType { type_byte: 0xFF };
        assert!(e.to_string().contains("0xff"));

        let e = WireError::Incomplete { need: 100, have: 50 };
        assert!(e.to_string().contains("100"));
        assert!(e.to_string().contains("50"));
    }

    #[test]
    fn test_connection_error_display() {
        let e = ConnectionError::PeerNotFound { peer_id: "abc".into() };
        assert!(e.to_string().contains("abc"));

        let e = ConnectionError::Signaling { code: "ERR".into(), message: "bad".into() };
        assert!(e.to_string().contains("ERR"));
        assert!(e.to_string().contains("bad"));
    }

    #[test]
    fn test_sync_error_display() {
        let e = SyncError::SendFailed { peer_id: "xyz".into(), reason: "timeout".into() };
        assert!(e.to_string().contains("xyz"));
        assert!(e.to_string().contains("timeout"));

        let e = SyncError::BroadcastFailed { reason: "no peers".into() };
        assert!(e.to_string().contains("no peers"));
    }

    #[test]
    fn test_wire_error_from_msgpack() {
        // Verify WireError can be created from msgpack errors
        let bytes = vec![0xFF, 0xFF, 0xFF]; // definitely not valid msgpack
        let result = rmp_serde::from_slice::<u32>(&bytes);
        if let Err(e) = result {
            let wire_err = WireError::Decode(e);
            assert!(wire_err.to_string().contains("msgpack"));
        }
    }
}
