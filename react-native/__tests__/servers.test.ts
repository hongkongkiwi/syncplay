import {
  PUBLIC_SERVER_OPTIONS,
  formatServerAddress,
  parseServerAddress
} from '../src/syncplay/servers';

describe('server address helpers', () => {
  it('matches the desktop public server defaults', () => {
    expect(PUBLIC_SERVER_OPTIONS.map(option => option.address)).toEqual([
      'syncplay.pl:8995',
      'syncplay.pl:8996',
      'syncplay.pl:8997',
      'syncplay.pl:8998',
      'syncplay.pl:8999'
    ]);
  });

  it('parses manual host and port entries', () => {
    expect(parseServerAddress('syncplay.pl:8995')).toEqual({
      host: 'syncplay.pl',
      port: 8995
    });
  });

  it('accepts a scheme and path around manual entries', () => {
    expect(parseServerAddress('tcp://example.test:12000/room')).toEqual({
      host: 'example.test',
      port: 12000
    });
  });

  it('uses port 8999 when the manual entry only has a host', () => {
    expect(parseServerAddress('lan-box')).toEqual({
      host: 'lan-box',
      port: 8999
    });
  });

  it('parses IPv6 host entries', () => {
    expect(parseServerAddress('[2001:db8::1]:8998')).toEqual({
      host: '[2001:db8::1]',
      port: 8998
    });
    expect(parseServerAddress('2001:db8::1')).toEqual({
      host: '[2001:db8::1]',
      port: 8999
    });
  });

  it('ignores whitespace around manual server entries', () => {
    expect(parseServerAddress(' syncplay.pl : 8997 ')).toEqual({
      host: 'syncplay.pl',
      port: 8997
    });
  });

  it('formats selected values back into the manual field', () => {
    expect(formatServerAddress({ host: 'syncplay.pl', port: 8996 })).toBe('syncplay.pl:8996');
  });

  it('rejects missing hosts and invalid ports', () => {
    expect(parseServerAddress(':8999')).toBeNull();
    expect(parseServerAddress('syncplay.pl:abc')).toBeNull();
    expect(parseServerAddress('syncplay.pl:70000')).toBeNull();
    expect(parseServerAddress('[2001:db8::1')).toBeNull();
    expect(parseServerAddress('[2001:db8::1]8999')).toBeNull();
    expect(parseServerAddress('tcp://')).toBeNull();
    expect(parseServerAddress('')).toBeNull();
  });
});
