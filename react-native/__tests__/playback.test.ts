import { parseTimestamp } from '../src/syncplay/playback';

describe('playback helpers', () => {
  it('parses desktop-style seek text', () => {
    expect(parseTimestamp('90')).toBe(90);
    expect(parseTimestamp('1:30')).toBe(90);
    expect(parseTimestamp('1:02:03')).toBe(3723);
    expect(parseTimestamp(' 00:01 ')).toBe(1);
  });

  it('rejects invalid seek text', () => {
    expect(parseTimestamp('')).toBeNull();
    expect(parseTimestamp('1:bogus')).toBeNull();
    expect(parseTimestamp('-2')).toBeNull();
    expect(parseTimestamp('1::02')).toBeNull();
  });
});
