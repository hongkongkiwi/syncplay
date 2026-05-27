export type SyncCorrectionInput = {
  hasMedia: boolean;
  syncPaused: boolean;
  localPosition: number;
  remotePosition: number;
  remotePaused: boolean;
  localPlaying: boolean;
  doSeek: boolean;
};

export type SyncCorrection = {
  seekTo?: number;
  rate: number;
  shouldPause?: boolean;
  shouldPlay?: boolean;
};

const HARD_SEEK_DRIFT_SECONDS = 3;
const RATE_CORRECTION_DRIFT_SECONDS = 0.35;
const CATCH_UP_RATE = 1.04;
const SLOW_DOWN_RATE = 0.96;

export function calculateSyncCorrection(input: SyncCorrectionInput): SyncCorrection {
  if (!input.hasMedia || input.syncPaused) {
    return { rate: 1 };
  }

  const drift = input.remotePosition - input.localPosition;
  const correction: SyncCorrection = { rate: 1 };

  if (input.doSeek || Math.abs(drift) > HARD_SEEK_DRIFT_SECONDS) {
    correction.seekTo = input.remotePosition;
  } else if (!input.remotePaused && Math.abs(drift) > RATE_CORRECTION_DRIFT_SECONDS) {
    correction.rate = drift > 0 ? CATCH_UP_RATE : SLOW_DOWN_RATE;
  }

  if (input.remotePaused && input.localPlaying) {
    correction.shouldPause = true;
  } else if (!input.remotePaused && !input.localPlaying) {
    correction.shouldPlay = true;
  }

  return correction;
}
