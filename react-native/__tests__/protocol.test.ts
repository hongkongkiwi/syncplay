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
  buildTransferCancelMessage,
  buildTransferDecisionMessage,
  buildTransferPauseMessage,
  buildTransferRequestMessage,
  buildTransferResumeMessage,
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

  it('builds transfer messages without receiver-controlled file metadata', () => {
    expect(buildTransferRequestMessage(' Aki ', 12)).toEqual({
      Transfer: {
        request: {
          source: 'Aki',
          offset: 12
        }
      }
    });

    expect(buildTransferRequestMessage('Aki')).toEqual({
      Transfer: {
        request: {
          source: 'Aki',
          offset: 0
        }
      }
    });
  });

  it('builds transfer decision and control messages', () => {
    expect(
      buildTransferDecisionMessage({
        transferId: 'tx1',
        accepted: true,
        fingerprint: 'fp',
        chunkSize: 1024
      })
    ).toEqual({
      Transfer: {
        decision: {
          transferId: 'tx1',
          accepted: true,
          fingerprint: 'fp',
          chunkSize: 1024
        }
      }
    });

    expect(buildTransferPauseMessage('tx1', 'receiver')).toEqual({
      Transfer: { pause: { transferId: 'tx1', reason: 'receiver' } }
    });
    expect(buildTransferResumeMessage('tx1', 2048)).toEqual({
      Transfer: { resume: { transferId: 'tx1', offset: 2048 } }
    });
    expect(buildTransferResumeMessage('tx1', 2048, 'fp')).toEqual({
      Transfer: { resume: { transferId: 'tx1', offset: 2048, fingerprint: 'fp' } }
    });
    expect(buildTransferCancelMessage('tx1', 'sender')).toEqual({
      Transfer: { cancel: { transferId: 'tx1', reason: 'sender' } }
    });
  });

  it('decodes transfer progress and error messages', () => {
    const decoder = new LineDecoder();

    expect(
      decoder.push(
        '{"Transfer":{"progress":{"transferId":"tx1","transferred":10,"size":20,"status":"downloading"}}}\n' +
          '{"Transfer":{"error":{"transferId":"tx1","code":"source-left","message":"Source left."}}}\n'
      )
    ).toEqual([
      {
        Transfer: {
          progress: {
            transferId: 'tx1',
            transferred: 10,
            size: 20,
            status: 'downloading'
          }
        }
      },
      {
        Transfer: {
          error: {
            transferId: 'tx1',
            code: 'source-left',
            message: 'Source left.'
          }
        }
      }
    ]);
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

  it('reports malformed server lines and keeps decoding following messages', () => {
    const decoder = new LineDecoder();

    expect(decoder.push('not-json\n{"List":null}\n')).toEqual([
      { Error: { message: 'Could not parse server line: not-json' } },
      { List: null }
    ]);
  });

  it('rejects completed server lines above the size limit', () => {
    const decoder = new LineDecoder();
    const hugeLine = `${'x'.repeat(1_048_577)}\n{"List":null}\n`;

    expect(decoder.push(hugeLine)).toEqual([
      { Error: { message: 'Syncplay server line exceeded the 1 MiB limit.' } },
      { List: null }
    ]);
  });

  it('rejects completed server lines above the byte limit with multi-byte characters', () => {
    const decoder = new LineDecoder();
    const hugeLine = `${'\u{1F525}'.repeat(262_145)}\n{"List":null}\n`;

    expect(decoder.push(hugeLine)).toEqual([
      { Error: { message: 'Syncplay server line exceeded the 1 MiB limit.' } },
      { List: null }
    ]);
  });

  it('clears an oversized incomplete server line', () => {
    const decoder = new LineDecoder();

    expect(decoder.push('x'.repeat(1_048_577))).toEqual([
      { Error: { message: 'Syncplay server line exceeded the 1 MiB limit.' } }
    ]);
    expect(decoder.push('{"List":null}\n')).toEqual([{ List: null }]);
  });

  it('clears an oversized incomplete server line with multi-byte characters', () => {
    const decoder = new LineDecoder();

    expect(decoder.push('\u{1F525}'.repeat(262_145))).toEqual([
      { Error: { message: 'Syncplay server line exceeded the 1 MiB limit.' } }
    ]);
    expect(decoder.push('{"List":null}\n')).toEqual([{ List: null }]);
  });
});
