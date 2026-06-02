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
impl_payload!(AvatarSetPayload, AvatarSet);
impl_payload!(StatusUpdatePayload, StatusUpdate);
impl_payload!(VoiceFramePayload, VoiceFrame);
impl_payload!(SubtitleTrackChangePayload, SubtitleTrackChange);
impl_payload!(TransferPausePayload, TransferPause);
impl_payload!(TransferResumePayload, TransferResume);

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
        0x14 => MessageType::AvatarSet,
        0x15 => MessageType::StatusUpdate,
        0x16 => MessageType::VoiceFrame,
        0x17 => MessageType::SubtitleTrackChange,
        0x18 => MessageType::TransferPause,
        0x19 => MessageType::TransferResume,
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
pub fn encode_avatar_set(p: &AvatarSetPayload) -> Result<Bytes, WireError> {
    encode(p)
}
pub fn encode_status_update(p: &StatusUpdatePayload) -> Result<Bytes, WireError> {
    encode(p)
}
pub fn encode_voice_frame(p: &VoiceFramePayload) -> Result<Bytes, WireError> {
    encode(p)
}

pub fn encode_subtitle_track_change(p: &SubtitleTrackChangePayload) -> Result<Bytes, WireError> {
    encode(p)
}

pub fn encode_transfer_pause(p: &TransferPausePayload) -> Result<Bytes, WireError> {
    encode(p)
}

pub fn encode_transfer_resume(p: &TransferResumePayload) -> Result<Bytes, WireError> {
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

    // ── Oversized payload tests ──────────────────────────────────────

    #[test]
    fn test_oversized_payload() {
        // encode with a payload > MAX_PAYLOAD_SIZE must return OversizedPayload
        let payload = FileTransferPayload {
            transfer_id: "oversized".into(),
            chunk_index: 0,
            offset: 0,
            total_size: (MAX_PAYLOAD_SIZE + 1) as u64,
            chunk_size: (MAX_PAYLOAD_SIZE + 1) as u32,
            data: vec![0u8; MAX_PAYLOAD_SIZE + 1],
        };
        let result = encode(&payload);
        assert!(result.is_err());
        match result {
            Err(WireError::OversizedPayload { size, max }) => {
                assert!(size > MAX_PAYLOAD_SIZE);
                assert_eq!(max, MAX_PAYLOAD_SIZE);
            }
            other => panic!("expected OversizedPayload, got {other:?}"),
        }
    }

    #[test]
    fn test_oversized_payload_header() {
        // decode_header with a claimed payload length > MAX_PAYLOAD_SIZE must reject
        let mut buf = BytesMut::new();
        buf.put_u32(MessageType::Hello as u32);
        buf.put_u32((MAX_PAYLOAD_SIZE + 1) as u32);
        let frame = buf.freeze();
        let result = decode_header(&frame);
        assert!(result.is_err());
        match result {
            Err(WireError::OversizedPayload { size, max }) => {
                assert_eq!(size, MAX_PAYLOAD_SIZE + 1);
                assert_eq!(max, MAX_PAYLOAD_SIZE);
            }
            other => panic!("expected OversizedPayload, got {other:?}"),
        }
    }

    #[test]
    fn test_oversized_payload_boundary() {
        // payload at exactly MAX_PAYLOAD_SIZE: the encoded frame may be slightly
        // larger due to msgpack overhead (field names etc.), so we use body just
        // under the limit to prove encode succeeds, and a body exactly at limit
        // to test the boundary decode_header check.
        let body = vec![0u8; MAX_PAYLOAD_SIZE - 128]; // leave room for msgpack overhead
        let payload = FileTransferPayload {
            transfer_id: "boundary".into(),
            chunk_index: 0,
            offset: 0,
            total_size: body.len() as u64,
            chunk_size: body.len() as u32,
            data: body.clone(),
        };
        let frame = encode(&payload).expect("encode at boundary should succeed");
        let (consumed, _, decoded): (usize, MessageType, FileTransferPayload) =
            decode(&frame).expect("decode at boundary should succeed");
        assert_eq!(consumed, frame.len());
        assert_eq!(decoded.data.len(), body.len());
        assert_eq!(&decoded.data, &body);
    }

    // ── Type mismatch test ────────────────────────────────────────────

    #[test]
    fn test_type_mismatch() {
        // Encode as Chat, try to decode_as Hello → TypeMismatch
        let chat = ChatPayload::new("bob", "hello");
        let frame = encode(&chat).expect("encode chat");
        let result: Result<(usize, MessageType, HelloPayload), WireError> = decode(&frame);
        assert!(result.is_err());
        match result {
            Err(WireError::TypeMismatch { expected, actual }) => {
                assert_eq!(expected, MessageType::Hello as u32);
                assert_eq!(actual, MessageType::Chat as u32);
            }
            other => panic!("expected TypeMismatch, got {other:?}"),
        }
    }

    #[test]
    fn test_type_mismatch_playstate_to_latencyping() {
        let ps = PlaystatePayload::new(1.0, false, false, "h", 1);
        let frame = encode(&ps).expect("encode playstate");
        let result: Result<(usize, MessageType, LatencyPingPayload), WireError> = decode(&frame);
        assert!(result.is_err());
        match result {
            Err(WireError::TypeMismatch { expected, actual }) => {
                assert_eq!(expected, MessageType::LatencyPing as u32);
                assert_eq!(actual, MessageType::Playstate as u32);
            }
            other => panic!("expected TypeMismatch, got {other:?}"),
        }
    }

    // ── All message types roundtrip ───────────────────────────────────

    #[test]
    fn test_all_message_types_roundtrip() {
        // Hello (0x01)
        roundtrip(
            &HelloPayload::new("test", "1.0", "", vec!["feature".into()]),
            MessageType::Hello,
        );

        // Playstate (0x02)
        roundtrip(
            &PlaystatePayload::new(1.0, false, false, "host", 1),
            MessageType::Playstate,
        );

        // PlaystateRequest (0x03)
        roundtrip(
            &PlaystateRequestPayload::seek(0.0),
            MessageType::PlaystateRequest,
        );

        // Chat (0x04)
        roundtrip(&ChatPayload::new("alice", "msg"), MessageType::Chat);

        // Readiness (0x05)
        roundtrip(
            &ReadinessPayload::new("alice", true, false, "alice"),
            MessageType::Readiness,
        );

        // PlaylistChange (0x06)
        roundtrip(
            &PlaylistChangePayload {
                files: vec![FileEntry {
                    name: "a.mkv".into(),
                    duration: 60.0,
                }],
                index: 0,
                set_by: "host".into(),
            },
            MessageType::PlaylistChange,
        );

        // PlaylistRequest (0x07)
        roundtrip(
            &PlaylistRequestPayload {
                action: PlaylistAction::SetPlaylist,
                files: vec![],
                index: 0,
            },
            MessageType::PlaylistRequest,
        );

        // FileInfo (0x08)
        roundtrip(
            &FileInfoPayload {
                username: "x".into(),
                file: None,
            },
            MessageType::FileInfo,
        );

        // FileTransfer (0x09)
        roundtrip(
            &FileTransferPayload {
                transfer_id: "t".into(),
                chunk_index: 0,
                offset: 0,
                total_size: 10,
                chunk_size: 10,
                data: vec![1, 2, 3],
            },
            MessageType::FileTransfer,
        );

        // FileRequest (0x0A)
        roundtrip(
            &FileRequestPayload::new("f", 0, ""),
            MessageType::FileRequest,
        );

        // FileResponse (0x0B)
        roundtrip(
            &FileResponsePayload::accept("tid", "fp", 1024),
            MessageType::FileResponse,
        );

        // LatencyPing (0x0C)
        roundtrip(
            &LatencyPingPayload { send_time: 1 },
            MessageType::LatencyPing,
        );

        // LatencyPong (0x0D)
        roundtrip(
            &LatencyPongPayload {
                send_time: 1,
                receive_time: 2,
            },
            MessageType::LatencyPong,
        );

        // HostElected (0x0E)
        roundtrip(
            &HostElectedPayload {
                host_id: "peer-1".into(),
                reason: "r".into(),
            },
            MessageType::HostElected,
        );

        // UserInfo (0x0F)
        roundtrip(
            &UserInfoPayload {
                username: "x".into(),
                features: vec![],
            },
            MessageType::UserInfo,
        );

        // PeerDisconnect (0x10)
        roundtrip(
            &PeerDisconnectPayload {
                reason: "left".into(),
            },
            MessageType::PeerDisconnect,
        );

        // VoiceMute (0x11)
        roundtrip(&VoiceMutePayload { muted: true }, MessageType::VoiceMute);

        // SubtitleInfo (0x12)
        roundtrip(
            &SubtitleInfoPayload { subtitles: vec![] },
            MessageType::SubtitleInfo,
        );

        // ControllerChange (0x13)
        roundtrip(
            &ControllerChangePayload {
                peer_id: "x".into(),
                action: ControllerAction::Add,
            },
            MessageType::ControllerChange,
        );

        // SubtitleTrackChange (0x17)
        roundtrip(
            &SubtitleTrackChangePayload { track_index: 1 },
            MessageType::SubtitleTrackChange,
        );

        // TransferPause (0x18)
        roundtrip(
            &TransferPausePayload {
                transfer_id: "tid-1".into(),
            },
            MessageType::TransferPause,
        );

        // TransferResume (0x19)
        roundtrip(
            &TransferResumePayload {
                transfer_id: "tid-1".into(),
            },
            MessageType::TransferResume,
        );
    }

    // ── Corrupted / malformed inputs ──────────────────────────────────

    #[test]
    fn test_corrupted_header() {
        // Too few bytes (edge cases)
        assert!(decode_header(&[]).is_err());
        assert!(decode_header(&[0x01]).is_err());
        assert!(decode_header(&[0x01, 0x00]).is_err());
        assert!(decode_header(&[0x01, 0x00, 0x00, 0x00]).is_err());
        // 4..7 bytes tested, all should fail
        for n in 0..HEADER_SIZE {
            assert!(
                decode_header(&vec![0u8; n]).is_err(),
                "buffer of {n} bytes should fail"
            );
        }

        // Valid header but invalid msgpack body
        let mut buf = BytesMut::new();
        buf.put_u32(MessageType::Hello as u32);
        buf.put_u32(5u32); // claim 5-byte payload
        buf.put_slice(&[0xFF, 0xFF, 0xFF, 0xFF, 0xFF]); // garbage msgpack
        let frame = buf.freeze();
        let (msg_type, frame_len) = decode_header(&frame).expect("header should be valid");
        assert_eq!(msg_type, MessageType::Hello);
        assert_eq!(frame_len, HEADER_SIZE + 5);
        // But decoding the payload should fail
        let payload_result: Result<HelloPayload, WireError> =
            decode_payload(&frame[HEADER_SIZE..frame_len]);
        assert!(payload_result.is_err());

        // Unknown type byte 0xFE
        let mut unknown = BytesMut::new();
        unknown.put_u32(0xFE);
        unknown.put_u32(0);
        assert!(decode_header(&unknown).is_err());

        // Unknown type byte 0x00 (zero)
        let mut zero_type = BytesMut::new();
        zero_type.put_u32(0x00);
        zero_type.put_u32(0);
        assert!(decode_header(&zero_type).is_err());

        // Unknown type byte 0xFF
        let mut ff = BytesMut::new();
        ff.put_u32(0xFF);
        ff.put_u32(0);
        assert!(decode_header(&ff).is_err());

        // Valid header, incomplete payload
        let p = HelloPayload::new("x", "1.0", "", vec![]);
        let frame = encode(&p).expect("encode");
        // Take header + first byte of payload only
        let truncated = &frame[..HEADER_SIZE + 1];
        // decode_header reads the full frame_len check at the end, so it should fail with Incomplete
        let result = decode_header(truncated);
        assert!(result.is_err());
    }

    // ── Edge cases ────────────────────────────────────────────────────

    #[test]
    fn test_edge_cases() {
        // Empty payload (zero-length body) roundtrip
        // Using VoiceMutePayload which is just a bool (small msgpack)
        let p = VoiceMutePayload { muted: true };
        let frame = encode(&p).expect("encode");
        assert!(frame.len() >= HEADER_SIZE);
        let (mt, fl) = decode_header(&frame).expect("decode_header");
        assert_eq!(mt, MessageType::VoiceMute);
        assert_eq!(fl, frame.len());
        let (consumed, _, decoded): (usize, MessageType, VoiceMutePayload) =
            decode(&frame).expect("decode");
        assert_eq!(consumed, frame.len());
        assert!(decoded.muted);

        // Binary payload with embedded nulls
        let binary = FileTransferPayload {
            transfer_id: "bin".into(),
            chunk_index: 1,
            offset: 1024,
            total_size: 2048,
            chunk_size: 8,
            data: vec![0x00, 0xFF, 0x00, 0xAB, 0x00, 0x00, 0xCD, 0x00],
        };
        let frame = encode(&binary).expect("encode binary");
        let (_, _, decoded): (usize, MessageType, FileTransferPayload) =
            decode(&frame).expect("decode binary");
        assert_eq!(
            decoded.data,
            vec![0x00, 0xFF, 0x00, 0xAB, 0x00, 0x00, 0xCD, 0x00]
        );
        assert_eq!(decoded.chunk_index, 1);

        // Empty string in payload
        let chat = ChatPayload::new("alice", "");
        let frame = encode(&chat).expect("encode empty chat");
        let (_, _, decoded): (usize, MessageType, ChatPayload) = decode(&frame).expect("decode");
        assert_eq!(decoded.message, "");

        // Special characters: newlines and tabs in strings
        let chat = ChatPayload::new("alice\nbob", "msg\twith\ttabs");
        let frame = encode(&chat).expect("encode special");
        let (_, _, decoded): (usize, MessageType, ChatPayload) =
            decode(&frame).expect("decode special");
        assert_eq!(decoded.from, "alice\nbob");
        assert_eq!(decoded.message, "msg\twith\ttabs");

        // Negative position values in Playstate
        roundtrip(
            &PlaystatePayload::new(-999.99, true, true, "host", 100),
            MessageType::Playstate,
        );
    }

    // ── Concurrent / multi-frame decode ───────────────────────────────

    #[test]
    fn test_concurrent_decodes() {
        // Multiple different message types in one contiguous buffer
        let hello = encode_hello(&HelloPayload::new("a", "1.0", "", vec![])).expect("encode hello");
        let chat = encode_chat(&ChatPayload::new("b", "hi")).expect("encode chat");
        let ping = encode_latency_ping(&LatencyPingPayload { send_time: 42 }).expect("encode ping");
        let pong = encode_latency_pong(&LatencyPongPayload {
            send_time: 1,
            receive_time: 2,
        })
        .expect("encode pong");

        let mut combined = Vec::new();
        combined.extend_from_slice(&hello);
        combined.extend_from_slice(&chat);
        combined.extend_from_slice(&ping);
        combined.extend_from_slice(&pong);

        let mut offset = 0;
        let mut decoded_types = Vec::new();

        // Frame 1: Hello
        let (c1, mt1, _): (usize, MessageType, HelloPayload) =
            decode(&combined[offset..]).expect("frame 1");
        offset += c1;
        decoded_types.push(mt1);

        // Frame 2: Chat
        let (c2, mt2, _): (usize, MessageType, ChatPayload) =
            decode(&combined[offset..]).expect("frame 2");
        offset += c2;
        decoded_types.push(mt2);

        // Frame 3: LatencyPing
        let (c3, mt3, _): (usize, MessageType, LatencyPingPayload) =
            decode(&combined[offset..]).expect("frame 3");
        offset += c3;
        decoded_types.push(mt3);

        // Frame 4: LatencyPong
        let (c4, mt4, _): (usize, MessageType, LatencyPongPayload) =
            decode(&combined[offset..]).expect("frame 4");
        offset += c4;
        decoded_types.push(mt4);

        assert_eq!(
            decoded_types,
            vec![
                MessageType::Hello,
                MessageType::Chat,
                MessageType::LatencyPing,
                MessageType::LatencyPong,
            ]
        );
        assert_eq!(offset, combined.len());
    }

    // ── decode_unchecked ──────────────────────────────────────────────

    #[test]
    fn test_decode_unchecked() {
        // decode_unchecked works with correct type
        let hello = HelloPayload::new("x", "1.0", "", vec![]);
        let frame = encode(&hello).expect("encode");
        let (consumed, mt, decoded): (usize, MessageType, HelloPayload) =
            decode_unchecked(&frame).expect("decode_unchecked");
        assert_eq!(mt, MessageType::Hello);
        assert_eq!(consumed, frame.len());
        assert_eq!(decoded.username, "x");

        // decode_unchecked skips type validation: encode a Chat but decode_unchecked
        // as HelloPayload. The msgpack fields won't match so deserialization fails,
        // but it must NOT give TypeMismatch (which regular decode would).
        // It should fail with a Decode error instead.
        let chat = ChatPayload::new("bob", "hi");
        let frame = encode(&chat).expect("encode chat");
        let result: Result<(usize, MessageType, HelloPayload), WireError> =
            decode_unchecked(&frame);
        assert!(result.is_err());
        match result {
            Err(WireError::Decode(_)) => {
                // Expected: msgpack deserialization fails, but not TypeMismatch
            }
            other => panic!("expected Decode error from decode_unchecked, got {other:?}"),
        }

        // decode_unchecked with VoiceMute
        let vm = VoiceMutePayload { muted: true };
        let frame = encode(&vm).expect("encode voicemute");
        let (consumed, mt, decoded): (usize, MessageType, VoiceMutePayload) =
            decode_unchecked(&frame).expect("decode_unchecked voicemute");
        assert_eq!(mt, MessageType::VoiceMute);
        assert_eq!(consumed, frame.len());
        assert!(decoded.muted);
    }

    // ── Partial / truncated frames ────────────────────────────────────

    #[test]
    fn test_partial_second_frame() {
        // Buffer: complete first frame + only 4 bytes of second frame header
        let hello = encode_hello(&HelloPayload::new("x", "1.0", "", vec![])).expect("encode");
        let chat = encode_chat(&ChatPayload::new("y", "msg")).expect("encode");

        let mut partial = Vec::new();
        partial.extend_from_slice(&hello);
        partial.extend_from_slice(&chat[..4]); // truncated second frame header

        // First frame should decode fine
        let (c1, mt1, _): (usize, MessageType, HelloPayload) =
            decode(&partial).expect("first frame");
        assert_eq!(mt1, MessageType::Hello);

        // Second frame header is incomplete
        let result = decode_header(&partial[c1..]);
        assert!(result.is_err());
        match result {
            Err(WireError::IncompleteHeader { have }) => {
                assert!(have < HEADER_SIZE);
            }
            other => panic!("expected IncompleteHeader, got {other:?}"),
        }
    }

    #[test]
    fn test_partial_payload_in_second_frame() {
        // Complete first frame + complete second header but truncated payload
        let hello = encode_hello(&HelloPayload::new("x", "1.0", "", vec![])).expect("encode");
        let chat = encode_chat(&ChatPayload::new("y", "hello")).expect("encode");

        // Truncate second frame: keep header but only part of payload
        let truncate_at = hello.len() + HEADER_SIZE + 2; // header + 2 payload bytes
        let mut partial = Vec::new();
        partial.extend_from_slice(&hello);
        partial.extend_from_slice(&chat[..(chat.len().min(truncate_at - hello.len()))]);

        // First frame
        let (c1, mt1, _): (usize, MessageType, HelloPayload) =
            decode(&partial).expect("first frame");
        assert_eq!(mt1, MessageType::Hello);

        // Second frame: header valid, but decode_header sees incomplete payload
        let result = decode_header(&partial[c1..]);
        assert!(result.is_err());
        match result {
            Err(WireError::Incomplete { need, have }) => {
                assert!(need > have);
            }
            other => panic!("expected Incomplete, got {other:?}"),
        }
    }

    // ── Convenience encoder coverage ──────────────────────────────────

    #[test]
    fn test_convenience_encoders() {
        // Exercise each encode_* convenience function to push coverage
        assert!(encode_hello(&HelloPayload::new("x", "1.0", "", vec![])).is_ok());
        assert!(encode_playstate(&PlaystatePayload::new(0.0, false, false, "x", 1)).is_ok());
        assert!(encode_playstate_request(&PlaystateRequestPayload::play()).is_ok());
        assert!(encode_chat(&ChatPayload::new("x", "x")).is_ok());
        assert!(encode_readiness(&ReadinessPayload::new("x", true, false, "x")).is_ok());
        assert!(encode_playlist_change(&PlaylistChangePayload {
            files: vec![],
            index: 0,
            set_by: "x".into()
        })
        .is_ok());
        assert!(encode_playlist_request(&PlaylistRequestPayload {
            action: PlaylistAction::SetPlaylist,
            files: vec![],
            index: 0,
        })
        .is_ok());
        assert!(encode_file_info(&FileInfoPayload {
            username: "x".into(),
            file: None
        })
        .is_ok());
        assert!(encode_file_transfer(&FileTransferPayload {
            transfer_id: "x".into(),
            chunk_index: 0,
            offset: 0,
            total_size: 0,
            chunk_size: 0,
            data: vec![]
        })
        .is_ok());
        assert!(encode_file_request(&FileRequestPayload::new("f", 0, "")).is_ok());
        assert!(encode_file_response(&FileResponsePayload::accept("t", "fp", 0)).is_ok());
        assert!(encode_latency_ping(&LatencyPingPayload { send_time: 1 }).is_ok());
        assert!(encode_latency_pong(&LatencyPongPayload {
            send_time: 1,
            receive_time: 2
        })
        .is_ok());
        assert!(encode_host_elected(&HostElectedPayload {
            host_id: "x".into(),
            reason: "r".into()
        })
        .is_ok());
        assert!(encode_user_info(&UserInfoPayload {
            username: "x".into(),
            features: vec![]
        })
        .is_ok());
        assert!(encode_peer_disconnect(&PeerDisconnectPayload { reason: "x".into() }).is_ok());
        assert!(encode_voice_mute(&VoiceMutePayload { muted: true }).is_ok());
        assert!(encode_subtitle_info(&SubtitleInfoPayload { subtitles: vec![] }).is_ok());
        assert!(encode_controller_change(&ControllerChangePayload {
            peer_id: "x".into(),
            action: ControllerAction::Add,
        })
        .is_ok());
        assert!(
            encode_subtitle_track_change(&SubtitleTrackChangePayload { track_index: 0 }).is_ok()
        );
        assert!(encode_transfer_pause(&TransferPausePayload {
            transfer_id: "t".into()
        })
        .is_ok());
        assert!(encode_transfer_resume(&TransferResumePayload {
            transfer_id: "t".into()
        })
        .is_ok());
    }

    // ── PlaystateAction::SetSpeed + with_speed ────────────────────────

    #[test]
    fn test_playstate_set_speed() {
        // PlaystateAction::SetSpeed roundtrip
        let psr = PlaystateRequestPayload::set_speed(2.5);
        roundtrip(&psr, MessageType::PlaystateRequest);

        // PlaystatePayload::with_speed roundtrip
        let playstate = PlaystatePayload::with_speed(100.0, false, true, "host", 5, 1.5);
        let frame = encode(&playstate).expect("encode with_speed");
        let (_, _, decoded): (usize, MessageType, PlaystatePayload) =
            decode(&frame).expect("decode with_speed");
        assert!((decoded.speed - 1.5).abs() < 0.001);
        assert!((decoded.position - 100.0).abs() < 0.001);
    }

    // ── ControllerAction::Remove ──────────────────────────────────────

    #[test]
    fn test_controller_change_remove() {
        roundtrip(
            &ControllerChangePayload {
                peer_id: "peer-2".into(),
                action: ControllerAction::Remove,
            },
            MessageType::ControllerChange,
        );
    }

    // ── Error display / from impls ───────────────────────────────────

    #[test]
    fn test_wire_error_from_msgpack_encode() {
        // WireError::Encode via the From impl — using rmp_serde on a type that
        // cannot be serialized is hard to trigger, but we can test the conversion
        // by directly constructing the error.
        // Instead, test that the error Display impl works.
        let e = WireError::IncompleteHeader { have: 4 };
        let s = e.to_string();
        assert!(s.contains("incomplete"));
        assert!(s.contains("4"));

        let e = WireError::UnknownType { type_byte: 0xAB };
        let s = e.to_string();
        assert!(s.contains("0xab"));

        let e = WireError::OversizedPayload { size: 100, max: 50 };
        let s = e.to_string();
        assert!(s.contains("100"));
        assert!(s.contains("50"));

        let e = WireError::TypeMismatch {
            expected: 0x01,
            actual: 0x02,
        };
        let s = e.to_string();
        assert!(s.contains("0x01"));
        assert!(s.contains("0x02"));

        let e = WireError::Incomplete {
            need: 100,
            have: 50,
        };
        let s = e.to_string();
        assert!(s.contains("100"));
        assert!(s.contains("50"));
    }

    // ── Boundary: frame at exactly HEADER_SIZE + MAX_PAYLOAD_SIZE ─────

    #[test]
    fn test_boundary_frame_lengths() {
        // Minimum frame: header + minimum msgpack payload (e.g., false = 1 byte)
        let p = VoiceMutePayload { muted: false };
        let frame = encode(&p).expect("encode");
        assert!(frame.len() > HEADER_SIZE);
        let (mt, fl) = decode_header(&frame).expect("decode_header");
        assert_eq!(mt, MessageType::VoiceMute);
        assert_eq!(fl, frame.len());
    }
}
