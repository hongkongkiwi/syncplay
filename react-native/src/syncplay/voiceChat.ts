// VoiceChat — P2P voice communication for Syncplay React Native
// Implemented using expo-av Audio.Recording + Audio.Sound
//
// Recording: uses Audio.Recording with explicit quality settings.
// Polls getStatusAsync every 500ms; every 1s segment is drained and sent.
//
// Playback: each peer gets a dedicated Audio.Sound instance for mixing.
// Incoming VoiceFrames are written to temp files and played via Audio.Sound.

import { Audio } from 'expo-av';
import { File, Paths } from 'expo-file-system';
import type { P2PStateManager } from 'syncplay-p2p-client';

// ── Types ────────────────────────────────────────────────────────────────────

interface PeerPlayback {
  sound: Audio.Sound | null;
  seq: number; // last sequence number received (for ordering)
}

// ── VoiceChat ────────────────────────────────────────────────────────────────

export class VoiceChat {
  private recording: Audio.Recording | null = null;
  private stateManager: P2PStateManager;
  private _muted = false;
  private _capturing = false;
  private _permission = false;
  private _captureInterval: ReturnType<typeof setInterval> | null = null;
  private _lastSendTime = 0;
  private _seq = 0;

  // Per-peer playback state for mixing multiple remote streams
  private _peers: Map<string, PeerPlayback> = new Map();
  private _playbackFileIdx = 0;

  constructor(stateManager: any) {
    this.stateManager = stateManager;
    // Hook into incoming VoiceFrame dispatch on the state manager
    this.stateManager.onVoiceFrame = this.handleIncomingFrame.bind(this);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get isMuted(): boolean {
    return this._muted;
  }

  async requestPermission(): Promise<boolean> {
    try {
      const perm = await Audio.requestPermissionsAsync();
      this._permission = perm.granted;
      if (!this._permission) {
        console.warn('[VoiceChat] Audio recording permission denied');
      }
      return this._permission;
    } catch (err) {
      console.error('[VoiceChat] Failed to request permission:', err);
      this._permission = false;
      return false;
    }
  }

  /**
   * Start capturing microphone audio via expo-av.
   *
   * 1. Request permission
   * 2. Configure audio mode for voice chat (Bluetooth, speaker, interruptions)
   * 3. Create recording with explicit HIGH_QUALITY settings
   * 4. Start recording
   * 5. Poll getStatusAsync() every 500ms
   * 6. Every 1s: drain segment, send via P2PStateManager, restart
   */
  async startCapture(): Promise<void> {
    if (this._capturing) return;

    // 1. Request permission
    if (!this._permission) {
      const granted = await this.requestPermission();
      if (!granted) return;
    }

    try {
      // 2. Configure audio mode for voice chat
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        interruptionModeIOS: 2, // InterruptionModeIOS.DuckOthers
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });

      this._capturing = true;
      this._seq = 0;
      this._lastSendTime = Date.now();

      // 3. Create + prepare + start recording
      await this._startNewRecording();

      // 4. Poll getStatusAsync() every 500ms.
      //    Every 1 second: drain segment, send, restart.
      this._captureInterval = setInterval(async () => {
        if (!this._capturing) return;

        try {
          if (this.recording) {
            const status = await this.recording.getStatusAsync();
            const durationMs = status.durationMillis ?? 0;
            const elapsed = Date.now() - this._lastSendTime;

            // 1000ms segments for lower latency (was 2000ms)
            if (elapsed >= 1000 && durationMs >= 500) {
              await this._drainAndRestartRecording();
            }
          }
        } catch (err) {
          console.error('[VoiceChat] Polling error:', err);
          // Attempt recovery: restart recording
          await this._stopCurrentRecording();
          await this._startNewRecording();
        }
      }, 500);

      console.log('[VoiceChat] Voice capture started (1s segments, 48kHz)');
    } catch (err) {
      console.error('[VoiceChat] Failed to start capture:', err);
      this._capturing = false;
    }
  }

  /**
   * Stop microphone capture, clear the polling timer, and unload any
   * in-progress recording.
   */
  async stopCapture(): Promise<void> {
    if (!this._capturing) return;
    this._capturing = false;

    if (this._captureInterval !== null) {
      clearInterval(this._captureInterval);
      this._captureInterval = null;
    }

    await this._stopCurrentRecording();
    console.log('[VoiceChat] Voice capture stopped');
  }

  /**
   * Play audio from a file URI via expo-av Audio.Sound.
   * Used internally by per-peer playback pipeline.
   */
  async playAudioUrl(uri: string, peerId: string): Promise<void> {
    try {
      // Unload existing sound for this peer (replaced by new segment)
      const peer = this._peers.get(peerId);
      if (peer?.sound) {
        await peer.sound.unloadAsync().catch((err) => {
          console.warn('[VoiceChat] Failed to unload prior sound for', peerId, ':', err);
        });
        peer.sound = null;
      }

      // Create new Audio.Sound and load from URI
      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: false, volume: 1.0 },
      );
      this._peers.set(peerId, { sound, seq: this._seq });

      // Play the sound — multiple peers can play simultaneously
      await sound.playAsync();

      // Clean up after playback finishes
      sound.setOnPlaybackStatusUpdate((status: any) => {
        if (status.didJustFinish) {
          sound.unloadAsync().catch((err) => {
            console.warn('[VoiceChat] Failed to unload finished sound:', err);
          });
          const p = this._peers.get(peerId);
          if (p?.sound === sound) {
            p.sound = null;
          }
        }
      });
    } catch (err) {
      console.error('[VoiceChat] playAudioUrl error:', err);
    }
  }

  /**
   * Play audio from a base64-encoded string for a specific peer.
   * Writes to temp file, then delegates to playAudioUrl.
   */
  async playAudioBase64(base64: string, peerId: string): Promise<void> {
    try {
      const fileIdx = this._playbackFileIdx++;
      const fileName = `syncplay_voice_${peerId}_${fileIdx}.audio`;

      const file = new File(Paths.cache, fileName);
      file.create({ overwrite: true });
      file.write(base64, { encoding: 'base64' });

      // Play via URL with peer-specific mixing
      await this.playAudioUrl(file.uri, peerId);
    } catch (err) {
      console.error('[VoiceChat] playAudioBase64 error:', err);
    }
  }

  /**
   * Toggle mute state. Returns the new mute state.
   */
  toggleMute(): boolean {
    this._muted = !this._muted;
    if (this.stateManager?.sendVoiceMute) {
      this.stateManager.sendVoiceMute(this._muted);
    }
    return this._muted;
  }

  /**
   * Clean up all resources: stop capture, unload all peer sounds, clear timers.
   */
  destroy(): void {
    this.stopCapture().catch((err) => {
      console.warn('[VoiceChat] Failed to stop capture during destroy:', err);
    });

    // Unload all peer playback instances
    for (const [peerId, peer] of this._peers) {
      if (peer.sound) {
        peer.sound.unloadAsync().catch((err) => {
          console.warn(`[VoiceChat] Failed to unload sound for ${peerId}:`, err);
        });
      }
    }
    this._peers.clear();

    // Remove the voice frame handler
    if (this.stateManager) {
      this.stateManager.onVoiceFrame = null;
    }
    console.log('[VoiceChat] Destroyed');
  }

  // ── Incoming frame handler ─────────────────────────────────────────────────

  /**
   * Handle an incoming VoiceFrame from a remote peer.
   * Converts Uint8Array to base64 and queues for playback.
   *
   * Uses a TextDecoder-safe approach to avoid call stack overflow
   * from String.fromCharCode(...largeArray).
   */
  handleIncomingFrame(data: Uint8Array, from: string): void {
    // Convert Uint8Array → base64 safely (no call stack overflow)
    const base64 = this._uint8ToBase64(data);

    this.playAudioBase64(base64, from).catch((err) => {
      console.error('[VoiceChat] handleIncomingFrame playback error:', err);
    });
  }

  // ── Private: recording helpers ─────────────────────────────────────────────

  private async _startNewRecording(): Promise<void> {
    try {
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY,
      );
      await rec.startAsync();
      this.recording = rec;
    } catch (err) {
      console.error('[VoiceChat] Failed to start recording segment:', err);
      this.recording = null;
    }
  }

  private async _stopCurrentRecording(): Promise<string | null> {
    const rec = this.recording;
    this.recording = null;
    if (!rec) return null;

    try {
      await rec.stopAndUnloadAsync();
      const uri = rec.getURI();
      return uri ?? null;
    } catch (err) {
      console.error('[VoiceChat] Failed to stop recording:', err);
      return null;
    }
  }

  private async _drainAndRestartRecording(): Promise<void> {
    const uri = await this._stopCurrentRecording();
    if (uri) {
      try {
        // Read file as ArrayBuffer directly (avoids base64 → binary string → byte loop)
        const file = new File(uri);
        const buf = await file.arrayBuffer();

        // Send via state manager
        if (this.stateManager?.sendVoiceFrame) {
          this.stateManager.sendVoiceFrame(new Uint8Array(buf), this._seq++);
        }

        // Clean up temp file
        try { file.delete(); } catch { /* ignore */ }
      } catch (err) {
        console.error('[VoiceChat] Failed to read/send recording:', err);
      }
    }

    this._lastSendTime = Date.now();
    if (this._capturing) {
      await this._startNewRecording();
    }
  }

  // ── Private: base64 helpers ────────────────────────────────────────────────

  /**
   * Convert Uint8Array to base64 without call stack overflow.
   * Processes data in 16KB chunks using String.fromCharCode.
   */
  private _uint8ToBase64(data: Uint8Array): string {
    const CHUNK_SIZE = 16384; // 16KB chunks to avoid call stack overflow
    let binary = '';
    for (let i = 0; i < data.length; i += CHUNK_SIZE) {
      const chunk = data.subarray(i, Math.min(i + CHUNK_SIZE, data.length));
      binary += String.fromCharCode(...chunk);
    }
    return this._btoa(binary);
  }

  /** Decode base64 → binary string. */
  private _atob(input: string): string {
    if (typeof atob === 'function') return atob(input);
    try {
      const { Buffer } = require('buffer');
      return Buffer.from(input, 'base64').toString('binary');
    } catch {
      const chars =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
      let output = '';
      let i = 0;
      while (i < input.length) {
        const enc1 = chars.indexOf(input.charAt(i++));
        const enc2 = chars.indexOf(input.charAt(i++));
        const enc3 = chars.indexOf(input.charAt(i++));
        const enc4 = chars.indexOf(input.charAt(i++));
        const chr1 = (enc1 << 2) | (enc2 >> 4);
        const chr2 = ((enc2 & 15) << 4) | (enc3 >> 2);
        const chr3 = ((enc3 & 3) << 6) | enc4;
        output += String.fromCharCode(chr1);
        if (enc3 !== 64) output += String.fromCharCode(chr2);
        if (enc4 !== 64) output += String.fromCharCode(chr3);
      }
      return output;
    }
  }

  /** Encode binary string → base64. */
  private _btoa(input: string): string {
    if (typeof btoa === 'function') return btoa(input);
    try {
      const { Buffer } = require('buffer');
      return Buffer.from(input, 'binary').toString('base64');
    } catch {
      const chars =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      let output = '';
      for (let i = 0; i < input.length; i += 3) {
        const a = input.charCodeAt(i);
        const b = i + 1 < input.length ? input.charCodeAt(i + 1) : NaN;
        const c = i + 2 < input.length ? input.charCodeAt(i + 2) : NaN;
        const b1 = a >> 2;
        const b2 = ((a & 3) << 4) | (b >> 4);
        const b3 = isNaN(b) ? 64 : ((b & 15) << 2) | (c >> 6);
        const b4 = isNaN(c) ? 64 : c & 63;
        output += chars.charAt(b1) + chars.charAt(b2);
        output += isNaN(b) ? '=' : chars.charAt(b3);
        output += isNaN(c) ? '=' : chars.charAt(b4);
      }
      return output;
    }
  }
}

export default VoiceChat;
