// VoiceChat — P2P voice communication for Syncplay web client
// This is a skeleton/stub that shows the intended API.
// Production implementation details are documented inline.

import { P2PStateManager } from 'syncplay-p2p-client';

export class VoiceChat {
  private stateManager: P2PStateManager;
  private _capturing = false;
  // AudioContext, MediaStream, AudioWorklet references would live here in production
  // private audioContext: AudioContext | null = null;
  // private mediaStream: MediaStream | null = null;

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
   * To implement voice chat fully:
   * 1. navigator.mediaDevices.getUserMedia({ audio: true }) for mic capture
   * 2. AudioContext.createMediaStreamSource() for processing
   * 3. AudioWorklet or ScriptProcessorNode for Opus encoding
   * 4. Send encoded frames via a custom VoiceFrame message type on the data channel
   * 5. Receive frames and decode via AudioContext.decodeAudioData() + play
   */
  async startCapture(): Promise<void> {
    if (this._capturing) return;
    console.log('[VoiceChat] Voice capture would start here (needs getUserMedia + AudioContext + Opus encoder)');
    this._capturing = true;
    // Production:
    //   this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    //   this.audioContext = new AudioContext();
    //   const source = this.audioContext.createMediaStreamSource(this.mediaStream);
    //   // Connect source → Opus encoder worklet → data channel
    //   await this.audioContext.audioWorklet.addModule('/worklets/opus-encoder.js');
    //   const encoderNode = new AudioWorkletNode(this.audioContext, 'opus-encoder');
    //   encoderNode.port.onmessage = (e) => {
    //     // e.data contains encoded Opus frames — send via data channel
    //     // this.stateManager.sendVoiceFrame(e.data);
    //   };
    //   source.connect(encoderNode);
  }

  /**
   * Stop microphone capture.
   */
  stopCapture(): void {
    if (!this._capturing) return;
    this._capturing = false;
    // Production:
    //   this.mediaStream?.getTracks().forEach(t => t.stop());
    //   this.audioContext?.close();
    //   this.mediaStream = null;
    //   this.audioContext = null;
  }

  /**
   * Toggle mute state. Sends VoiceMute message through the state manager.
   */
  toggleMute(): void {
    this.stateManager.toggleMute();
  }
}

export default VoiceChat;
