//! Voice chat over WebRTC audio tracks.
//!
//! Each peer creates one Opus audio track for their microphone.
//! Incoming tracks from other peers are decoded and played through
//! a shared output mixer on the default output device.
//!
//! IMPORTANT: Use headphones to prevent movie audio echo.
//! Voice is Opus-encoded at ~32kbps — negligible bandwidth overhead.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::{Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use log::{error, info, warn};
use parking_lot::Mutex;
use tokio::sync::mpsc;

use webrtc::api::media_engine::MIME_TYPE_OPUS;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_remote::TrackRemote;

use crate::connection::ConnectionManager;

pub type LocalAudioTrack = Arc<TrackLocalStaticSample>;

/// Voice status for a single peer, including mute state and speaking detection.
#[derive(Debug, Clone, Default)]
pub struct PeerVoice {
    pub muted: bool,
    pub speaking: bool,
    pub track_id: Option<String>,
}

/// Events emitted by the voice chat system (mute changes, peer speaking, track lifecycle, errors).
#[derive(Debug, Clone)]
pub enum VoiceEvent {
    MuteChanged(bool),
    PeerSpeaking { peer_id: String, speaking: bool },
    TrackAdded { peer_id: String },
    TrackRemoved { peer_id: String },
    Error(String),
}

/// Minimum RMS energy for voice activity detection (48kHz f32 samples).
/// Audio below this threshold is treated as silence and not sent to peers.
const VAD_ENERGY_THRESHOLD: f32 = 0.005;

/// Per-peer RTP packet reordering buffer for jitter compensation.
/// Holds up to `max_packets` pending packets, emitting them in sequence-number
/// order once enough have arrived. Handles u16 sequence number wrap.
#[derive(Clone)]
struct AudioJitterBuffer {
    /// Queued packets sorted by sequence number: (seq_num, payload)
    packets: Arc<Mutex<VecDeque<(u16, Vec<u8>)>>>,
    /// Next expected sequence number
    next_seq: Arc<Mutex<Option<u16>>>,
    /// Target number of packets to queue before emitting (2 = ~40ms latency)
    target_depth: usize,
    max_packets: usize,
}

impl AudioJitterBuffer {
    fn new(target_depth: usize, max_packets: usize) -> Self {
        Self {
            packets: Arc::new(Mutex::new(VecDeque::new())),
            next_seq: Arc::new(Mutex::new(None)),
            target_depth,
            max_packets,
        }
    }

    /// Insert a packet. If seq is in the past (behind next_seq by < 128),
    /// it's dropped as a late duplicate. Otherwise inserted in order.
    fn insert(&self, seq: u16, payload: Vec<u8>) {
        let mut packets = self.packets.lock();
        let next = *self.next_seq.lock();

        // Drop packets that are too old (>128 seq numbers behind)
        if let Some(expected) = next {
            let diff = seq.wrapping_sub(expected);
            if diff > 32768 && expected.wrapping_sub(seq) < 128 {
                return; // stale duplicate
            }
        }

        // Insert sorted by sequence number (handling u16 wrap)
        let pos = packets
            .binary_search_by(|(s, _)| {
                let a = s.wrapping_sub(seq);
                if a == 0 {
                    std::cmp::Ordering::Equal
                } else if a < 32768 {
                    std::cmp::Ordering::Less
                } else {
                    std::cmp::Ordering::Greater
                }
            })
            .unwrap_or_else(|e| e);
        packets.insert(pos, (seq, payload));

        // Evict oldest if over capacity
        while packets.len() > self.max_packets {
            packets.pop_front();
            let mut ns = self.next_seq.lock();
            if let Some(ref mut expected) = *ns {
                *expected = expected.wrapping_add(1);
            }
        }
    }

    /// Pop the next in-order packet if available. Returns None if the
    /// buffer hasn't reached target depth OR the next expected packet
    /// is not yet present.
    fn pop_ready(&self) -> Option<Vec<u8>> {
        let mut packets = self.packets.lock();
        let mut next = self.next_seq.lock();

        if packets.is_empty() {
            return None;
        }

        // Only emit when we have target_depth packets buffered
        // (unless buffer is at max capacity, then force emit)
        if packets.len() < self.target_depth && packets.len() < self.max_packets {
            return None;
        }

        let expected = next.unwrap_or_else(|| {
            // First packet: set expected to the front seq
            packets[0].0
        });

        let front_seq = packets[0].0;
        if front_seq == expected {
            let (_, payload) = packets.pop_front().unwrap();
            *next = Some(expected.wrapping_add(1));
            Some(payload)
        } else {
            // Gap detected — skip ahead to the front packet
            let gap = front_seq.wrapping_sub(expected);
            if gap < 128 {
                // Small gap: skip missing packets, fast-forward
                *next = Some(front_seq);
                let (_, payload) = packets.pop_front().unwrap();
                *next = Some(front_seq.wrapping_add(1));
                Some(payload)
            } else {
                // Large gap (probably wrap): reset
                *next = Some(front_seq);
                None
            }
        }
    }
}

/// Per-peer PCM ring buffers shared between decode tasks (producers)
/// and the cpal output callback (consumer). Each peer gets its own buffer;
/// the output callback mixes by popping one sample from each non-empty
/// buffer and summing with i16 saturation.
#[derive(Clone)]
struct VoiceBuffer {
    buffers: Arc<Mutex<Vec<VecDeque<i16>>>>,
    max_samples: usize,
    /// Cumulative dropped samples (when a per-peer buffer is full and oldest
    /// samples are evicted). Reset to 0 after emitting an Error event.
    dropped_samples: Arc<AtomicU64>,
    events_tx: Arc<Mutex<Option<mpsc::Sender<VoiceEvent>>>>,
}

impl VoiceBuffer {
    fn new(max_samples: usize, events_tx: Arc<Mutex<Option<mpsc::Sender<VoiceEvent>>>>) -> Self {
        Self {
            buffers: Arc::new(Mutex::new(Vec::new())),
            max_samples,
            dropped_samples: Arc::new(AtomicU64::new(0)),
            events_tx,
        }
    }

    /// Allocate a new per-peer buffer and return its index.
    fn add_peer_buffer(&self) -> usize {
        let mut bufs = self.buffers.lock();
        let idx = bufs.len();
        bufs.push(VecDeque::with_capacity(self.max_samples));
        idx
    }

    /// Push decoded PCM samples into a specific peer's buffer.
    /// If the buffer is full the oldest samples are dropped (tracked via
    /// `dropped_samples`). When cumulative drops exceed 1000 an
    /// `VoiceEvent::Error` is emitted and the counter resets.
    fn push_samples(&self, peer_idx: usize, samples: &[i16]) {
        let mut bufs = self.buffers.lock();
        if let Some(buf) = bufs.get_mut(peer_idx) {
            let mut dropped = 0u64;
            for &s in samples {
                if buf.len() >= self.max_samples {
                    buf.pop_front();
                    dropped += 1;
                }
                buf.push_back(s);
            }
            if dropped > 0 {
                let prev = self.dropped_samples.fetch_add(dropped, Ordering::Relaxed);
                let total = prev + dropped;
                if total >= 1000 {
                    self.dropped_samples.store(0, Ordering::Relaxed);
                    if let Some(tx) = self.events_tx.lock().as_ref() {
                        if let Err(e) = tx.try_send(VoiceEvent::Error(format!(
                            "Voice buffer overrun: {total} samples dropped"
                        ))) {
                            warn!("Failed to send voice buffer overrun event: {e}");
                        }
                    }
                }
            }
        }
    }

    /// Pop one sample from every non-empty per-peer buffer and return the
    /// saturated i16 sum. Returns 0 (silence) when all buffers are empty.
    fn pop_mixed_sample(&self) -> i16 {
        let mut bufs = self.buffers.lock();
        let mut sum: i32 = 0;
        for buf in bufs.iter_mut() {
            if let Some(s) = buf.pop_front() {
                sum += s as i32;
            }
        }
        sum.clamp(i16::MIN as i32, i16::MAX as i32) as i16
    }
}

/// Manages peer-to-peer voice chat over WebRTC audio tracks,
/// including mic capture and remote playback.
pub struct VoiceChat {
    conn: ConnectionManager,
    muted: Arc<AtomicBool>,
    local_track: Option<LocalAudioTrack>,
    peer_voices: Arc<Mutex<HashMap<String, PeerVoice>>>,
    events_tx: Arc<Mutex<Option<mpsc::Sender<VoiceEvent>>>>,
    _capture_handle: Mutex<Option<cpal::Stream>>,
    _playback_streams: Mutex<HashMap<String, cpal::Stream>>,
    /// Shared audio output buffer (decoders push, cpal callback pops)
    output_buffer: VoiceBuffer,
    /// The cpal output stream — kept alive here (must not be moved to another thread)
    _output_stream: Mutex<Option<cpal::Stream>>,
    /// Maps peer_id → per-peer buffer index inside `output_buffer`
    peer_buffer_indices: Mutex<HashMap<String, usize>>,
}

impl VoiceChat {
    pub fn new(conn: ConnectionManager) -> Self {
        let events_tx = Arc::new(Mutex::new(None));
        Self {
            conn,
            muted: Arc::new(AtomicBool::new(false)),
            local_track: None,
            peer_voices: Arc::new(Mutex::new(HashMap::new())),
            events_tx: events_tx.clone(),
            _capture_handle: Mutex::new(None),
            _playback_streams: Mutex::new(HashMap::new()),
            output_buffer: VoiceBuffer::new(96_000, events_tx), // 2 seconds at 48kHz
            _output_stream: Mutex::new(None),
            peer_buffer_indices: Mutex::new(HashMap::new()),
        }
    }

    pub fn is_muted(&self) -> bool {
        self.muted.load(Ordering::SeqCst)
    }

    pub fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::SeqCst);
        info!("Mic muted: {muted}");
        if let Some(tx) = self.events_tx.lock().as_ref() {
            if let Err(e) = tx.try_send(VoiceEvent::MuteChanged(muted)) {
                warn!("Failed to send mute changed event: {e}");
            }
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

    /// Start the shared output stream on the default audio device.
    /// Idempotent — safe to call multiple times.
    fn ensure_output_started(&self) -> Result<()> {
        let mut stream_guard = self._output_stream.lock();
        if stream_guard.is_some() {
            return Ok(());
        }

        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .context("No audio output device found")?;
        info!(
            "Voice output: {}",
            device.name().unwrap_or_else(|_| "unknown".into())
        );

        let config = cpal::StreamConfig {
            channels: 1,
            sample_rate: cpal::SampleRate(48000),
            buffer_size: cpal::BufferSize::Default,
        };

        let buf = self.output_buffer.clone();
        let stream = device.build_output_stream(
            &config,
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                for sample in data.iter_mut() {
                    *sample = buf.pop_mixed_sample() as f32 / 32768.0;
                }
            },
            move |err| {
                error!("Voice output error: {err}");
            },
            None,
        )?;

        stream.play()?;
        *stream_guard = Some(stream);
        info!("Voice output active (48kHz mono)");
        Ok(())
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
                            let sender = { e2.lock().clone() };
                            if let Some(tx) = sender {
                                if let Err(e) = tx.send(VoiceEvent::TrackAdded { peer_id }).await {
                                    warn!("Failed to send TrackAdded event: {e}");
                                }
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

    /// Calculate RMS (root mean square) energy of an f32 audio buffer.
    /// Used for voice activity detection — skip sending silence.
    fn rms_energy(data: &[f32]) -> f32 {
        if data.is_empty() {
            return 0.0;
        }
        let sum_sq: f32 = data.iter().map(|s| s * s).sum();
        (sum_sq / data.len() as f32).sqrt()
    }

    /// Start mic capture, returns event stream. Uses cpal for cross-platform audio.
    /// Only call once; subsequent calls return an error.
    ///
    /// Voice Activity Detection (VAD): audio frames with RMS energy below
    /// `VAD_ENERGY_THRESHOLD` are silently dropped to avoid wasting bandwidth
    /// on silence. Opus DTX handles the gaps gracefully.
    pub fn start_capture(&mut self) -> Result<mpsc::Receiver<VoiceEvent>> {
        if self._capture_handle.lock().is_some() {
            return Err(anyhow::anyhow!("Voice capture already started"));
        }
        let (tx, rx) = mpsc::channel(64);
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
                let num_samples = data.len();
                if num_samples == 0 {
                    return;
                }

                // VAD: skip silence to save bandwidth
                if VoiceChat::rms_energy(data) < VAD_ENERGY_THRESHOLD {
                    return;
                }

                let pcm: Vec<i16> = data
                    .iter()
                    .map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
                    .collect();
                // Calculate duration from actual sample count at 48kHz
                let duration_ms = (num_samples as f64 / 48.0) as u64;
                let sample = webrtc::media::Sample {
                    data: bytes::Bytes::from(bytemuck::cast_slice(&pcm).to_vec()),
                    duration: std::time::Duration::from_millis(duration_ms.max(1)),
                    ..Default::default()
                };
                #[allow(clippy::let_underscore_future)]
                {
                    let _ = track.write_sample(&sample);
                }
            },
            move |err| {
                error!("Voice capture error: {err}");
                if let Err(e) = tx_err.try_send(VoiceEvent::Error(format!("{err}"))) {
                    warn!("Failed to send voice capture error event: {e}");
                }
            },
            None,
        )?;

        stream.play()?;
        *self._capture_handle.lock() = Some(stream);
        info!("Voice capture active (48kHz mono, VAD threshold={VAD_ENERGY_THRESHOLD})");
        Ok(rx)
    }

    /// Handle a remote audio track from a peer.
    /// Uses a jitter buffer (AudioJitterBuffer) to reorder out-of-order RTP
    /// packets before decoding. Decoded PCM is pushed to the shared output mixer.
    pub fn handle_remote_track(&self, peer_id: &str, track: Arc<TrackRemote>) {
        let pid = peer_id.to_string();
        info!("Voice track received from {pid} — starting decode + playback");

        // Start output stream if this is the first remote track
        if let Err(e) = self.ensure_output_started() {
            error!("Failed to start voice output: {e}");
            if let Some(tx) = self.events_tx.lock().as_ref() {
                if let Err(e) = tx.try_send(VoiceEvent::Error(format!("Output init failed: {e}"))) {
                    warn!("Failed to send output init error event: {e}");
                }
            }
            return;
        }

        // Register peer voice metadata
        self.peer_voices
            .lock()
            .entry(pid.clone())
            .or_insert(PeerVoice {
                muted: false,
                speaking: true,
                track_id: Some("remote".into()),
            });
        if let Some(tx) = self.events_tx.lock().as_ref() {
            if let Err(e) = tx.try_send(VoiceEvent::TrackAdded {
                peer_id: pid.clone(),
            }) {
                warn!("Failed to send TrackAdded event for {pid}: {e}");
            }
        }

        let voices = self.peer_voices.clone();
        let ev_tx = self.events_tx.clone();
        let pid2 = pid.clone();
        let buf = self.output_buffer.clone();

        // Allocate a per-peer buffer slot so the mixer can sum contributions
        // from all peers instead of serializing playback.
        let peer_buf_idx = buf.add_peer_buffer();
        self.peer_buffer_indices
            .lock()
            .insert(pid.clone(), peer_buf_idx);

        // Jitter buffer: target 2 packets (~40ms) latency, max 16 queued (~320ms)
        let jitter = AudioJitterBuffer::new(2, 16);

        // Spawn a task to read RTP, reorder via jitter buffer, decode Opus → PCM,
        // and push to the per-peer buffer.
        // We only capture the VoiceBuffer (Send + Sync), not the cpal stream.
        tokio::spawn(async move {
            let mut decoder = match opus::Decoder::new(48000, opus::Channels::Mono) {
                Ok(d) => d,
                Err(e) => {
                    error!("Failed to create Opus decoder for {pid2}: {e}");
                    return;
                }
            };

            // Decode buffer: Opus max frame size at 48kHz mono is 5760 samples
            let mut pcm_buf = vec![0i16; 5760];

            loop {
                let (rtp_packet, _attrs) = match track.read_rtp().await {
                    Ok(p) => p,
                    Err(e) => {
                        warn!("Voice RTP read error from {pid2}: {e}");
                        break;
                    }
                };

                // Feed into jitter buffer for reordering
                jitter.insert(
                    rtp_packet.header.sequence_number,
                    rtp_packet.payload.to_vec(),
                );

                // Drain all ready packets from jitter buffer
                while let Some(payload) = jitter.pop_ready() {
                    // Update speaking indicator
                    {
                        let mut v = voices.lock();
                        if let Some(pv) = v.get_mut(&pid2) {
                            pv.speaking = true;
                        }
                    }
                    if let Some(tx) = ev_tx.lock().as_ref() {
                        if let Err(e) = tx.try_send(VoiceEvent::PeerSpeaking {
                            peer_id: pid2.clone(),
                            speaking: true,
                        }) {
                            warn!("Failed to send PeerSpeaking event for {pid2}: {e}");
                        }
                    }

                    // Decode Opus → PCM. FEC enabled for packet loss resilience.
                    match decoder.decode(&payload, &mut pcm_buf, true) {
                        Ok(n_samples) => {
                            if n_samples > 0 {
                                buf.push_samples(peer_buf_idx, &pcm_buf[..n_samples]);
                            }
                        }
                        Err(ref e) if e.code() == opus::ErrorCode::BufferTooSmall => {
                            warn!("Opus decode buffer too small for {pid2} — frame dropped");
                        }
                        Err(e) => {
                            warn!("Opus decode error from {pid2}: {e} — frame dropped");
                        }
                    }
                }
            }

            // Track ended — mark peer as no longer speaking
            {
                let mut v = voices.lock();
                if let Some(pv) = v.get_mut(&pid2) {
                    pv.speaking = false;
                }
            }
            if let Some(tx) = ev_tx.lock().as_ref() {
                if let Err(e) = tx.try_send(VoiceEvent::PeerSpeaking {
                    peer_id: pid2.clone(),
                    speaking: false,
                }) {
                    warn!("Failed to send PeerSpeaking(stop) event for {pid2}: {e}");
                }
            }
            info!("Voice track ended for {pid2}");
        });
    }

    pub fn stop(&self) {
        *self._capture_handle.lock() = None;
        self._playback_streams.lock().clear();
        // Drop the output stream to stop playback
        *self._output_stream.lock() = None;
        info!("Voice stopped");
    }
}

pub fn opus_codec_capability() -> RTCRtpCodecCapability {
    RTCRtpCodecCapability {
        mime_type: MIME_TYPE_OPUS.to_string(),
        clock_rate: 48000,
        channels: 1,
        sdp_fmtp_line: "minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0".to_string(),
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
