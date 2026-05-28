import {
  createPersistedPreferences,
  parsePersistedPreferences,
  serializePersistedPreferences
} from '../src/app/preferences';

describe('persisted preferences', () => {
  it('round-trips setup state', () => {
    const preferences = createPersistedPreferences({
      form: {
        serverAddress: 'syncplay.pl:8999',
        username: 'Mobile',
        room: 'default',
        password: 'room-secret',
        useTls: true
      },
      savedRooms: ['default'],
      mediaLibrary: [
        {
          name: 'movie.mkv',
          uri: 'file:///movie.mkv',
          size: 1,
          duration: null,
          directory: 'Movies'
        }
      ],
      controlPasswords: { '+room:abc123def456': 'AB-123-456' },
      autosaveJoinedRooms: true,
      hideEmptyRooms: false,
      syncPaused: false,
      autoReconnect: true,
      autoFileSwitch: true,
      keepPlayingInBackground: true,
      privacyMode: 'full',
      autoPlayEnabled: false,
      autoPlayThreshold: 2,
      timeOffset: 0,
      loopMode: 'none'
    });

    expect(preferences.form.password).toBe('');
    expect(parsePersistedPreferences(serializePersistedPreferences(preferences))).toEqual(preferences);
  });

  it('drops passwords from older saved state', () => {
    const saved = JSON.stringify({
      version: 1,
      form: {
        serverAddress: 'syncplay.pl:8999',
        username: 'Mobile',
        room: 'default',
        password: 'old-secret',
        useTls: true
      }
    });

    expect(parsePersistedPreferences(saved)?.form.password).toBe('');
  });

  it('rejects malformed persisted state', () => {
    expect(parsePersistedPreferences('not-json')).toBeNull();
    expect(parsePersistedPreferences(JSON.stringify({ version: 999 }))).toBeNull();
  });
});
