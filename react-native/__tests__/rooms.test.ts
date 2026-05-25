import {
  addRoomToSavedList,
  buildRoomOptions,
  filterVisibleRooms,
  parseRoomEntry,
  resolveJoinRoomEntry
} from '../src/syncplay/rooms';

describe('room helpers', () => {
  it('parses managed room entries with an operator password', () => {
    expect(parseRoomEntry('+movie:abc123def456:AB-123-456')).toEqual({
      room: '+movie:abc123def456',
      password: 'AB-123-456',
      listValue: '+movie:abc123def456:AB-123-456'
    });
  });

  it('keeps ordinary room names as-is', () => {
    expect(parseRoomEntry('lobby')).toEqual({
      room: 'lobby',
      password: null,
      listValue: 'lobby'
    });
  });

  it('uses desktop blank-room fallback rules', () => {
    expect(resolveJoinRoomEntry('', 'movie.mkv', 'default')).toBe('movie.mkv');
    expect(resolveJoinRoomEntry('  ', null, 'default')).toBe('default');
  });

  it('adds saved rooms once and sorts them', () => {
    expect(addRoomToSavedList(['zeta', 'alpha'], 'beta')).toEqual(['alpha', 'beta', 'zeta']);
    expect(addRoomToSavedList(['alpha'], 'alpha')).toEqual(['alpha']);
    expect(addRoomToSavedList(['zeta', 'alpha'], '   ')).toEqual(['alpha', 'zeta']);
  });

  it('lists saved rooms before current server rooms', () => {
    expect(buildRoomOptions(['saved'], ['saved', 'lobby'])).toEqual(['saved', 'lobby']);
  });

  it('can hide empty persistent rooms', () => {
    expect(filterVisibleRooms({ empty: [], lobby: ['Aki'] }, true)).toEqual(['lobby']);
    expect(filterVisibleRooms({ empty: [], lobby: ['Aki'] }, false)).toEqual(['empty', 'lobby']);
  });
});
