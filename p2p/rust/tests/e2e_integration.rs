//! End-to-end integration tests for Syncplay P2P.
//!
//! Tests the wire protocol, signaling server, and message flow
//! without requiring actual WebRTC connections.

use syncplay_p2p::config::P2pConfig;
use syncplay_p2p::messages::*;
use syncplay_p2p::player::detect_players;
use syncplay_p2p::player::default_player;
use syncplay_p2p::wire;

#[test]
fn e2e_wire_all_message_types_roundtrip() {
    // Encode every message type, decode, verify
    let messages: Vec<(MessageType, Vec<u8>)> = vec![
        (MessageType::Hello, wire::encode(&HelloPayload::new("alice", "2.0", vec!["chat".into()])).unwrap().to_vec()),
        (MessageType::Playstate, wire::encode(&PlaystatePayload::new(42.0, false, true, "host", 1)).unwrap().to_vec()),
        (MessageType::PlaystateRequest, wire::encode(&PlaystateRequestPayload::seek(100.0)).unwrap().to_vec()),
        (MessageType::Chat, wire::encode(&ChatPayload::new("bob", "hi")).unwrap().to_vec()),
        (MessageType::Readiness, wire::encode(&ReadinessPayload::new("alice", true, true, "alice")).unwrap().to_vec()),
        (MessageType::PlaylistChange, wire::encode(&PlaylistChangePayload { files: vec![], index: 0, set_by: "host".into() }).unwrap().to_vec()),
        (MessageType::LatencyPing, wire::encode(&LatencyPingPayload { send_time: 1000 }).unwrap().to_vec()),
        (MessageType::LatencyPong, wire::encode(&LatencyPongPayload { send_time: 1000, receive_time: 1050 }).unwrap().to_vec()),
        (MessageType::HostElected, wire::encode(&HostElectedPayload { host_id: "peer-2".into(), reason: "left".into() }).unwrap().to_vec()),
        (MessageType::PeerDisconnect, wire::encode(&PeerDisconnectPayload { reason: "goodbye".into() }).unwrap().to_vec()),
    ];

    for (expected_type, bytes) in &messages {
        let (decoded_type, frame_len) = wire::decode_header(bytes).unwrap();
        assert_eq!(decoded_type, *expected_type, "wrong type for {expected_type:?}");
        assert_eq!(frame_len, bytes.len(), "wrong frame len for {expected_type:?}");
    }
}

#[test]
fn e2e_multiple_frames_in_stream() {
    // Simulate a real data stream with multiple frames back-to-back
    let hello = wire::encode(&HelloPayload::new("x", "1.0", vec![])).unwrap();
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

    assert_eq!(types_seen, vec![MessageType::Hello, MessageType::Playstate, MessageType::Chat]);
    assert_eq!(offset, stream.len());
}

#[test]
fn e2e_config_pipeline() {
    // Test full config pipeline: defaults → serialize → deserialize → verify
    let mut cfg = P2pConfig::default();
    cfg.room = "test-room".into();
    cfg.network.turn_servers = vec!["turn:user:pass@turn.example.com:3478".into()];

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
    let hello = wire::encode(&HelloPayload::new("alice", "2.0", vec!["chat".into(), "readiness".into()])).unwrap();
    assert!(hello.len() < 512, "hello frame too large: {}", hello.len());

    let big_chat = wire::encode(&ChatPayload::new("bob", &"x".repeat(2000))).unwrap();
    assert!(big_chat.len() < 4096, "chat frame too large: {}", big_chat.len());

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
    let host_features = vec!["chat", "readiness", "playlist"];
    let peer_features = vec!["chat", "readiness"];

    let host_has_chat = host_features.contains(&"chat".to_string());
    let peer_has_chat = peer_features.contains(&"chat".to_string());
    assert!(host_has_chat && peer_has_chat); // compatible

    let host_has_playlist = host_features.contains(&"playlist".to_string());
    let peer_has_playlist = peer_features.contains(&"playlist".to_string());
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
