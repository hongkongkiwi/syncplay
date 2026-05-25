import {
  assetToMediaLibraryItem,
  formatBytes,
  formatTime,
  getTransferDisplay,
  isManagedRoomName,
  isStreamUri,
  shouldAnnounceMediaOnConnection,
  shuffleFiles,
  statusLabel,
  stripManagedRoomName
} from '../src/app/appHelpers';
import type { TransferSession } from '../src/syncplay/fileTransfer';

describe('app helper functions', () => {
  it('detects stream URIs by scheme', () => {
    expect(isStreamUri('https://example.test/movie.mp4')).toBe(true);
    expect(isStreamUri('rtmp://example.test/live')).toBe(true);
    expect(isStreamUri('movie.mkv')).toBe(false);
  });

  it('recognizes and strips managed room names', () => {
    expect(isManagedRoomName('+movie:abc123def456')).toBe(true);
    expect(isManagedRoomName('movie')).toBe(false);
    expect(stripManagedRoomName('+movie:abc123def456')).toBe('movie');
    expect(stripManagedRoomName('movie')).toBe('movie');
  });

  it('converts document picker assets into media search items', () => {
    expect(
      assetToMediaLibraryItem({
        name: 'movie.mkv',
        uri: 'file:///movies/movie.mkv',
        size: 123,
        lastModified: 0
      })
    ).toEqual({
      name: 'movie.mkv',
      uri: 'file:///movies/movie.mkv',
      size: 123,
      duration: null,
      directory: null
    });
  });

  it('formats playback time and file size for compact UI labels', () => {
    expect(formatTime(65.8)).toBe('1:05');
    expect(formatTime(Number.NaN)).toBe('0:00');
    expect(formatBytes(0)).toBe('unknown size');
    expect(formatBytes(12 * 1024 * 1024)).toBe('12.0 MB');
    expect(formatBytes(140 * 1024 * 1024)).toBe('140 MB');
  });

  it('maps connection status to header text', () => {
    expect(statusLabel('connecting')).toBe('Connecting');
    expect(statusLabel('connected')).toBe('Connected');
    expect(statusLabel('disconnected')).toBe('Disconnected');
    expect(statusLabel('error')).toBe('Connection error');
    expect(statusLabel('idle')).toBe('Idle');
  });

  it('builds readable transfer labels, progress, and retry hints', () => {
    const baseTransfer: TransferSession = {
      transferId: 'tx1',
      role: 'receiver',
      status: 'downloading',
      transferred: 25,
      size: 100,
      offset: 0
    };
    const cases: Array<{ name: string; session: TransferSession; expected: ReturnType<typeof getTransferDisplay> }> = [
      {
        name: 'incoming approval request',
        session: {
          ...baseTransfer,
          status: 'incoming-request',
          transferred: 0,
          receiver: 'Alice',
          file: { name: 'movie.mkv', duration: 100, size: 100 }
        },
        expected: {
          label: 'Approval needed',
          detail: 'Alice wants movie.mkv.',
          progress: 0,
          canRetry: false
        }
      },
      {
        name: 'receiver socket opening',
        session: { ...baseTransfer, status: 'approved' },
        expected: {
          label: 'Connecting',
          detail: 'Opening the download socket.',
          progress: 0.25,
          canRetry: false
        }
      },
      {
        name: 'sender socket waiting',
        session: { ...baseTransfer, role: 'sender', status: 'approved' },
        expected: {
          label: 'Connecting',
          detail: 'Waiting for the receiver socket.',
          progress: 0.25,
          canRetry: false
        }
      },
      {
        name: 'active download',
        session: baseTransfer,
        expected: {
          label: 'Downloading',
          detail: '25% · 0.0 MB / 0.0 MB',
          progress: 0.25,
          canRetry: false
        }
      },
      {
        name: 'local pause',
        session: { ...baseTransfer, status: 'paused-local', transferred: 64, size: 128, offset: 64 },
        expected: {
          label: 'Paused',
          detail: 'Stopped at 50% · 0.0 MB / 0.0 MB.',
          progress: 0.5,
          canRetry: true
        }
      },
      {
        name: 'sender offline pause',
        session: { ...baseTransfer, status: 'paused-source-offline', transferred: 64, size: 128, offset: 64 },
        expected: {
          label: 'Paused',
          detail: 'The sender left. Retry after they reconnect.',
          progress: 0.5,
          canRetry: true
        }
      },
      {
        name: 'sender changed media pause',
        session: { ...baseTransfer, status: 'paused-source-changed-media', transferred: 64, size: 128, offset: 64 },
        expected: {
          label: 'Paused',
          detail: 'The sender changed files. Retry after they switch back.',
          progress: 0.5,
          canRetry: true
        }
      },
      {
        name: 'receiver offline pause',
        session: { ...baseTransfer, status: 'paused-receiver-offline', transferred: 64, size: 128, offset: 64 },
        expected: {
          label: 'Paused',
          detail: 'The receiver left. Retry after they reconnect.',
          progress: 0.5,
          canRetry: true
        }
      },
      {
        name: 'completed transfer',
        session: { ...baseTransfer, status: 'complete', completedPath: 'file:///downloads/movie.mkv' },
        expected: {
          label: 'Saved',
          detail: 'Saved to file:///downloads/movie.mkv',
          progress: 1,
          canRetry: false
        }
      },
      {
        name: 'cancelled transfer',
        session: { ...baseTransfer, status: 'cancelled', errorMessage: 'User stopped transfer.' },
        expected: {
          label: 'Cancelled',
          detail: 'User stopped transfer.',
          progress: 0.25,
          canRetry: false
        }
      },
      {
        name: 'failed transfer',
        session: { ...baseTransfer, status: 'failed', transferred: 64, size: 128, offset: 64, token: 'ticket', errorMessage: 'Bad transfer frame magic' },
        expected: {
          label: 'Failed',
          detail: 'Bad transfer frame magic',
          progress: 0.5,
          canRetry: true
        }
      },
      {
        name: 'unknown transfer status',
        session: { ...baseTransfer, status: 'mystery-status' } as unknown as TransferSession,
        expected: {
          label: 'mystery-status',
          detail: '25% · 0.0 MB / 0.0 MB',
          progress: 0.25,
          canRetry: false
        }
      }
    ];

    for (const { session, expected } of cases) {
      expect(getTransferDisplay(session)).toMatchObject(expected);
    }
  });

  it('announces already selected media when a socket connects', () => {
    const media = { name: 'movie.mkv', duration: 100, size: 123 };

    expect(shouldAnnounceMediaOnConnection(false, true, media)).toBe(true);
    expect(shouldAnnounceMediaOnConnection(true, true, media)).toBe(false);
    expect(shouldAnnounceMediaOnConnection(false, true, null)).toBe(false);
  });

  it('shuffles files with Fisher-Yates without mutating the input', () => {
    const files = ['one.mkv', 'two.mkv', 'three.mkv', 'four.mkv'];
    const randomValues = [0.1, 0.8, 0.2];
    const shuffled = shuffleFiles(files, () => randomValues.shift() ?? 0);

    expect(shuffled).toEqual(['two.mkv', 'four.mkv', 'three.mkv', 'one.mkv']);
    expect(files).toEqual(['one.mkv', 'two.mkv', 'three.mkv', 'four.mkv']);
  });
});
