//! SFU (Selective Forwarding Unit) server module.
//!
//! Replaces full-mesh WebRTC with a server-side star topology.
//! Each peer maintains a single WebRTC connection to the server.
//! The server routes data channel messages between peers and forwards
//! audio tracks (receive from one peer, send to all others in the room).
//!
//! Architecture:
//!   Peer A ──PC──┐
//!   Peer B ──PC──┤── SfuServer (routes data + forwards audio)
//!   Peer C ──PC──┘
//!
//! Compared to full-mesh (N×(N−1) connections), this uses N connections
//! and eliminates per-peer ICE negotiation and duplicate uploads.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use dashmap::DashMap;
use log::{debug, info, warn};
use parking_lot::Mutex;
use tokio::sync::mpsc;
use webrtc::api::media_engine::MIME_TYPE_OPUS;
use webrtc::api::APIBuilder;
use webrtc::api::API;
use webrtc::data_channel::data_channel_init::RTCDataChannelInit;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTPCodecType;
use webrtc::rtp_transceiver::rtp_transceiver_direction::RTCRtpTransceiverDirection;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_remote::TrackRemote;

use crate::connection::DATA_CHANNEL_LABEL;

use std::future::Future;

/// Timeout for TrackRemote::read operations to prevent hanging.
const TRACK_READ_TIMEOUT_SECS: u64 = 30;

// ── Config ────────────────────────────────────────────────────────────

/// SFU server configuration.
pub struct SfuConfig {
    /// STUN servers for the server-side peer connections.
    pub stun_servers: Vec<String>,
    /// TURN servers for server-side relay.
    pub turn_servers: Vec<String>,
    /// Max peers per room.
    pub max_peers_per_room: usize,
}

impl Default for SfuConfig {
    fn default() -> Self {
        Self {
            stun_servers: vec!["stun:stun.l.google.com:19302".into()],
            turn_servers: vec![],
            max_peers_per_room: 100,
        }
    }
}

// ── Types ─────────────────────────────────────────────────────────────

/// A peer connection managed by the SFU server.
pub struct SfuPeer {
    /// The WebRTC peer connection to this client.
    pub pc: Arc<RTCPeerConnection>,
    /// Data channel for sync protocol messages.
    pub dc: Arc<RTCDataChannel>,
    /// The peer's username.
    pub username: String,
    /// Tracks being forwarded TO this peer (from_peer_id → local track).
    audio_senders: Mutex<HashMap<String, Arc<TrackLocalStaticSample>>>,
}

/// A room managed by the SFU server.
pub struct SfuRoom {
    pub peers: DashMap<String, SfuPeer>,
    /// Ordered list of peer IDs, for host election. Also guards capacity check.
    pub join_order: Mutex<Vec<String>>,
}

/// Per-room message routing: SFU broadcasts data to all peers except sender.
#[derive(Clone)]
pub struct SfuRouter {
    /// Room name → Room
    rooms: Arc<DashMap<String, Arc<SfuRoom>>>,
    /// Channel to send server-level events (peer join/leave) to signaling layer.
    /// Events are informational — the signaling layer handles its own join/leave tracking.
    events_tx: mpsc::Sender<SfuEvent>,
}

/// Events emitted by the SFU router to the signaling layer.
#[derive(Debug, Clone)]
pub enum SfuEvent {
    PeerJoined {
        room: String,
        peer_id: String,
        username: String,
        features: Vec<String>,
    },
    PeerLeft {
        room: String,
        peer_id: String,
        reason: String,
    },
}

// ── SfuServer ─────────────────────────────────────────────────────────

/// SFU server — creates peer connections for clients and routes messages.
pub struct SfuServer {
    pub router: SfuRouter,
    api: API,
    ice_config: RTCConfiguration,
    max_peers_per_room: usize,
}

impl SfuServer {
    pub async fn new(cfg: SfuConfig) -> Result<Self> {
        let mut ice_servers: Vec<RTCIceServer> = cfg
            .stun_servers
            .iter()
            .map(|url| RTCIceServer {
                urls: vec![url.clone()],
                ..Default::default()
            })
            .collect();

        for turn_url in &cfg.turn_servers {
            if let Some(rest) = turn_url.strip_prefix("turn:") {
                let parts: Vec<&str> = rest.splitn(2, '@').collect();
                if parts.len() == 2 {
                    let creds: Vec<&str> = parts[0].splitn(2, ':').collect();
                    let host = parts[1];
                    if creds.len() == 2 {
                        ice_servers.push(RTCIceServer {
                            urls: vec![format!("turn:{host}")],
                            username: creds[0].into(),
                            credential: creds[1].into(),
                        });
                    }
                }
            }
        }

        let api = APIBuilder::new().build();
        let ice_config = RTCConfiguration {
            ice_servers,
            ..Default::default()
        };

        let (events_tx, _events_rx) = mpsc::channel(256);

        Ok(Self {
            router: SfuRouter {
                rooms: Arc::new(DashMap::new()),
                events_tx,
            },
            api,
            ice_config,
            max_peers_per_room: cfg.max_peers_per_room,
        })
    }

    /// Handle an SDP offer from a peer — creates a PC, sets remote desc, returns answer SDP.
    pub async fn handle_offer(
        &self,
        room: &str,
        peer_id: &str,
        username: &str,
        sdp: &str,
    ) -> Result<String> {
        let pc = Arc::new(
            self.api
                .new_peer_connection(self.ice_config.clone())
                .await?,
        );

        // Pre-create audio transceiver so audio tracks can be dynamically added
        pc.add_transceiver_from_kind(
            RTPCodecType::Audio,
            Some(webrtc::rtp_transceiver::RTCRtpTransceiverInit {
                direction: RTCRtpTransceiverDirection::Sendrecv,
                send_encodings: vec![],
            }),
        )
        .await?;

        let dc = pc
            .create_data_channel(
                DATA_CHANNEL_LABEL,
                Some(RTCDataChannelInit {
                    ordered: Some(true),
                    ..Default::default()
                }),
            )
            .await?;

        // Set remote description from client's offer BEFORE wiring peer
        let offer = RTCSessionDescription::offer(sdp.to_string())?;
        pc.set_remote_description(offer).await?;

        // Create answer
        let answer = pc.create_answer(None).await?;
        pc.set_local_description(answer.clone()).await?;

        // Wire peer into room AFTER SDP validation succeeds
        let peer = SfuPeer {
            pc: pc.clone(),
            dc: dc.clone(),
            username: username.to_string(),
            audio_senders: Mutex::new(HashMap::new()),
        };

        self.wire_peer(room, peer_id, peer, pc.clone()).await?;

        Ok(answer.sdp)
    }

    /// Handle an ICE candidate from a peer.
    pub async fn handle_ice(
        &self,
        room: &str,
        peer_id: &str,
        candidate: &str,
        sdp_mid: &str,
        sdp_mline_index: u16,
    ) -> Result<()> {
        let room_obj = self.router.rooms.get(room).context("Room not found")?;

        let peer = room_obj.peers.get(peer_id).context("Peer not found")?;

        let mid = if sdp_mid.is_empty() {
            None
        } else {
            Some(sdp_mid.to_string())
        };

        peer.pc
            .add_ice_candidate(RTCIceCandidateInit {
                candidate: candidate.to_string(),
                sdp_mid: mid,
                sdp_mline_index: Some(sdp_mline_index),
                username_fragment: None,
            })
            .await
            .context("Failed to add ICE candidate")?;

        Ok(())
    }

    /// Remove a peer from a room, closing their PC and cleaning up forwarders.
    pub async fn remove_peer(&self, room: &str, peer_id: &str) {
        if let Some(room_obj) = self.router.rooms.get(room) {
            let username = room_obj
                .peers
                .get(peer_id)
                .map(|p| p.username.clone())
                .unwrap_or_default();

            // Remove from audio senders on other peers
            for entry in room_obj.peers.iter() {
                if entry.key() != peer_id {
                    entry.value().audio_senders.lock().remove(peer_id);
                }
            }

            // Remove the peer
            if let Some((_, peer)) = room_obj.peers.remove(peer_id) {
                if let Err(e) = peer.pc.close().await {
                    warn!("[sfu] Error closing peer connection: {e}");
                }
            }

            // Update join order
            room_obj.join_order.lock().retain(|id| id != peer_id);

            // Remove empty rooms
            if room_obj.peers.is_empty() {
                self.router.rooms.remove(room);
            }

            // Emit event
            if let Err(e) = self.router.events_tx.try_send(SfuEvent::PeerLeft {
                room: room.to_string(),
                peer_id: peer_id.to_string(),
                reason: "left".into(),
            }) {
                warn!("[sfu] Failed to emit PeerLeft event: {e}");
            }

            info!("[sfu] {room}: {username} ({peer_id}) removed");
        }
    }

    /// Wire a new peer into a room — sets up data channel routing and audio forwarding.
    async fn wire_peer(
        &self,
        room: &str,
        peer_id: &str,
        peer: SfuPeer,
        pc: Arc<RTCPeerConnection>,
    ) -> Result<()> {
        let room_name = room.to_string();
        let pid = peer_id.to_string();
        let username = peer.username.clone();
        let max_peers = self.max_peers_per_room;

        // Get or create room
        let room_obj = self
            .router
            .rooms
            .entry(room.to_string())
            .or_insert_with(|| {
                Arc::new(SfuRoom {
                    peers: DashMap::new(),
                    join_order: Mutex::new(Vec::new()),
                })
            })
            .clone();

        // Check room capacity atomically using join_order Mutex
        {
            let mut order = room_obj.join_order.lock();
            if order.len() >= max_peers {
                return Err(anyhow::anyhow!("Room is full (max {max_peers})"));
            }
            order.push(pid.clone());
        }

        room_obj.peers.insert(pid.clone(), peer);

        // ── For late-joining peers: create audio tracks for all existing peers ──
        let new_peer = room_obj.peers.get(&pid).context("Peer vanished")?;
        let existing_peer_ids: Vec<String> = room_obj
            .peers
            .iter()
            .filter(|e| e.key() != &pid)
            .map(|e| e.key().clone())
            .collect();

        for from_peer_id in &existing_peer_ids {
            match create_opus_track(from_peer_id) {
                Ok(local_track) => match new_peer.pc.add_track(local_track.clone()).await {
                    Ok(_) => {
                        new_peer
                            .audio_senders
                            .lock()
                            .insert(from_peer_id.clone(), local_track);
                        info!("[sfu] Late-joiner audio track: {pid} ← {from_peer_id}");
                    }
                    Err(e) => {
                        warn!("[sfu] Failed to add late-joiner audio track to {pid}: {e}");
                    }
                },
                Err(e) => {
                    warn!("[sfu] Failed to create late-joiner audio track: {e}");
                }
            }
        }

        // ── Data channel message routing ─────────────────────────
        let room_obj_2 = room_obj.clone();
        let pid_2 = pid.clone();
        let dc = room_obj
            .peers
            .get(&pid)
            .context("Peer vanished")?
            .dc
            .clone();

        dc.on_message(Box::new(
            move |msg: DataChannelMessage| -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
                let data = msg.data;
                let from_pid = pid_2.clone();
                let room = room_obj_2.clone();

                Box::pin(async move {
                    // Security: only route authorized message types.
                    // Host-authoritative messages (playstate, playlist, controller)
                    // must only come from the room host. All peers can send chat, readiness.
                    let should_route = match crate::wire::decode_header(&data) {
                        Ok((crate::messages::MessageType::Playstate, _))
                        | Ok((crate::messages::MessageType::PlaystateRequest, _))
                        | Ok((crate::messages::MessageType::PlaylistChange, _))
                        | Ok((crate::messages::MessageType::PlaylistRequest, _))
                        | Ok((crate::messages::MessageType::ControllerChange, _))
                        | Ok((crate::messages::MessageType::HostElected, _)) => {
                            // Host-authoritative: only route if sender is the room host
                            // (first peer in join_order is the host)
                            let host_id =
                                room.join_order.lock().first().cloned().unwrap_or_default();
                            from_pid == host_id
                        }
                        _ => true, // Chat, readiness, latency, voice, files — all peers can send
                    };
                    if !should_route {
                        warn!("[sfu] Blocked unauthorized message from {from_pid}");
                        return;
                    }
                    for entry in room.peers.iter() {
                        if entry.key() != &from_pid {
                            if let Err(e) = entry.value().dc.send(&data).await {
                                warn!("[sfu] Failed to send to {}: {e}", entry.key());
                            }
                        }
                    }
                })
            },
        ));

        // ── Audio track forwarding ───────────────────────────────
        let room_obj_3 = room_obj.clone();
        let pid_3 = pid.clone();

        pc.on_track(Box::new(
            move |track: Arc<TrackRemote>, _receiver, _transceiver| {
                let from_pid = pid_3.clone();
                let room_track = room_obj_3.clone();

                if track.kind() == RTPCodecType::Audio {
                    Box::pin(async move {
                        forward_audio_track(room_track, from_pid, track).await;
                    })
                } else {
                    Box::pin(async {})
                }
            },
        ));

        // Emit join event
        if let Err(e) = self.router.events_tx.try_send(SfuEvent::PeerJoined {
            room: room_name.clone(),
            peer_id: pid.clone(),
            username: username.clone(),
            features: vec!["sfu".into()],
        }) {
            warn!("[sfu] Failed to emit PeerJoined event: {e}");
        }

        info!("[sfu] {room_name}: {username} ({pid}) connected");

        Ok(())
    }
}

// ── Audio Forwarding ──────────────────────────────────────────────────

/// Forward audio RTP from one peer to all other peers in the room.
async fn forward_audio_track(
    room: Arc<SfuRoom>,
    from_peer_id: String,
    incoming_track: Arc<TrackRemote>,
) {
    // Ensure each other peer has a local audio track to receive on
    for entry in room.peers.iter() {
        let to_peer_id = entry.key().clone();
        if to_peer_id == from_peer_id {
            continue;
        }

        let needs_track = {
            let senders = entry.value().audio_senders.lock();
            !senders.contains_key(&from_peer_id)
        };

        if needs_track {
            match create_opus_track(&from_peer_id) {
                Ok(local_track) => {
                    let pc = entry.value().pc.clone();
                    match pc.add_track(local_track.clone()).await {
                        Ok(_) => {
                            entry
                                .value()
                                .audio_senders
                                .lock()
                                .insert(from_peer_id.clone(), local_track);
                            info!("[sfu] Audio track added: peer {to_peer_id} ← {from_peer_id}");
                        }
                        Err(e) => {
                            warn!("[sfu] Failed to add audio track to {to_peer_id}: {e}");
                        }
                    }
                }
                Err(e) => {
                    warn!("[sfu] Failed to create audio track: {e}");
                }
            }
        }
    }

    // Read RTP packets and forward with timeout
    let mut buf = vec![0u8; 1500];
    loop {
        let read_result = tokio::time::timeout(
            Duration::from_secs(TRACK_READ_TIMEOUT_SECS),
            incoming_track.read(&mut buf),
        )
        .await;

        match read_result {
            Ok(Ok((rtp_packet, _attrs))) => {
                let sample = webrtc::media::Sample {
                    data: rtp_packet.payload,
                    duration: Duration::from_millis(20),
                    ..Default::default()
                };

                for entry in room.peers.iter() {
                    if entry.key() == &from_peer_id {
                        continue;
                    }
                    let track_to_write = {
                        let senders = entry.value().audio_senders.lock();
                        senders.get(&from_peer_id).cloned()
                    };
                    if let Some(track) = track_to_write {
                        if let Err(e) = track.write_sample(&sample).await {
                            warn!("[sfu] Audio write error to {}: {e}", entry.key());
                        }
                    }
                }
            }
            Ok(Err(e)) => {
                debug!("[sfu] Audio read from {from_peer_id} ended: {e}");
                break;
            }
            Err(_timeout) => {
                warn!(
                    "[sfu] Audio read from {from_peer_id} timed out after {}s — closing",
                    TRACK_READ_TIMEOUT_SECS
                );
                break;
            }
        }
    }

    // Cleanup
    for entry in room.peers.iter() {
        entry.value().audio_senders.lock().remove(&from_peer_id);
    }

    info!("[sfu] Audio forwarding from {from_peer_id} stopped");
}

/// Create a local Opus audio track for forwarding.
fn create_opus_track(from_peer_id: &str) -> Result<Arc<TrackLocalStaticSample>> {
    use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;

    let track = Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability {
            mime_type: MIME_TYPE_OPUS.to_string(),
            clock_rate: 48000,
            channels: 2,
            sdp_fmtp_line: "minptime=10;useinbandfec=1".to_string(),
            rtcp_feedback: vec![],
        },
        format!("audio-from-{from_peer_id}"),
        "syncplay-voice".to_string(),
    ));

    Ok(track)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let cfg = SfuConfig::default();
        assert!(!cfg.stun_servers.is_empty());
        assert_eq!(cfg.max_peers_per_room, 100);
    }

    #[test]
    fn test_sfu_config_custom() {
        let cfg = SfuConfig {
            max_peers_per_room: 50,
            ..Default::default()
        };
        assert_eq!(cfg.max_peers_per_room, 50);
    }
}
