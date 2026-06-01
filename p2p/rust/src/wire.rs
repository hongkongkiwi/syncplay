//! Binary wire protocol: length-prefixed MessagePack frames.
//!
//! Frame format:
//!   [4 bytes: message type (u32 BE)] [4 bytes: payload length (u32 BE)] [N bytes: msgpack payload]
//!
//! All public functions return `Result` — no panics on malformed input.

use bytes::{BufMut, Bytes, BytesMut};
use log::warn;

use crate::error::WireError;
use crate::messages::*;

const HEADER_SIZE: usize = 8;
const MAX_PAYLOAD_SIZE: usize = 10 * 1024 * 1024; // 10 MB

/// Trait implemented by all message payload types.
pub trait MessagePayload: serde::Serialize {
    fn msg_type() -> MessageType;
}

// Implement for each payload type
macro_rules! impl_payload {
    ($ty:ty, $variant:ident) => {
        impl MessagePayload for $ty {
            fn msg_type() -> MessageType {
                MessageType::$variant
            }
        }
    };
}

impl_payload!(HelloPayload, Hello);
impl_payload!(PlaystatePayload, Playstate);
impl_payload!(PlaystateRequestPayload, PlaystateRequest);
impl_payload!(ChatPayload, Chat);
impl_payload!(ReadinessPayload, Readiness);
impl_payload!(PlaylistChangePayload, PlaylistChange);
impl_payload!(PlaylistRequestPayload, PlaylistRequest);
impl_payload!(FileInfoPayload, FileInfo);
impl_payload!(FileTransferPayload, FileTransfer);
impl_payload!(FileRequestPayload, FileRequest);
impl_payload!(FileResponsePayload, FileResponse);
impl_payload!(LatencyPingPayload, LatencyPing);
impl_payload!(LatencyPongPayload, LatencyPong);
impl_payload!(HostElectedPayload, HostElected);
impl_payload!(UserInfoPayload, UserInfo);
impl_payload!(PeerDisconnectPayload, PeerDisconnect);
impl_payload!(VoiceMutePayload, VoiceMute);
impl_payload!(SubtitleInfoPayload, SubtitleInfo);
impl_payload!(ControllerChangePayload, ControllerChange);

/// Encode any payload into a wire frame.
pub fn encode<T: MessagePayload>(payload: &T) -> Result<Bytes, WireError> {
    let body = rmp_serde::to_vec(payload)?;
    if body.len() > MAX_PAYLOAD_SIZE {
        return Err(WireError::OversizedPayload {
            size: body.len(),
            max: MAX_PAYLOAD_SIZE,
        });
    }
    let mut buf = BytesMut::with_capacity(HEADER_SIZE + body.len());
    buf.put_u32(T::msg_type() as u32);
    buf.put_u32(body.len() as u32);
    buf.put_slice(&body);
    Ok(buf.freeze())
}

/// Decode a wire frame header. Returns (MessageType, total_frame_length).
/// Returns `Err(WireError)` for incomplete buffers or unknown message types.
pub fn decode_header(buf: &[u8]) -> Result<(MessageType, usize), WireError> {
    if buf.len() < HEADER_SIZE {
        return Err(WireError::IncompleteHeader { have: buf.len() });
    }
    let msg_type = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]);
    let payload_len = u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]) as usize;
    if payload_len > MAX_PAYLOAD_SIZE {
        warn!("Rejecting oversized payload: {payload_len} bytes");
        return Err(WireError::OversizedPayload {
            size: payload_len,
            max: MAX_PAYLOAD_SIZE,
        });
    }
    let frame_len = HEADER_SIZE + payload_len;

    let msg_type = match msg_type {
        0x01 => MessageType::Hello,
        0x02 => MessageType::Playstate,
        0x03 => MessageType::PlaystateRequest,
        0x04 => MessageType::Chat,
        0x05 => MessageType::Readiness,
        0x06 => MessageType::PlaylistChange,
        0x07 => MessageType::PlaylistRequest,
        0x08 => MessageType::FileInfo,
        0x09 => MessageType::FileTransfer,
        0x0A => MessageType::FileRequest,
        0x0B => MessageType::FileResponse,
        0x0C => MessageType::LatencyPing,
        0x0D => MessageType::LatencyPong,
        0x0E => MessageType::HostElected,
        0x0F => MessageType::UserInfo,
        0x10 => MessageType::PeerDisconnect,
        0x11 => MessageType::VoiceMute,
        0x12 => MessageType::SubtitleInfo,
        0x13 => MessageType::ControllerChange,
        unknown => {
            warn!("Unknown message type: 0x{unknown:02x}");
            return Err(WireError::UnknownType { type_byte: unknown });
        }
    };

    if buf.len() < frame_len {
        return Err(WireError::Incomplete {
            need: frame_len,
            have: buf.len(),
        });
    }

    Ok((msg_type, frame_len))
}

/// Decode a payload from raw bytes.
pub fn decode_payload<T: serde::de::DeserializeOwned>(payload: &[u8]) -> Result<T, WireError> {
    Ok(rmp_serde::from_slice(payload)?)
}

/// Full decode: returns (bytes_consumed, MessageType, decoded_payload).
/// Validates that the decoded header type matches T's expected message type.
/// Use `decode_unchecked` to skip type validation (e.g., for dispatching).
pub fn decode<T: MessagePayload + serde::de::DeserializeOwned>(
    buf: &[u8],
) -> Result<(usize, MessageType, T), WireError> {
    let (msg_type, frame_len) = decode_header(buf)?;
    let expected = T::msg_type();
    if msg_type != expected {
        return Err(WireError::TypeMismatch {
            expected: expected as u32,
            actual: msg_type as u32,
        });
    }
    let payload_bytes = &buf[HEADER_SIZE..frame_len];
    let payload: T = rmp_serde::from_slice(payload_bytes)?;
    Ok((frame_len, msg_type, payload))
}

/// Full decode without type validation — for dispatch contexts where
/// the caller already matched on MessageType.
pub fn decode_unchecked<T: serde::de::DeserializeOwned>(
    buf: &[u8],
) -> Result<(usize, MessageType, T), WireError> {
    let (msg_type, frame_len) = decode_header(buf)?;
    let payload_bytes = &buf[HEADER_SIZE..frame_len];
    let payload: T = rmp_serde::from_slice(payload_bytes)?;
    Ok((frame_len, msg_type, payload))
}

/// Encode convenience functions — thin wrappers.
pub fn encode_hello(p: &HelloPayload) -> Result<Bytes, WireError> {
    encode(p)
}
pub fn encode_playstate(p: &PlaystatePayload) -> Result<Bytes, WireError> {
    encode(p)
}
pub fn encode_playstate_request(p: &PlaystateRequestPayload) -> Result<Bytes, WireError> {
    encode(p)
}
pub fn encode_chat(p: &ChatPayload) -> Result<Bytes, WireError> {
    encode(p)
}
pub fn encode_readiness(p: &ReadinessPayload) -> Result<Bytes, WireError> {
    encode(p)
}
pub fn encode_playlist_change(p: &PlaylistChangePayload) -> Result<Bytes, WireError> {
    encode(p)
}
pub fn encode_playlist_request(p: &PlaylistRequestPayload) -> Result<Bytes, WireError> {
    encode(p)
}
pub fn encode_file_info(p: &FileInfoPayload) -> Result<Bytes, WireError> {
    encode(p)
}
pub fn encode_file_transfer(p: &FileTransferPayload) -> Result<Bytes, WireError> {
    encode(p)
}
pub fn encode_file_request(p: &FileRequestPayload) -> Result<Bytes, WireError> {
    encode(p)
}
pub fn encode_file_response(p: &FileResponsePayload) -> Result<Bytes, WireError> {
    encode(p)
}
pub fn encode_latency_ping(p: &LatencyPingPayload) -> Result<Bytes, WireError> {
    encode(p)
}
pub fn encode_latency_pong(p: &LatencyPongPayload) -> Result<Bytes, WireError> {
    encode(p)
}
pub fn encode_host_elected(p: &HostElectedPayload) -> Result<Bytes, WireError> {
    encode(p)
}
pub fn encode_user_info(p: &UserInfoPayload) -> Result<Bytes, WireError> {
    encode(p)
}
pub fn encode_peer_disconnect(p: &PeerDisconnectPayload) -> Result<Bytes, WireError> {
    encode(p)
}
pub fn encode_voice_mute(p: &VoiceMutePayload) -> Result<Bytes, WireError> {
    encode(p)
}
pub fn encode_subtitle_info(p: &SubtitleInfoPayload) -> Result<Bytes, WireError> {
    encode(p)
}
pub fn encode_controller_change(p: &ControllerChangePayload) -> Result<Bytes, WireError> {
    encode(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip<T>(payload: &T, expected_type: MessageType) -> (usize, T)
    where
        T: MessagePayload + serde::de::DeserializeOwned + std::fmt::Debug + PartialEq,
    {
        let frame = encode(payload).expect("encode failed");
        let (decoded_type, frame_len) = decode_header(&frame).expect("decode_header failed");
        assert_eq!(decoded_type, expected_type, "wrong type decoded");
        assert_eq!(frame_len, frame.len(), "frame_len mismatch");

        let (consumed, mt, decoded): (usize, MessageType, T) =
            decode(&frame).expect("full decode failed");
        assert_eq!(mt, expected_type);
        assert_eq!(consumed, frame.len());
        assert_eq!(&decoded, payload, "roundtrip mismatch");
        (consumed, decoded)
    }

    #[test]
    fn test_hello() {
        let p = HelloPayload::new(
            "alice",
            "2.0.0",
            "",
            vec!["chat".into(), "readiness".into()],
        );
        roundtrip(&p, MessageType::Hello);
    }

    #[test]
    fn test_playstate() {
        roundtrip(
            &PlaystatePayload::new(123.45, false, true, "alice", 42),
            MessageType::Playstate,
        );
        roundtrip(
            &PlaystatePayload::new(0.0, true, false, "bob", 1),
            MessageType::Playstate,
        );
        roundtrip(
            &PlaystatePayload::new(-5.0, true, false, "carol", 999),
            MessageType::Playstate,
        );
    }

    #[test]
    fn test_playstate_request() {
        roundtrip(
            &PlaystateRequestPayload::seek(300.0),
            MessageType::PlaystateRequest,
        );
        roundtrip(
            &PlaystateRequestPayload::pause(),
            MessageType::PlaystateRequest,
        );
        roundtrip(
            &PlaystateRequestPayload::play(),
            MessageType::PlaystateRequest,
        );
    }

    #[test]
    fn test_chat() {
        roundtrip(&ChatPayload::new("bob", "hello world!"), MessageType::Chat);
        roundtrip(&ChatPayload::new("carol", ""), MessageType::Chat);
        roundtrip(&ChatPayload::new("dave", "你好世界 🎬"), MessageType::Chat);
    }

    #[test]
    fn test_readiness() {
        roundtrip(
            &ReadinessPayload::new("alice", true, true, "alice"),
            MessageType::Readiness,
        );
        roundtrip(
            &ReadinessPayload::new("bob", false, false, "host"),
            MessageType::Readiness,
        );
    }

    #[test]
    fn test_playlist_change() {
        let files = vec![
            FileEntry {
                name: "ep1.mkv".into(),
                duration: 3600.0,
            },
            FileEntry {
                name: "ep2.mkv".into(),
                duration: 3600.0,
            },
        ];
        roundtrip(
            &PlaylistChangePayload {
                files,
                index: 0,
                set_by: "alice".into(),
            },
            MessageType::PlaylistChange,
        );
        roundtrip(
            &PlaylistChangePayload {
                files: vec![],
                index: 0,
                set_by: "bob".into(),
            },
            MessageType::PlaylistChange,
        );
    }

    #[test]
    fn test_playlist_request() {
        let req_set = PlaylistRequestPayload {
            action: PlaylistAction::SetPlaylist,
            files: vec![],
            index: 0,
        };
        roundtrip(&req_set, MessageType::PlaylistRequest);
        let req_idx = PlaylistRequestPayload {
            action: PlaylistAction::SetIndex,
            files: vec![],
            index: 5,
        };
        roundtrip(&req_idx, MessageType::PlaylistRequest);
    }

    #[test]
    fn test_file_info() {
        let with_file = FileInfoPayload {
            username: "alice".into(),
            file: Some(FileMetadata {
                name: "movie.mkv".into(),
                duration: 7200.5,
                size: 2_147_483_648,
                checksum: Some("sha256:abc123".into()),
            }),
        };
        roundtrip(&with_file, MessageType::FileInfo);
        let no_file = FileInfoPayload {
            username: "bob".into(),
            file: None,
        };
        roundtrip(&no_file, MessageType::FileInfo);
    }

    #[test]
    fn test_file_transfer() {
        let chunk = FileTransferPayload {
            transfer_id: "tid-001".into(),
            chunk_index: 0,
            offset: 0,
            total_size: 1024,
            chunk_size: 512,
            data: vec![0, 1, 2, 3, 255],
        };
        roundtrip(&chunk, MessageType::FileTransfer);
        let empty = FileTransferPayload {
            transfer_id: "tid-002".into(),
            chunk_index: 0,
            offset: 0,
            total_size: 0,
            chunk_size: 0,
            data: vec![],
        };
        roundtrip(&empty, MessageType::FileTransfer);
    }

    #[test]
    fn test_file_request() {
        roundtrip(
            &FileRequestPayload::new("movie.mkv", 0, ""),
            MessageType::FileRequest,
        );
        roundtrip(
            &FileRequestPayload::new("movie.mkv", 1048576, "sha256:def456"),
            MessageType::FileRequest,
        );
    }

    #[test]
    fn test_file_response() {
        roundtrip(
            &FileResponsePayload::accept("tid-001", "sha256:abc", 262144),
            MessageType::FileResponse,
        );
        roundtrip(
            &FileResponsePayload::reject("tid-002", "file_not_found"),
            MessageType::FileResponse,
        );
    }

    #[test]
    fn test_latency() {
        let ping = LatencyPingPayload {
            send_time: 1717000000000,
        };
        roundtrip(&ping, MessageType::LatencyPing);
        let pong = LatencyPongPayload {
            send_time: 1717000000000,
            receive_time: 1717000000050,
        };
        roundtrip(&pong, MessageType::LatencyPong);
    }

    #[test]
    fn test_host_elected() {
        roundtrip(
            &HostElectedPayload {
                host_id: "peer-abc".into(),
                reason: "previous_host_left".into(),
            },
            MessageType::HostElected,
        );
    }

    #[test]
    fn test_user_info() {
        roundtrip(
            &UserInfoPayload {
                username: "alice".into(),
                features: vec!["chat".into(), "readiness".into()],
            },
            MessageType::UserInfo,
        );
    }

    #[test]
    fn test_peer_disconnect() {
        roundtrip(
            &PeerDisconnectPayload {
                reason: "left".into(),
            },
            MessageType::PeerDisconnect,
        );
    }

    #[test]
    fn test_voice_mute() {
        roundtrip(&VoiceMutePayload { muted: true }, MessageType::VoiceMute);
        roundtrip(&VoiceMutePayload { muted: false }, MessageType::VoiceMute);
    }

    #[test]
    fn test_subtitle_info() {
        roundtrip(
            &SubtitleInfoPayload {
                subtitles: vec![SubtitleTrack {
                    filename: "movie.eng.srt".into(),
                    size: 4096,
                    language: Some("eng".into()),
                }],
            },
            MessageType::SubtitleInfo,
        );
    }

    #[test]
    fn test_controller_change() {
        roundtrip(
            &ControllerChangePayload {
                peer_id: "peer-1".into(),
                action: ControllerAction::Add,
            },
            MessageType::ControllerChange,
        );
        roundtrip(
            &ControllerChangePayload {
                peer_id: "peer-2".into(),
                action: ControllerAction::Remove,
            },
            MessageType::ControllerChange,
        );
    }

    #[test]
    fn test_incomplete_buffer() {
        let p = HelloPayload::new("x", "1.0", "", vec![]);
        let frame = encode(&p).expect("encode");
        assert!(decode_header(&frame[..4]).is_err());
        assert!(decode_header(&frame[..7]).is_err());
    }

    #[test]
    fn test_unknown_type() {
        let buf = [0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00];
        assert!(decode_header(&buf).is_err());
    }

    #[test]
    fn test_incomplete_payload() {
        let p = HelloPayload::new("x", "1.0", "", vec![]);
        let frame = encode(&p).expect("encode");
        // Only header, no payload
        assert!(decode_header(&frame[..HEADER_SIZE]).is_err());
    }

    #[test]
    fn test_multiple_frames() {
        let h = encode_hello(&HelloPayload::new("a", "1.0", "", vec![])).expect("encode");
        let p =
            encode_playstate(&PlaystatePayload::new(1.0, false, false, "b", 1)).expect("encode");
        let mut combined = Vec::new();
        combined.extend_from_slice(&h);
        combined.extend_from_slice(&p);

        let (c1, mt1, _): (usize, MessageType, HelloPayload) =
            decode(&combined).expect("first frame");
        assert_eq!(mt1, MessageType::Hello);
        let (c2, mt2, _): (usize, MessageType, PlaystatePayload) =
            decode(&combined[c1..]).expect("second frame");
        assert_eq!(mt2, MessageType::Playstate);
        assert_eq!(c1 + c2, combined.len());
    }

    #[test]
    fn test_empty_buffer() {
        assert!(decode_header(&[]).is_err());
    }

    #[test]
    fn test_decode_nonexistent_variant() {
        // WireError::UnknownType — verify it's an error, not a panic
        let result: Result<(usize, MessageType, HelloPayload), WireError> = decode(&[0x00; 16]);
        assert!(result.is_err());
    }
}
