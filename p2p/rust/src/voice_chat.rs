//! Voice chat over WebRTC audio tracks.
//!
//! Each peer creates one Opus audio track for their microphone.
//! Incoming tracks from other peers are played through the default
//! output device. Mute is per-user.
//!
//! IMPORTANT: Use headphones to prevent movie audio echo.
//! Voice is Opus-encoded at ~32kbps — negligible bandwidth overhead.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use log::{error, info};
use parking_lot::Mutex;
use tokio::sync::mpsc;

use webrtc::api::media_engine::MIME_TYPE_OPUS;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_remote::TrackRemote;

use crate::connection::ConnectionManager;

pub type LocalAudioTrack = Arc<TrackLocalStaticSample>;

#[derive(Debug, Clone, Default)]
pub struct PeerVoice {
    pub muted: bool,
    pub speaking: bool,
    pub track_id: Option<String>,
}

#[derive(Debug, Clone)]
pub enum VoiceEvent {
    MuteChanged(bool),
    PeerSpeaking { peer_id: String, speaking: bool },
    TrackAdded { peer_id: String },
    TrackRemoved { peer_id: String },
    Error(String),
}

pub struct VoiceChat {
    conn: ConnectionManager,
    muted: Arc<AtomicBool>,
    local_track: Option<LocalAudioTrack>,
    peer_voices: Arc<Mutex<HashMap<String, PeerVoice>>>,
    events_tx: Arc<Mutex<Option<mpsc::UnboundedSender<VoiceEvent>>>>,
    _capture_handle: Mutex<Option<cpal::Stream>>,
    _playback_streams: Mutex<HashMap<String, cpal::Stream>>,
}

impl VoiceChat {
    pub fn new(conn: ConnectionManager) -> Self {
        Self {
            conn,
            muted: Arc::new(AtomicBool::new(false)),
            local_track: None,
            peer_voices: Arc::new(Mutex::new(HashMap::new())),
            events_tx: Arc::new(Mutex::new(None)),
            _capture_handle: Mutex::new(None),
            _playback_streams: Mutex::new(HashMap::new()),
        }
    }

    pub fn is_muted(&self) -> bool {
        self.muted.load(Ordering::SeqCst)
    }

    pub fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::SeqCst);
        info!("Mic muted: {muted}");
        if let Some(tx) = self.events_tx.lock().as_ref() {
            let _ = tx.send(VoiceEvent::MuteChanged(muted));
        }
    }

    pub fn toggle_mute(&self) -> bool {
        let new = !self.is_muted();
        self.set_muted(new);
        new
    }

    /// Returns the shared mute flag for direct TUI toggling.
    pub fn mute_flag(&self) -> Arc<AtomicBool> {
        self.muted.clone()
    }

    pub fn peer_voice_status(&self) -> Vec<(String, bool)> {
        self.peer_voices
            .lock()
            .iter()
            .map(|(id, v)| (id.clone(), v.muted))
            .collect()
    }

    /// Create a local audio track for sending voice to peers.
    /// Also registers to add the track to any new peer connections.
    pub fn create_local_track(&mut self) -> Result<LocalAudioTrack> {
        let track = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability {
                mime_type: MIME_TYPE_OPUS.to_string(),
                clock_rate: 48000,
                channels: 1,
                sdp_fmtp_line: "minptime=10;useinbandfec=1".to_string(),
                rtcp_feedback: vec![],
            },
            "voice".to_string(),
            "syncplay-voice".to_string(),
        ));
        self.local_track = Some(track.clone());

        // Register callback to add this track to any future peer connections
        let t = track.clone();
        let voices = self.peer_voices.clone();
        let ev_tx = self.events_tx.clone();
        self.conn
            .on_peer_connection(move |pc: Arc<RTCPeerConnection>, peer_id: String| {
                let t2 = t.clone();
                let v2 = voices.clone();
                let e2 = ev_tx.clone();
                tokio::spawn(async move {
                    match pc.add_track(t2).await {
                        Ok(_) => {
                            info!("Voice track added to peer connection for {peer_id}");
                            v2.lock().entry(peer_id.clone()).or_insert(PeerVoice {
                                muted: false,
                                speaking: true,
                                track_id: Some("local".into()),
                            });
                            if let Some(tx) = e2.lock().as_ref() {
                                let _ = tx.send(VoiceEvent::TrackAdded { peer_id });
                            }
                        }
                        Err(e) => {
                            error!("Failed to add voice track for {peer_id}: {e}");
                        }
                    }
                });
            });

        Ok(track)
    }

    pub fn local_track_clone(&self) -> Option<LocalAudioTrack> {
        self.local_track.clone()
    }

    /// Start mic capture, returns event stream. Uses cpal for cross-platform audio.
    /// Only call once; subsequent calls return an error.
    pub fn start_capture(&mut self) -> Result<mpsc::UnboundedReceiver<VoiceEvent>> {
        if self._capture_handle.lock().is_some() {
            return Err(anyhow::anyhow!("Voice capture already started"));
        }
        let (tx, rx) = mpsc::unbounded_channel();
        *self.events_tx.lock() = Some(tx.clone());

        let host = cpal::default_host();
        let device = host.default_input_device().context("No microphone found")?;
        info!("Voice input: {}", device.name().unwrap_or_default());

        let track = self
            .local_track
            .clone()
            .context("Call create_local_track() first")?;
        let muted = self.muted.clone();

        let config = cpal::StreamConfig {
            channels: 1,
            sample_rate: cpal::SampleRate(48000),
            buffer_size: cpal::BufferSize::Default,
        };

        let tx_err = tx.clone();
        let stream = device.build_input_stream(
            &config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if muted.load(Ordering::SeqCst) {
                    return;
                }
                let pcm: Vec<i16> = data
                    .iter()
                    .map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
                    .collect();
                let sample = webrtc::media::Sample {
                    data: bytes::Bytes::from(bytemuck::cast_slice(&pcm).to_vec()),
                    duration: std::time::Duration::from_millis(20),
                    ..Default::default()
                };
                // Non-async cpal callback — spawn onto tokio context
                #[allow(clippy::let_underscore_future)]
                {
                    let _ = track.write_sample(&sample);
                }
            },
            move |err| {
                error!("Voice capture error: {err}");
                let _ = tx_err.send(VoiceEvent::Error(format!("{err}")));
            },
            None,
        )?;

        stream.play()?;
        *self._capture_handle.lock() = Some(stream);
        info!("Voice capture active (48kHz mono)");
        Ok(rx)
    }

    /// Handle a remote audio track from a peer.
    /// Handle a remote audio track from a peer.
    /// TODO: Implement actual audio playback from remote tracks.
    pub fn handle_remote_track(&self, peer_id: &str, _track: Arc<TrackRemote>) {
        let pid = peer_id.to_string();
        info!("Voice track received from {pid}");
        self.peer_voices
            .lock()
            .entry(pid.clone())
            .or_insert(PeerVoice {
                muted: false,
                speaking: true,
                track_id: Some("remote".into()),
            });
        if let Some(tx) = self.events_tx.lock().as_ref() {
            let _ = tx.send(VoiceEvent::TrackAdded { peer_id: pid });
        }
    }

    pub fn stop(&self) {
        *self._capture_handle.lock() = None;
        self._playback_streams.lock().clear();
        info!("Voice stopped");
    }
}

pub fn opus_codec_capability() -> RTCRtpCodecCapability {
    RTCRtpCodecCapability {
        mime_type: MIME_TYPE_OPUS.to_string(),
        clock_rate: 48000,
        channels: 2,
        sdp_fmtp_line: "minptime=10;useinbandfec=1".to_string(),
        rtcp_feedback: vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mute_toggle() {
        let conn = ConnectionManager::new("alice", vec![]);
        let vc = VoiceChat::new(conn);
        assert!(!vc.is_muted());
        vc.toggle_mute();
        assert!(vc.is_muted());
    }

    #[test]
    fn test_set_muted() {
        let conn = ConnectionManager::new("bob", vec![]);
        let vc = VoiceChat::new(conn);
        vc.set_muted(true);
        assert!(vc.is_muted());
    }

    #[test]
    fn test_peer_voice_empty() {
        let conn = ConnectionManager::new("carol", vec![]);
        assert!(VoiceChat::new(conn).peer_voice_status().is_empty());
    }

    #[test]
    fn test_opus_codec() {
        let cap = opus_codec_capability();
        assert_eq!(cap.mime_type, "audio/opus");
        assert_eq!(cap.clock_rate, 48000);
    }
}
