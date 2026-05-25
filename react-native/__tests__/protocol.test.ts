import { Buffer } from 'buffer';

import {
  LineDecoder,
  buildControlledRoomMessage,
  buildFileMessage,
  buildHelloMessage,
  buildPlaylistIndexMessage,
  buildPlaylistMessage,
  buildReadyMessage,
  buildRoomMessage,
  buildStateMessage,
  buildUserReadyMessage,
  createClientFeatures,
  encodeMessage
} from '../src/syncplay/protocol';

describe('Syncplay protocol helpers', () => {
  it('builds a desktop-compatible hello message', () => {
    const hello = buildHelloMessage({
      username: 'Aki',
      room: 'screening-room',
      passwordHash: '5f4dcc3b5aa765d61d8327deb882cf99'
    });

    expect(hello).toEqual({
      Hello: {
        username: 'Aki',
        password: '5f4dcc3b5aa765d61d8327deb882cf99',
        room: { name: 'screening-room' },
        version: '1.2.255',
        realversion: '1.7.6-rn.1',
        features: createClientFeatures()
      }
    });
  });

  it('encodes messages as newline-delimited JSON', () => {
    expect(encodeMessage({ List: null })).toBe('{"List":null}\r\n');
  });

  it('reassembles split server lines', () => {
    const decoder = new LineDecoder();

    expect(decoder.push('{"Chat":{"username":"M')).toEqual([]);
    expect(decoder.push('iho","message":"ready"}}\r\n{"List":null}\n')).toEqual([
      { Chat: { username: 'Miho', message: 'ready' } },
      { List: null }
    ]);
  });

  it('builds file and state updates', () => {
    expect(
      buildFileMessage({
        name: 'movie.mkv',
        duration: 7224,
        size: 845121
      })
    ).toEqual({
      Set: {
        file: {
          name: 'movie.mkv',
          duration: 7224,
          size: 845121
        }
      }
    });

    expect(
      buildStateMessage({
        position: 12.5,
        paused: false,
        doSeek: true,
        clientLatencyCalculation: 1000,
        clientRtt: 0.2
      })
    ).toEqual({
      State: {
        playstate: {
          position: 12.5,
          paused: false,
          doSeek: true
        },
        ping: {
          clientLatencyCalculation: 1000,
          clientRtt: 0.2
        }
      }
    });
  });

  it('omits playstate when playback is not loaded', () => {
    expect(
      buildStateMessage({
        position: null,
        paused: true,
        latencyCalculation: 42,
        clientLatencyCalculation: 1000,
        clientRtt: 0.2
      })
    ).toEqual({
      State: {
        ping: {
          latencyCalculation: 42,
          clientLatencyCalculation: 1000,
          clientRtt: 0.2
        }
      }
    });
  });

  it('builds room and own readiness messages', () => {
    expect(buildRoomMessage('  film-room  ')).toEqual({
      Set: {
        room: {
          name: 'film-room'
        }
      }
    });

    expect(buildReadyMessage(true)).toEqual({
      Set: {
        ready: {
          isReady: true,
          manuallyInitiated: true
        }
      }
    });
  });

  it('builds desktop-compatible managed room and readiness messages', () => {
    expect(buildControlledRoomMessage('film-room', 'AB-123-456')).toEqual({
      Set: {
        controllerAuth: {
          room: 'film-room',
          password: 'AB-123-456'
        }
      }
    });

    expect(buildUserReadyMessage('Miho', false)).toEqual({
      Set: {
        ready: {
          username: 'Miho',
          isReady: false,
          manuallyInitiated: true
        }
      }
    });
  });

  it('builds shared playlist messages', () => {
    expect(buildPlaylistMessage(['one.mkv', 'https://example.test/two.mp4'])).toEqual({
      Set: {
        playlistChange: {
          files: ['one.mkv', 'https://example.test/two.mp4']
        }
      }
    });

    expect(buildPlaylistIndexMessage(1)).toEqual({
      Set: {
        playlistIndex: {
          index: 1
        }
      }
    });
  });

  it('decodes binary chunks and keeps incomplete trailing data buffered', () => {
    const decoder = new LineDecoder();
    const chunk = Buffer.from('{"Chat":{"username":"Aki","message":"one"}}\n{"Chat":{"username":"Miho"');

    expect(decoder.push(chunk)).toEqual([
      {
        Chat: {
          username: 'Aki',
          message: 'one'
        }
      }
    ]);
    expect(decoder.push(',"message":"two"}}\r\n')).toEqual([
      {
        Chat: {
          username: 'Miho',
          message: 'two'
        }
      }
    ]);
  });

  it('skips malformed server lines and keeps decoding following messages', () => {
    const decoder = new LineDecoder();

    expect(decoder.push('not-json\n{"List":null}\n')).toEqual([{ List: null }]);
  });
});
