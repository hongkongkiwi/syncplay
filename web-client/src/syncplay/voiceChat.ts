// VoiceChat — WebRTC-compatible voice using MediaRecorder (Opus) + AudioContext playback
// Sends VoiceFrame messages through the P2PStateManager's transport layer.

import { P2PStateManager, MessageType } from 'syncplay-p2p-client';

export class VoiceChat {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private audioCtx: AudioContext | null = null;
  private stateManager: P2PStateManager;
  private _muted = false;
  private _active = false;
  private seq = 0;

  constructor(stateManager: P2PStateManager) {
    this.stateManager = stateManager;

    // Wire incoming voice frames from the state manager
    stateManager.onVoiceFrame = async (data: Uint8Array, from: string) => {
      if (from === stateManager.myUsername) return; // skip self
      await this.playAudioChunk(data);
    };
  }

  get isMuted(): boolean { return this._muted; }
  get isActive(): boolean { return this._active; }

  async startCapture(): Promise<void> {
    if (this._active) return;
    try {
      // 1. Get microphone
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      // 2. Create MediaRecorder with Opus codec
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      this.recorder = new MediaRecorder(this.stream, { mimeType });

      // 3. Handle audio data — send via data channel
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

      // 4. Start recording with 40ms timeslices for low latency
      this.recorder.start(40);

      // 5. Create AudioContext for playback
      if (!this.audioCtx) {
        this.audioCtx = new AudioContext({ sampleRate: 16000 });
      }

      this._active = true;
      this._muted = false;
      console.log('[VoiceChat] Capture started (Opus, 16kHz mono, 40ms frames)');
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

  async playAudioChunk(data: Uint8Array): Promise<void> {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext({ sampleRate: 16000 });
    }
    try {
      // MediaRecorder Opus output → decode via AudioContext
      const audioBuffer = await this.audioCtx.decodeAudioData(data.buffer.slice(0) as ArrayBuffer);
      const source = this.audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioCtx.destination);
      source.start(0);
    } catch (e) {
      // decodeAudioData may fail on partial Opus frames — skip
      console.warn('[VoiceChat] Playback decode error:', e);
    }
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
  }
}
