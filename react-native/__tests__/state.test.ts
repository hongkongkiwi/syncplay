import {
  createInitialSyncplayState,
  syncplayReducer,
  type SyncplayState
} from '../src/syncplay/state';

describe('Syncplay app state', () => {
  it('handles local state actions', () => {
    const initial = createInitialSyncplayState();
    const connected = syncplayReducer(initial, {
      type: 'connection-status',
      status: 'connecting'
    });
    const profiled = syncplayReducer(connected, {
      type: 'profile-updated',
      username: 'Mobile',
      room: 'room-a'
    });
    const withMedia = syncplayReducer(profiled, {
      type: 'media-updated',
      media: { name: 'movie.mkv', duration: 100, size: 12 }
    });
    const withPlayback = syncplayReducer(withMedia, {
      type: 'local-playback-updated',
      position: 12,
      paused: false
    });

    expect(withPlayback).toMatchObject({
      connection: { status: 'connecting', error: null },
      profile: { username: 'Mobile', room: 'room-a' },
      media: { name: 'movie.mkv', duration: 100, size: 12 },
      playback: {
        position: 12,
        paused: false,
        doSeek: false,
        setBy: null
      }
    });
  });

  it('accepts hello data from the server', () => {
    const state = syncplayReducer(createInitialSyncplayState(), {
      type: 'server-message',
      message: {
        Hello: {
          username: 'Aki',
          room: { name: 'screening-room' },
          realversion: '1.7.6',
          motd: 'Bring snacks',
          features: { chat: true, readiness: true }
        }
      }
    });

    expect(state.connection.status).toBe('connected');
    expect(state.profile.username).toBe('Aki');
    expect(state.profile.room).toBe('screening-room');
    expect(state.server.version).toBe('1.7.6');
    expect(state.messages.at(-1)).toMatchObject({
      kind: 'system',
      text: 'Bring snacks'
    });
  });

  it('normalizes room lists and user updates', () => {
    const listed = syncplayReducer(createInitialSyncplayState(), {
      type: 'server-message',
      message: {
        List: {
          lobby: {
            Aki: {
              file: { name: 'movie.mkv', duration: 100, size: 123 },
              isReady: true,
              controller: false
            }
          }
        }
      }
    });

    const updated = syncplayReducer(listed, {
      type: 'server-message',
      message: {
        Set: {
          user: {
            Miho: {
              room: { name: 'lobby' },
              file: {},
              event: { joined: true }
            }
          }
        }
      }
    });

    expect(updated.rooms.lobby?.map(user => user.username)).toEqual(['Aki', 'Miho']);

    const moved = syncplayReducer(updated, {
      type: 'server-message',
      message: {
        Set: {
          user: {
            Aki: {
              room: { name: 'other-room' },
              file: { name: 'other.mkv', duration: 33, size: 44 }
            },
            Miho: {
              event: { left: true }
            }
          }
        }
      }
    });

    expect(moved.rooms.lobby?.map(user => user.username)).toEqual([]);
    expect(moved.rooms['other-room']?.map(user => user.username)).toEqual(['Aki']);
  });

  it('records chat and remote playback state', () => {
    const withChat = syncplayReducer(createInitialSyncplayState(), {
      type: 'server-message',
      message: { Chat: { username: 'Aki', message: 'pause there' } }
    });

    const withState = syncplayReducer(withChat, {
      type: 'server-message',
      message: {
        State: {
          playstate: {
            position: 44,
            paused: true,
            doSeek: true,
            setBy: 'Aki'
          },
          ping: {}
        }
      }
    });

    expect(withState.messages.at(-1)).toMatchObject({
      kind: 'chat',
      username: 'Aki',
      text: 'pause there'
    });
    expect(withState.playback).toMatchObject({
      position: 44,
      paused: true,
      doSeek: true,
      setBy: 'Aki'
    });
  });

  it('records server errors as connection errors and messages', () => {
    const state = syncplayReducer(createInitialSyncplayState(), {
      type: 'server-message',
      message: {
        Error: {
          message: 'bad password'
        }
      }
    });

    expect(state.connection).toEqual({
      status: 'error',
      error: 'bad password'
    });
    expect(state.messages.at(-1)).toMatchObject({
      kind: 'error',
      text: 'bad password'
    });
  });

  it('tracks transfer offers, progress, and source failure states', () => {
    const offered = syncplayReducer(createInitialSyncplayState(), {
      type: 'server-message',
      message: {
        Transfer: {
          offer: {
            transferId: 'tx1',
            source: 'Aki',
            receiver: 'Mobile',
            file: { name: 'movie.mkv', duration: 100, size: 123 }
          }
        }
      }
    });

    expect(offered.transfers.tx1).toMatchObject({
      status: 'incoming-request',
      source: 'Aki',
      receiver: 'Mobile',
      size: 123
    });

    const ticketed = syncplayReducer(offered, {
      type: 'server-message',
      message: {
        Transfer: {
          ticket: {
            transferId: 'tx1',
            role: 'receiver',
            token: 'secret',
            file: { name: 'movie.mkv', duration: 100, size: 123 },
            offset: 0
          }
        }
      }
    });

    expect(ticketed.transfers.tx1).toMatchObject({
      status: 'approved',
      role: 'receiver',
      file: { name: 'movie.mkv', size: 123 }
    });

    const ignoredBadTicket = syncplayReducer(ticketed, {
      type: 'server-message',
      message: {
        Transfer: {
          ticket: {
            role: 'receiver',
            token: 'bad'
          }
        }
      }
    });

    expect(ignoredBadTicket.transfers.undefined).toBeUndefined();

    const progressed = syncplayReducer(ticketed, {
      type: 'server-message',
      message: {
        Transfer: {
          progress: {
            transferId: 'tx1',
            transferred: 10,
            size: 123,
            status: 'downloading'
          }
        }
      }
    });

    expect(progressed.transfers.tx1).toMatchObject({
      status: 'downloading',
      transferred: 10
    });

    const completed = syncplayReducer(progressed, {
      type: 'server-message',
      message: {
        Transfer: {
          progress: {
            transferId: 'tx1',
            transferred: 123,
            size: 123,
            status: 'complete',
            destinationPath: '/downloads/movie.mkv'
          }
        }
      }
    });

    expect(completed.transfers.tx1).toMatchObject({
      status: 'complete',
      completedPath: '/downloads/movie.mkv'
    });

    const locallyCompleted = syncplayReducer(progressed, {
      type: 'transfer-completed',
      transferId: 'tx1',
      completedPath: 'file:///downloads/movie.mkv'
    });

    expect(locallyCompleted.transfers.tx1).toMatchObject({
      status: 'complete',
      completedPath: 'file:///downloads/movie.mkv'
    });

    const paused = syncplayReducer(completed, {
      type: 'server-message',
      message: {
        Transfer: {
          error: {
            transferId: 'tx1',
            code: 'source-changed-media',
            message: 'Source changed media.'
          }
        }
      }
    });

    expect(paused.transfers.tx1?.status).toBe('paused-source-changed-media');

    const receiverOffline = syncplayReducer(completed, {
      type: 'server-message',
      message: {
        Transfer: {
          error: {
            transferId: 'tx1',
            code: 'receiver-offline',
            message: 'Receiver is offline.'
          }
        }
      }
    });

    expect(receiverOffline.transfers.tx1?.status).toBe('paused-receiver-offline');

    const serverPaused = syncplayReducer(progressed, {
      type: 'server-message',
      message: {
        Transfer: {
          pause: {
            transferId: 'tx1',
            reason: 'paused'
          }
        }
      }
    });

    expect(serverPaused.transfers.tx1?.status).toBe('paused-local');
  });

  it('updates room and readiness from Set messages', () => {
    const listed = syncplayReducer(createInitialSyncplayState(), {
      type: 'server-message',
      message: {
        List: {
          lobby: {
            Aki: {
              file: { name: 'movie.mkv', duration: 100, size: 123 },
              isReady: false
            }
          }
        }
      }
    });

    const state = syncplayReducer(listed, {
      type: 'server-message',
      message: {
        Set: {
          room: {
            name: 'lobby'
          },
          ready: {
            username: 'Aki',
            isReady: true
          }
        }
      }
    });

    expect(state.profile.room).toBe('lobby');
    expect(state.rooms.lobby?.[0]?.isReady).toBe(true);
  });

  it('preserves user flags when Set.user sends a partial update', () => {
    const listed = syncplayReducer(createInitialSyncplayState(), {
      type: 'server-message',
      message: {
        List: {
          lobby: {
            Aki: {
              file: { name: 'movie.mkv', duration: 100, size: 123 },
              isReady: true,
              controller: true,
              features: { chat: true }
            }
          }
        }
      }
    });

    const updated = syncplayReducer(listed, {
      type: 'server-message',
      message: {
        Set: {
          user: {
            Aki: {
              room: { name: 'lobby' },
              file: { name: 'movie-2.mkv', duration: 200, size: 456 }
            }
          }
        }
      }
    });

    expect(updated.rooms.lobby?.[0]).toMatchObject({
      username: 'Aki',
      file: { name: 'movie-2.mkv', duration: 200, size: 456 },
      isReady: true,
      isController: true,
      features: { chat: true }
    });
  });

  it('keeps only the latest 120 messages', () => {
    const state = Array.from({ length: 125 }).reduce<SyncplayState>(
      current =>
        syncplayReducer(current, {
          type: 'server-message',
          message: {
            Chat: {
              username: 'Aki',
              message: 'ping'
            }
          }
        }),
      createInitialSyncplayState()
    );

    expect(state.messages).toHaveLength(120);
  });

  it('tracks managed room auth and shared playlist updates', () => {
    const initial = createInitialSyncplayState();

    const withRoom = syncplayReducer(initial, {
      type: 'server-message',
      message: {
        Set: {
          newControlledRoom: {
            roomName: '+screening:abc123def456',
            password: 'AB-123-456'
          }
        }
      }
    });

    expect(withRoom.managedRoom.lastCreatedRoom).toBe('+screening:abc123def456');
    expect(withRoom.managedRoom.lastPassword).toBe('AB-123-456');
    expect(withRoom.profile.room).toBe('+screening:abc123def456');

    const authed = syncplayReducer(withRoom, {
      type: 'server-message',
      message: {
        Set: {
          controllerAuth: {
            user: 'Mobile',
            room: '+screening:abc123def456',
            success: true
          }
        }
      }
    });

    expect(authed.managedRoom.controllerRooms['+screening:abc123def456']).toBe('Mobile');

    const withPlaylist = syncplayReducer(authed, {
      type: 'server-message',
      message: {
        Set: {
          playlistChange: {
            user: 'Mobile',
            files: ['one.mkv', 'two.mkv']
          },
          playlistIndex: {
            user: 'Mobile',
            index: 1
          }
        }
      }
    });

    expect(withPlaylist.playlist.files).toEqual(['one.mkv', 'two.mkv']);
    expect(withPlaylist.playlist.index).toBe(1);
    expect(withPlaylist.playlist.updatedBy).toBe('Mobile');
  });
});
