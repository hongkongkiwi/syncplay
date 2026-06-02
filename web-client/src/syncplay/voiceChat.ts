// VoiceChat — WebRTC-compatible voice using MediaRecorder (Opus) + AudioContext playback
// Sends VoiceFrame messages through the P2PStateManager's transport layer.
//
// Recording: MediaRecorder with Opus codec, 48kHz mono (fallback to 16kHz).
// Playback:  AudioContext with decodeAudioData for WebM Opus chunks.
//            Multiple remote streams mix naturally via Web Audio API graph.
//            Per-peer gain control for volume balancing.

import { P2PStateManager } from 'syncplay-p2p-client';

// ── Audio Quality Configuration ──────────────────────────────────────────────

interface VoiceConfig {
  sampleRate: number;
  channelCount: number;
  timesliceMs: number;       // MediaRecorder timeslice interval
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

// Prefer 48kHz for superior Opus quality; fall back to 16kHz if unavailable
const VOICE_CONFIG_48K: VoiceConfig = {
  sampleRate: 48000,
  channelCount: 1,
  timesliceMs: 40,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

const VOICE_CONFIG_16K: VoiceConfig = {
  sampleRate: 16000,
  channelCount: 1,
  timesliceMs: 40,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

// ── Per-peer playback state ──────────────────────────────────────────────────

interface PeerAudio {
  gainNode: GainNode;
  lastActivity: number;
}

// ── VoiceChat ────────────────────────────────────────────────────────────────

export class VoiceChat {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private audioCtx: AudioContext | null = null;
  private stateManager: P2PStateManager;
  private _muted = false;
  private _active = false;
  private seq = 0;
  private config: VoiceConfig;

  // Per-peer gain nodes for volume control
  private peers: Map<string, PeerAudio> = new Map();

  constructor(stateManager: P2PStateManager) {
    this.stateManager = stateManager;
    this.config = VOICE_CONFIG_48K; // prefer 48kHz

    // Wire incoming voice frames from the state manager
    stateManager.onVoiceFrame = async (data: Uint8Array, from: string) => {
      if (from === stateManager.myUsername) return; // skip self
      await this.playAudioChunk(data, from);
    };
  }

  get isMuted(): boolean { return this._muted; }
  get isActive(): boolean { return this._active; }

  async startCapture(): Promise<void> {
    if (this._active) return;
    try {
      // Try 48kHz first, fall back to 16kHz
      let stream: MediaStream | null = null;
      let effectiveConfig = this.config;

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: this.config.channelCount,
            sampleRate: this.config.sampleRate,
            echoCancellation: this.config.echoCancellation,
            noiseSuppression: this.config.noiseSuppression,
            autoGainControl: this.config.autoGainControl,
          },
        });
      } catch {
        console.warn('[VoiceChat] 48kHz not supported, falling back to 16kHz');
        this.config = VOICE_CONFIG_16K;
        effectiveConfig = this.config;
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: this.config.channelCount,
            sampleRate: this.config.sampleRate,
            echoCancellation: this.config.echoCancellation,
            noiseSuppression: this.config.noiseSuppression,
            autoGainControl: this.config.autoGainControl,
          },
        });
      }

      this.stream = stream;

      // Create MediaRecorder with Opus codec
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      this.recorder = new MediaRecorder(this.stream, { mimeType });

      // Handle audio data — send via data channel
      this.recorder.ondataavailable = async (event: BlobEvent) => {
        if (!this._active || this._muted || event.data.size === 0) return;
        try {
          const buf = await event.data.arrayBuffer();
          const bytes = new Uint8Array(buf);
          this.stateManager.sendVoiceFrame(bytes, ++this.seq);
        } catch (e) {
          console.warn('[VoiceChat] send error:', e);
        }
      };

      // Start recording with configurable timeslice for low latency
      this.recorder.start(effectiveConfig.timesliceMs);

      // Create AudioContext for playback (match capture sample rate)
      if (!this.audioCtx) {
        this.audioCtx = new AudioContext({ sampleRate: effectiveConfig.sampleRate });
      }

      this._active = true;
      this._muted = false;
      console.log(
        `[VoiceChat] Capture started (Opus, ${effectiveConfig.sampleRate / 1000}kHz mono, ` +
        `${effectiveConfig.timesliceMs}ms frames, AGC+EC+NS)`
      );
    } catch (e) {
      console.error('[VoiceChat] Failed to start capture:', e);
      throw e;
    }
  }

  stopCapture(): void {
    this._active = false;
    try { this.recorder?.stop(); } catch { /* ok */ }
    try { this.stream?.getTracks().forEach(t => t.stop()); } catch { /* ok */ }
    this.recorder = null;
    this.stream = null;
    console.log('[VoiceChat] Capture stopped');
  }

  /**
   * Play an incoming Opus WebM chunk for a specific peer.
   * Uses Web Audio API for natural multi-stream mixing.
   * Each peer gets its own GainNode for volume control.
   */
  async playAudioChunk(data: Uint8Array, peerId: string): Promise<void> {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext({ sampleRate: this.config.sampleRate });
    }

    // Ensure per-peer gain node exists
    if (!this.peers.has(peerId)) {
      const gainNode = this.audioCtx.createGain();
      gainNode.gain.value = 1.0; // unity gain — adjust per peer as needed
      gainNode.connect(this.audioCtx.destination);
      this.peers.set(peerId, { gainNode, lastActivity: Date.now() });
    }

    const peer = this.peers.get(peerId)!;
    peer.lastActivity = Date.now();

    try {
      // Copy data to avoid detached buffer issues
      const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

      // decodeAudioData for WebM Opus chunks.
      // Note: Individual MediaRecorder timeslices produce standalone WebM containers
      // that decodeAudioData can process. If partial chunks fail, they are silently dropped.
      const audioBuffer = await this.audioCtx.decodeAudioData(buffer as ArrayBuffer);
      const source = this.audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(peer.gainNode);
      source.start(0);

      // Clean up source node after playback
      source.onended = () => {
        source.disconnect();
      };
    } catch (e) {
      // decodeAudioData may fail on partial or malformed Opus frames — skip
      console.warn('[VoiceChat] Playback decode error:', e);
    }
  }

  /**
   * Set gain (volume) for a specific peer. Range 0.0 - 2.0.
   */
  setPeerGain(peerId: string, gain: number): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.gainNode.gain.value = Math.max(0, Math.min(2, gain));
    }
  }

  /**
   * Get a list of active peer IDs (with audio in the last 5 seconds).
   */
  get activePeers(): string[] {
    const now = Date.now();
    const result: string[] = [];
    for (const [id, peer] of this.peers) {
      if (now - peer.lastActivity < 5000) {
        result.push(id);
      }
    }
    return result;
  }

  toggleMute(): boolean {
    this._muted = !this._muted;
    if (this.recorder) {
      if (this._muted) {
        this.recorder.pause();
      } else {
        this.recorder.resume();
      }
    }
    this.stateManager.sendVoiceMute(this._muted);
    return this._muted;
  }

  destroy(): void {
    this.stopCapture();
    try { this.audioCtx?.close(); } catch { /* ok */ }
    this.audioCtx = null;
    this.peers.clear();
  }
}
