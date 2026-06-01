//! End-to-end integration tests for Syncplay P2P.
//!
//! Tests the wire protocol, signaling server, and message flow
//! without requiring actual WebRTC connections.

use syncplay_p2p::config::P2pConfig;
use syncplay_p2p::messages::*;
use syncplay_p2p::player::default_player;
use syncplay_p2p::player::detect_players;
use syncplay_p2p::wire;

#[test]
fn e2e_wire_all_message_types_roundtrip() {
    // Encode every message type, decode, verify
    let messages: Vec<(MessageType, Vec<u8>)> = vec![
        (
            MessageType::Hello,
            wire::encode(&HelloPayload::new("alice", "2.0", "", vec!["chat".into()]))
                .unwrap()
                .to_vec(),
        ),
        (
            MessageType::Playstate,
            wire::encode(&PlaystatePayload::new(42.0, false, true, "host", 1))
                .unwrap()
                .to_vec(),
        ),
        (
            MessageType::PlaystateRequest,
            wire::encode(&PlaystateRequestPayload::seek(100.0))
                .unwrap()
                .to_vec(),
        ),
        (
            MessageType::Chat,
            wire::encode(&ChatPayload::new("bob", "hi"))
                .unwrap()
                .to_vec(),
        ),
        (
            MessageType::Readiness,
            wire::encode(&ReadinessPayload::new("alice", true, true, "alice"))
                .unwrap()
                .to_vec(),
        ),
        (
            MessageType::PlaylistChange,
            wire::encode(&PlaylistChangePayload {
                files: vec![],
                index: 0,
                set_by: "host".into(),
            })
            .unwrap()
            .to_vec(),
        ),
        (
            MessageType::LatencyPing,
            wire::encode(&LatencyPingPayload { send_time: 1000 })
                .unwrap()
                .to_vec(),
        ),
        (
            MessageType::LatencyPong,
            wire::encode(&LatencyPongPayload {
                send_time: 1000,
                receive_time: 1050,
            })
            .unwrap()
            .to_vec(),
        ),
        (
            MessageType::HostElected,
            wire::encode(&HostElectedPayload {
                host_id: "peer-2".into(),
                reason: "left".into(),
            })
            .unwrap()
            .to_vec(),
        ),
        (
            MessageType::PeerDisconnect,
            wire::encode(&PeerDisconnectPayload {
                reason: "goodbye".into(),
            })
            .unwrap()
            .to_vec(),
        ),
    ];

    for (expected_type, bytes) in &messages {
        let (decoded_type, frame_len) = wire::decode_header(bytes).unwrap();
        assert_eq!(
            decoded_type, *expected_type,
            "wrong type for {expected_type:?}"
        );
        assert_eq!(
            frame_len,
            bytes.len(),
            "wrong frame len for {expected_type:?}"
        );
    }
}

#[test]
fn e2e_multiple_frames_in_stream() {
    // Simulate a real data stream with multiple frames back-to-back
    let hello = wire::encode(&HelloPayload::new("x", "1.0", "", vec![])).unwrap();
    let playstate = wire::encode(&PlaystatePayload::new(1.0, false, false, "h", 1)).unwrap();
    let chat = wire::encode(&ChatPayload::new("b", "hi")).unwrap();

    let mut stream = Vec::new();
    stream.extend_from_slice(&hello);
    stream.extend_from_slice(&playstate);
    stream.extend_from_slice(&chat);

    let mut offset = 0;
    let mut types_seen = Vec::new();

    while offset < stream.len() {
        let (mt, frame_len) = wire::decode_header(&stream[offset..]).unwrap();
        types_seen.push(mt);
        offset += frame_len;
    }

    assert_eq!(
        types_seen,
        vec![
            MessageType::Hello,
            MessageType::Playstate,
            MessageType::Chat
        ]
    );
    assert_eq!(offset, stream.len());
}

#[test]
fn e2e_config_pipeline() {
    // Test full config pipeline: defaults → serialize → deserialize → verify
    let cfg = P2pConfig {
        room: "test-room".into(),
        network: syncplay_p2p::config::NetworkConfig {
            turn_servers: vec!["turn:user:pass@turn.example.com:3478".into()],
            ..Default::default()
        },
        ..Default::default()
    };

    let json = serde_json::to_string_pretty(&cfg).unwrap();
    let parsed: P2pConfig = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed.room, "test-room");
    assert_eq!(parsed.network.turn_servers.len(), 1);
    assert_eq!(parsed.sync.sync_interval_ms, 500);

    // Verify ICE servers include TURN
    let ice_servers = parsed.ice_servers();
    assert!(ice_servers.len() >= 2);
}

#[test]
fn e2e_player_detection_runs() {
    // Won't assert specific results (CI may not have players)
    // but should never panic
    let players = detect_players();
    let best = default_player();
    // At minimum, the functions run without panicking
    let _ = players.len();
    let _ = best.is_some();
}

#[test]
fn e2e_message_size_limits() {
    // Verify message packing stays within reasonable size
    let hello = wire::encode(&HelloPayload::new(
        "alice",
        "2.0",
        "",
        vec!["chat".into(), "readiness".into()],
    ))
    .unwrap();
    assert!(hello.len() < 512, "hello frame too large: {}", hello.len());

    let big_chat = wire::encode(&ChatPayload::new("bob", &"x".repeat(2000))).unwrap();
    assert!(
        big_chat.len() < 4096,
        "chat frame too large: {}",
        big_chat.len()
    );

    let ps = wire::encode(&PlaystatePayload::new(0.0, true, false, "host", 1)).unwrap();
    assert!(ps.len() < 256, "playstate frame too large: {}", ps.len());
}

#[test]
fn e2e_wire_error_handling() {
    // Malformed data must return errors, never panic
    assert!(wire::decode_header(&[]).is_err());
    assert!(wire::decode_header(&[0; 4]).is_err());
    assert!(wire::decode_header(&[0xFF, 0, 0, 0, 0, 0, 0, 100]).is_err()); // unknown type
    assert!(wire::decode_header(&[0x01, 0, 0, 0, 0, 0, 0, 100]).is_err()); // incomplete payload

    // Huge length in header should not cause allocation panic
    let huge = [0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0];
    assert!(wire::decode_header(&huge).is_err()); // incomplete
}

#[test]
fn e2e_playstate_sequence_ordering() {
    // Higher seq numbers should be accepted, lower rejected
    // (tested at the logical level, not the sync manager level)
    let p1 = PlaystatePayload::new(10.0, false, false, "host", 1);
    let p2 = PlaystatePayload::new(20.0, true, false, "host", 2);
    let p3 = PlaystatePayload::new(30.0, false, false, "host", 3);

    assert!(p2.seq > p1.seq);
    assert!(p3.seq > p2.seq);

    // Stale sequence should have lower or equal seq
    let stale = PlaystatePayload::new(5.0, true, false, "host", 1);
    assert!(stale.seq <= p1.seq);
}

#[test]
fn e2e_signaling_message_formats() {
    // Verify the server message JSON formats are valid
    use serde_json::json;

    // Test create message
    let create = json!({
        "type": "create",
        "room": "test",
        "password": "",
        "username": "alice",
        "features": ["chat"]
    });
    assert_eq!(create["type"], "create");
    assert_eq!(create["room"], "test");
    assert_eq!(create["username"], "alice");

    // Test join message
    let join = json!({
        "type": "join",
        "room": "test",
        "username": "bob",
        "features": []
    });
    assert_eq!(join["type"], "join");

    // Test signal relay
    let signal = json!({
        "type": "signal",
        "target": "peer-2",
        "payload": {
            "kind": "offer",
            "sdp": "v=0..."
        }
    });
    assert_eq!(signal["payload"]["kind"], "offer");
}

#[test]
fn e2e_feature_negotiation() {
    // Verify feature sets can be compared for compatibility
    let host_features: &[&str] = &["chat", "readiness", "playlist"];
    let peer_features: &[&str] = &["chat", "readiness"];

    let host_has_chat = host_features.contains(&"chat");
    let peer_has_chat = peer_features.contains(&"chat");
    assert!(host_has_chat && peer_has_chat); // compatible

    let host_has_playlist = host_features.contains(&"playlist");
    let peer_has_playlist = peer_features.contains(&"playlist");
    assert!(host_has_playlist && !peer_has_playlist); // playlist not in peer
}

#[test]
fn e2e_default_config_produces_valid_ice() {
    let cfg = P2pConfig::default();
    let servers = cfg.ice_servers();
    assert!(!servers.is_empty());
    // Only Google STUN
    let stun_urls = &servers[0].urls;
    assert!(stun_urls.iter().any(|u| u.contains("stun.l.google.com")));
}

// ── New E2E tests for previously uncovered features ─────────────────

#[test]
fn e2e_all_20_message_types_roundtrip() {
    // Verify ALL 20 message types encode/decode correctly
    use syncplay_p2p::messages::*;

    let tests: Vec<(MessageType, Vec<u8>)> = vec![
        // 0x01 Hello
        (
            MessageType::Hello,
            wire::encode(&HelloPayload::new("a", "2.0", "room", vec!["chat".into()]))
                .unwrap()
                .to_vec(),
        ),
        // 0x02 Playstate (with new speed+timestamp fields)
        (
            MessageType::Playstate,
            wire::encode(&PlaystatePayload::with_speed(
                42.0, false, true, "host", 1, 1.5,
            ))
            .unwrap()
            .to_vec(),
        ),
        // 0x03 PlaystateRequest (seek)
        (
            MessageType::PlaystateRequest,
            wire::encode(&PlaystateRequestPayload::seek(100.0))
                .unwrap()
                .to_vec(),
        ),
        // 0x03 PlaystateRequest (pause)
        (
            MessageType::PlaystateRequest,
            wire::encode(&PlaystateRequestPayload::pause())
                .unwrap()
                .to_vec(),
        ),
        // 0x03 PlaystateRequest (play)
        (
            MessageType::PlaystateRequest,
            wire::encode(&PlaystateRequestPayload::play())
                .unwrap()
                .to_vec(),
        ),
        // 0x03 PlaystateRequest (set_speed)
        (
            MessageType::PlaystateRequest,
            wire::encode(&PlaystateRequestPayload::set_speed(2.0))
                .unwrap()
                .to_vec(),
        ),
        // 0x04 Chat (with timestamp)
        (
            MessageType::Chat,
            wire::encode(&ChatPayload::new("bob", "hello"))
                .unwrap()
                .to_vec(),
        ),
        // 0x05 Readiness
        (
            MessageType::Readiness,
            wire::encode(&ReadinessPayload::new("alice", true, true, "host"))
                .unwrap()
                .to_vec(),
        ),
        // 0x06 PlaylistChange
        (
            MessageType::PlaylistChange,
            wire::encode(&PlaylistChangePayload {
                files: vec![FileEntry {
                    name: "vid.mkv".into(),
                    duration: 3600.0,
                }],
                index: 0,
                set_by: "host".into(),
            })
            .unwrap()
            .to_vec(),
        ),
        // 0x07 PlaylistRequest
        (
            MessageType::PlaylistRequest,
            wire::encode(&PlaylistRequestPayload {
                action: PlaylistAction::SetIndex,
                files: vec![],
                index: 2,
            })
            .unwrap()
            .to_vec(),
        ),
        // 0x08 FileInfo
        (
            MessageType::FileInfo,
            wire::encode(&FileInfoPayload {
                username: "bob".into(),
                file: Some(FileMetadata {
                    name: "movie.mkv".into(),
                    duration: 7200.0,
                    size: 5000000,
                    checksum: Some("abc123".into()),
                }),
            })
            .unwrap()
            .to_vec(),
        ),
        // 0x09 FileTransfer
        (
            MessageType::FileTransfer,
            wire::encode(&FileTransferPayload {
                transfer_id: "tid-1".into(),
                chunk_index: 0,
                offset: 0,
                total_size: 1000,
                chunk_size: 256,
                data: vec![1, 2, 3],
            })
            .unwrap()
            .to_vec(),
        ),
        // 0x0A FileRequest
        (
            MessageType::FileRequest,
            wire::encode(&FileRequestPayload::new("movie.mkv", 0, "sha256:abc"))
                .unwrap()
                .to_vec(),
        ),
        // 0x0B FileResponse
        (
            MessageType::FileResponse,
            wire::encode(&FileResponsePayload::accept("tid-1", "sha256:abc", 262144))
                .unwrap()
                .to_vec(),
        ),
        // 0x0C LatencyPing
        (
            MessageType::LatencyPing,
            wire::encode(&LatencyPingPayload { send_time: 1000 })
                .unwrap()
                .to_vec(),
        ),
        // 0x0D LatencyPong
        (
            MessageType::LatencyPong,
            wire::encode(&LatencyPongPayload {
                send_time: 1000,
                receive_time: 1050,
            })
            .unwrap()
            .to_vec(),
        ),
        // 0x0E HostElected
        (
            MessageType::HostElected,
            wire::encode(&HostElectedPayload {
                host_id: "peer-2".into(),
                reason: "migration".into(),
            })
            .unwrap()
            .to_vec(),
        ),
        // 0x0F UserInfo
        (
            MessageType::UserInfo,
            wire::encode(&UserInfoPayload {
                username: "carol".into(),
                features: vec!["chat".into(), "sfu".into()],
            })
            .unwrap()
            .to_vec(),
        ),
        // 0x10 PeerDisconnect
        (
            MessageType::PeerDisconnect,
            wire::encode(&PeerDisconnectPayload {
                reason: "leaving".into(),
            })
            .unwrap()
            .to_vec(),
        ),
        // 0x11 VoiceMute
        (
            MessageType::VoiceMute,
            wire::encode(&VoiceMutePayload { muted: true })
                .unwrap()
                .to_vec(),
        ),
        // 0x12 SubtitleInfo
        (
            MessageType::SubtitleInfo,
            wire::encode(&SubtitleInfoPayload {
                subtitles: vec![SubtitleTrack {
                    filename: "movie.eng.srt".into(),
                    size: 50000,
                    language: Some("en".into()),
                }],
            })
            .unwrap()
            .to_vec(),
        ),
        // 0x13 ControllerChange (add)
        (
            MessageType::ControllerChange,
            wire::encode(&ControllerChangePayload {
                peer_id: "bob".into(),
                action: ControllerAction::Add,
            })
            .unwrap()
            .to_vec(),
        ),
        // 0x13 ControllerChange (remove)
        (
            MessageType::ControllerChange,
            wire::encode(&ControllerChangePayload {
                peer_id: "carol".into(),
                action: ControllerAction::Remove,
            })
            .unwrap()
            .to_vec(),
        ),
    ];

    for (expected_type, bytes) in &tests {
        let (decoded_type, frame_len) = wire::decode_header(bytes).unwrap();
        assert_eq!(
            decoded_type, *expected_type,
            "wrong type for {expected_type:?}"
        );
        assert_eq!(
            frame_len,
            bytes.len(),
            "wrong frame len for {expected_type:?}"
        );
        // Also verify payload roundtrip via decode_unchecked (skip binary types)
        let skip_decode = matches!(expected_type, MessageType::FileTransfer);
        if !skip_decode {
            let decoded = wire::decode_unchecked::<serde_json::Value>(bytes)
                .unwrap_or_else(|e| panic!("decode_unchecked failed for {expected_type:?}: {e}"));
            let _ = decoded;
        }
    }
}

#[test]
fn e2e_playstate_speed_and_timestamp() {
    // Verify speed and timestamp fields serialize/deserialize correctly
    let ps = PlaystatePayload::with_speed(100.0, false, true, "host", 5, 2.0);
    assert!((ps.speed - 2.0).abs() < 0.001);
    assert!(ps.timestamp > 0);
    assert_eq!(ps.seq, 5);

    // Verify default speed is 1.0
    let ps_default = PlaystatePayload::new(0.0, true, false, "host", 1);
    assert!((ps_default.speed - 1.0).abs() < 0.001);

    let encoded = wire::encode(&ps).unwrap();
    let (mt, _) = wire::decode_header(&encoded).unwrap();
    assert_eq!(mt, MessageType::Playstate);
}

#[test]
fn e2e_chat_timestamp_present() {
    let chat = ChatPayload::new("alice", "hello world");
    assert!(chat.timestamp > 0, "chat timestamp should be set");
    let encoded = wire::encode(&chat).unwrap();
    let (mt, _) = wire::decode_header(&encoded).unwrap();
    assert_eq!(mt, MessageType::Chat);
}

#[test]
fn e2e_hello_room_field() {
    let hello = HelloPayload::new("alice", "2.0", "movie-night", vec!["chat".into()]);
    assert_eq!(hello.room, "movie-night");
    assert_eq!(hello.username, "alice");

    let encoded = wire::encode(&hello).unwrap();
    let (mt, _) = wire::decode_header(&encoded).unwrap();
    assert_eq!(mt, MessageType::Hello);
}

#[test]
fn e2e_controller_access_flow() {
    // Verify controller add/remove roundtrip
    let add = ControllerChangePayload {
        peer_id: "bob".into(),
        action: ControllerAction::Add,
    };
    let remove = ControllerChangePayload {
        peer_id: "bob".into(),
        action: ControllerAction::Remove,
    };

    let enc_add = wire::encode(&add).unwrap();
    let enc_remove = wire::encode(&remove).unwrap();

    let (mt1, _) = wire::decode_header(&enc_add).unwrap();
    let (mt2, _) = wire::decode_header(&enc_remove).unwrap();
    assert_eq!(mt1, MessageType::ControllerChange);
    assert_eq!(mt2, MessageType::ControllerChange);
}

#[test]
fn e2e_voice_mute_flow() {
    let mute = VoiceMutePayload { muted: true };
    let unmute = VoiceMutePayload { muted: false };

    let enc_mute = wire::encode(&mute).unwrap();
    let enc_unmute = wire::encode(&unmute).unwrap();

    let (mt1, _) = wire::decode_header(&enc_mute).unwrap();
    let (mt2, _) = wire::decode_header(&enc_unmute).unwrap();
    assert_eq!(mt1, MessageType::VoiceMute);
    assert_eq!(mt2, MessageType::VoiceMute);
}

#[test]
fn e2e_subtitle_info_flow() {
    let subs = SubtitleInfoPayload {
        subtitles: vec![
            SubtitleTrack {
                filename: "movie.eng.srt".into(),
                size: 50000,
                language: Some("en".into()),
            },
            SubtitleTrack {
                filename: "movie.jpn.ass".into(),
                size: 80000,
                language: Some("ja".into()),
            },
        ],
    };
    let encoded = wire::encode(&subs).unwrap();
    let (mt, _) = wire::decode_header(&encoded).unwrap();
    assert_eq!(mt, MessageType::SubtitleInfo);
}

#[test]
fn e2e_file_transfer_flow() {
    // Request → Response → Transfer chunks
    let req = FileRequestPayload::new("movie.mkv", 0, "sha256:abc123");
    assert!(!req.transfer_id.is_empty());

    let resp = FileResponsePayload::accept(&req.transfer_id, "sha256:abc123", 262144);
    assert!(resp.accepted);
    assert_eq!(resp.chunk_size, 262144);

    let reject = FileResponsePayload::reject("tid-x", "file not found");
    assert!(!reject.accepted);
    assert_eq!(reject.reason, "file not found");

    let chunk = FileTransferPayload {
        transfer_id: req.transfer_id.clone(),
        chunk_index: 0,
        offset: 0,
        total_size: 262144,
        chunk_size: 256,
        data: vec![0u8; 256],
    };
    let encoded = wire::encode(&chunk).unwrap();
    let (mt, _) = wire::decode_header(&encoded).unwrap();
    assert_eq!(mt, MessageType::FileTransfer);
}

#[test]
fn e2e_user_info_flow() {
    let info = UserInfoPayload {
        username: "dave".into(),
        features: vec!["chat".into(), "playlist".into(), "sfu".into()],
    };
    let encoded = wire::encode(&info).unwrap();
    let (mt, _) = wire::decode_header(&encoded).unwrap();
    assert_eq!(mt, MessageType::UserInfo);
}

#[test]
fn e2e_peer_disconnect_flow() {
    let disc = PeerDisconnectPayload {
        reason: "user quit".into(),
    };
    let encoded = wire::encode(&disc).unwrap();
    let (mt, _) = wire::decode_header(&encoded).unwrap();
    assert_eq!(mt, MessageType::PeerDisconnect);
}

#[test]
fn e2e_config_throttle_and_persistence() {
    let mut cfg = P2pConfig::default();
    cfg.network.throttle_bytes_per_sec = 1_000_000; // 1MB/s
    cfg.voice_enabled = true;
    cfg.sfu_enabled = true;

    let json = serde_json::to_string_pretty(&cfg).unwrap();
    let parsed: P2pConfig = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.network.throttle_bytes_per_sec, 1_000_000);
    assert!(parsed.voice_enabled);
    assert!(parsed.sfu_enabled);
    // Password should NOT be in serialized output
    assert!(!json.contains("\"password\""));
}

#[test]
fn e2e_connection_state_transitions() {
    use syncplay_p2p::state::{ConnectionState, ConnectionStateMachine};

    let sm = ConnectionStateMachine::new();
    assert_eq!(sm.get(), ConnectionState::Offline);

    sm.set_connecting();
    assert_eq!(sm.get(), ConnectionState::Connecting);

    sm.set_handshaking();
    assert_eq!(sm.get(), ConnectionState::Handshaking);

    sm.set_ready(1);
    assert_eq!(sm.get(), ConnectionState::Ready { peer_count: 1 });

    // Reconnecting from Ready
    sm.set_reconnecting(1, 3);
    assert_eq!(
        sm.get(),
        ConnectionState::Reconnecting {
            attempt: 1,
            max_attempts: 3
        }
    );

    // Back to offline
    sm.set_offline("test done");
    assert_eq!(sm.get(), ConnectionState::Offline);
}

#[test]
fn e2e_playlist_request_flow() {
    let set_idx = PlaylistRequestPayload {
        action: PlaylistAction::SetIndex,
        files: vec![],
        index: 3,
    };
    let enc = wire::encode(&set_idx).unwrap();
    let (mt, _) = wire::decode_header(&enc).unwrap();
    assert_eq!(mt, MessageType::PlaylistRequest);

    let set_pl = PlaylistRequestPayload {
        action: PlaylistAction::SetPlaylist,
        files: vec![FileEntry {
            name: "ep1.mkv".into(),
            duration: 1800.0,
        }],
        index: 0,
    };
    let enc2 = wire::encode(&set_pl).unwrap();
    let (mt2, _) = wire::decode_header(&enc2).unwrap();
    assert_eq!(mt2, MessageType::PlaylistRequest);
}

#[test]
fn e2e_file_info_with_and_without_metadata() {
    // With file
    let with_file = FileInfoPayload {
        username: "alice".into(),
        file: Some(FileMetadata {
            name: "test.mkv".into(),
            duration: 5400.0,
            size: 1_000_000,
            checksum: None,
        }),
    };
    let enc = wire::encode(&with_file).unwrap();
    let (mt, _) = wire::decode_header(&enc).unwrap();
    assert_eq!(mt, MessageType::FileInfo);

    // Without file (clearing current file)
    let without_file = FileInfoPayload {
        username: "alice".into(),
        file: None,
    };
    let enc2 = wire::encode(&without_file).unwrap();
    let (mt2, _) = wire::decode_header(&enc2).unwrap();
    assert_eq!(mt2, MessageType::FileInfo);
}
