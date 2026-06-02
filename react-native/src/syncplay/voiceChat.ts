// VoiceChat — P2P voice communication for Syncplay React Native
// This is a skeleton/stub that shows the intended API.
// Production implementation details are documented inline.

import { P2PStateManager } from './connectionV2';

export class VoiceChat {
  private stateManager: P2PStateManager;
  private _capturing = false;
  // Audio recording references would live here in production
  // private recording: Audio.Recording | null = null;

  constructor(stateManager: P2PStateManager) {
    this.stateManager = stateManager;
  }

  get isMuted(): boolean {
    // Delegate to the state manager which tracks per-peer mute state
    return this.stateManager.getSnapshot().readyStates[this.stateManager.myUsername + '_mute'] ?? false;
  }

  /**
   * Start capturing microphone audio.
   *
   * To implement voice chat on React Native:
   * 1. Use expo-av or react-native-audio for microphone capture
   * 2. Opus encoding via a native module or WebAssembly
   * 3. Send encoded frames via data channel
   * 4. Receive and play via expo-av Audio.Sound
   */
  async startCapture(): Promise<void> {
    if (this._capturing) return;
    console.log('[VoiceChat] Voice capture would start here (needs expo-av/recording + Opus encoder)');
    this._capturing = true;
    // Production:
    //   const { Audio } = require('expo-av');
    //   const { recording } = await Audio.requestPermissionsAsync();
    //   -- OR --
    //   import AudioRecord from 'react-native-audio-record';
    //   const options = { sampleRate: 48000, channels: 1, bitsPerSample: 16, audioSource: 6 };
    //   AudioRecord.init(options);
    //   AudioRecord.on('data', (data: ArrayBuffer) => {
    //     // Encode to Opus and send via data channel
    //   });
    //   AudioRecord.start();
  }

  /**
   * Stop microphone capture.
   */
  stopCapture(): void {
    if (!this._capturing) return;
    this._capturing = false;
    // Production:
    //   AudioRecord.stop();
    //   -- or --
    //   recording?.stopAndUnloadAsync();
  }

  /**
   * Toggle mute state. Sends VoiceMute message through the state manager.
   */
  toggleMute(): void {
    this.stateManager.toggleMute();
  }
}

export default VoiceChat;
