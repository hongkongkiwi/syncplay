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
    expect(
      getTransferDisplay({
        transferId: 'tx1',
        role: 'receiver',
        status: 'downloading',
        transferred: 25,
        size: 100,
        offset: 0
      })
    ).toMatchObject({
      label: 'Downloading',
      detail: '25% · 0.0 MB / 0.0 MB',
      progress: 0.25,
      canRetry: false
    });

    expect(
      getTransferDisplay({
        transferId: 'tx2',
        role: 'receiver',
        status: 'paused-source-offline',
        transferred: 64,
        size: 128,
        offset: 64,
        token: 'ticket'
      })
    ).toMatchObject({
      label: 'Paused',
      detail: 'The sender left. Retry after they reconnect.',
      canRetry: true
    });

    expect(
      getTransferDisplay({
        transferId: 'tx3',
        role: 'receiver',
        status: 'failed',
        transferred: 64,
        size: 128,
        offset: 64,
        token: 'ticket',
        errorMessage: 'Bad transfer frame magic'
      })
    ).toMatchObject({
      label: 'Failed',
      detail: 'Bad transfer frame magic',
      progress: 0.5,
      canRetry: true
    });
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
