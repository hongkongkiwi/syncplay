// VoiceChat — P2P voice communication for Syncplay React Native
// Implemented using expo-av Audio.Recording + Audio.Sound
//
// Recording: polls Audio.Recording every 500ms for duration,
// every 2 seconds stops, reads base64, sends via P2PStateManager,
// and starts a new recording.
//
// Playback: each incoming VoiceFrame is written to a temp file
// and played via Audio.Sound.

import { Audio } from 'expo-av';
import { File, Paths } from 'expo-file-system';
import type { P2PStateManager } from 'syncplay-p2p-client';

// ── VoiceChat ────────────────────────────────────────────────────────────────

export class VoiceChat {
  private recording: Audio.Recording | null = null;
  private sound: Audio.Sound | null = null;
  private stateManager: P2PStateManager;
  private _muted = false;
  private _capturing = false;
  private _permission = false;
  private _captureInterval: ReturnType<typeof setInterval> | null = null;
  private _lastSendTime = 0;
  private _seq = 0;

  // Playback state
  private _isPlaying = false;
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
   * Start capturing microphone audio via expo-av polling.
   *
   * 1. Request permission
   * 2. Set audio mode for recording
   * 3. Create recording and prepare with HIGH quality
   * 4. Start recording
   * 5. Poll getStatusAsync() every 500ms for duration
   * 6. Every 2 seconds: stop, get URI, read base64, send, restart
   */
  async startCapture(): Promise<void> {
    if (this._capturing) return;

    // 1. Request permission
    if (!this._permission) {
      const granted = await this.requestPermission();
      if (!granted) return;
    }

    try {
      // 2. Set audio mode for recording
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      this._capturing = true;
      this._seq = 0;
      this._lastSendTime = Date.now();

      // 3. Create + prepare + start recording
      await this._startNewRecording();

      // 4. Poll getStatusAsync() every 500ms for duration;
      //    every 2 seconds, drain and restart
      this._captureInterval = setInterval(async () => {
        if (!this._capturing) return;

        try {
          // 5. Poll status for duration
          if (this.recording) {
            const status = await this.recording.getStatusAsync();
            const durationMs = status.durationMillis ?? 0;
            const elapsed = Date.now() - this._lastSendTime;

            // 6. Every 2 seconds: stop, read base64, send, restart
            if (elapsed >= 2000 && durationMs >= 500) {
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

      console.log('[VoiceChat] Voice capture started (2s segments)');
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
   */
  async playAudioUrl(uri: string): Promise<void> {
    try {
      // 1. Unload existing sound
      if (this.sound) {
        await this.sound.unloadAsync().catch(() => {});
        this.sound = null;
      }

      // 2. Create new Audio.Sound and load from URI
      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: false },
      );
      this.sound = sound;

      // 3. Play
      await sound.playAsync();

      // Clean up after playback finishes
      sound.setOnPlaybackStatusUpdate((status: any) => {
        if (status.didJustFinish) {
          sound.unloadAsync().catch(() => {});
          this.sound = null;
        }
      });
    } catch (err) {
      console.error('[VoiceChat] playAudioUrl error:', err);
    }
  }

  /**
   * Play audio from a base64-encoded string.
   * Writes to temp file, then delegates to playAudioUrl.
   */
  async playAudioBase64(base64: string): Promise<void> {
    try {
      // Write to temp file using new expo-file-system API (SDK 56+)
      const fileIdx = this._playbackFileIdx++;
      const fileName = 'syncplay_voice_play_' + fileIdx + '.audio';

      const file = new File(Paths.cache, fileName);
      file.create({ overwrite: true });
      file.write(base64, { encoding: 'base64' });

      // Play via URL
      await this.playAudioUrl(file.uri);
    } catch (err) {
      console.error('[VoiceChat] playAudioBase64 error:', err);
    }
  }

  /**
   * Toggle mute state. Returns the new mute state.
   */
  toggleMute(): boolean {
    this._muted = !this._muted;
    // Notify state manager of mute change
    if (this.stateManager?.sendVoiceMute) {
      this.stateManager.sendVoiceMute(this._muted);
    }
    return this._muted;
  }

  /**
   * Clean up all resources: stop capture, unload sounds, clear timers.
   */
  destroy(): void {
    this.stopCapture().catch(() => {});
    if (this.sound) {
      this.sound.unloadAsync().catch(() => {});
      this.sound = null;
    }
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
   */
  handleIncomingFrame(data: Uint8Array, from: string): void {
    // Convert Uint8Array → base64
    const binary = String.fromCharCode(...data);
    const base64 = this._btoa(binary);

    this.playAudioBase64(base64).catch((err) => {
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
        try { file.delete(); } catch {}
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
