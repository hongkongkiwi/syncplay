import type { RoomUser } from '../syncplay/state';

export type AutoPlayConfig = {
  enabled: boolean;
  threshold: number; // minimum users needed, default 2
};

export type AutoPlayState = {
  countdown: number | null; // seconds remaining (3, 2, 1) or null
  timerId: ReturnType<typeof setTimeout> | null;
};

export function createAutoPlayConfig(): AutoPlayConfig {
  return {
    enabled: false,
    threshold: 2
  };
}

export function createAutoPlayState(): AutoPlayState {
  return {
    countdown: null,
    timerId: null
  };
}

/**
 * Check if auto-play conditions are met:
 * - All users in the room are ready
 * - All users have the same file
 * - There are at least threshold users
 * - Auto-play is enabled
 */
export function shouldAutoPlay(
  roomUsers: RoomUser[],
  currentUser: string,
  autoPlayConfig: AutoPlayConfig
): boolean {
  if (!autoPlayConfig.enabled) {
    return false;
  }

  if (roomUsers.length < autoPlayConfig.threshold) {
    return false;
  }

  // Everyone must be ready
  const allReady = roomUsers.every(user => user.isReady === true);
  if (!allReady) {
    return false;
  }

  // Everyone must have a file
  const allHaveFile = roomUsers.every(user => user.file !== null);
  if (!allHaveFile) {
    return false;
  }

  // Everyone must have the same file name
  const firstFile = roomUsers[0]?.file?.name;
  if (!firstFile) {
    return false;
  }

  const sameFile = roomUsers.every(user => user.file?.name === firstFile);
  return sameFile;
}

/**
 * Start a countdown. Calls onTick every second (3, 2, 1).
 * When countdown reaches 0, calls onComplete and resets.
 * Returns a cleanup function.
 */
export function startAutoPlayCountdown(
  onTick: (remaining: number) => void,
  onComplete: () => void,
  durationSeconds = 3
): () => void {
  let remaining = durationSeconds;
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped) {
      return;
    }

    remaining -= 1;

    if (remaining <= 0) {
      clearInterval(timer);
      onComplete();
    } else {
      onTick(remaining);
    }
  }, 1000);

  // Fire immediately
  onTick(remaining);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
