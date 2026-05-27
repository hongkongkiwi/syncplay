import type { ServerUserPayload, SyncplayFile, SyncplayServerMessage } from './protocol';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

export type RoomUser = {
  username: string;
  room: string;
  file: SyncplayFile | null;
  isReady: boolean | null;
  isController: boolean;
};

export type ChatMessage = {
  id: string;
  kind: 'system' | 'chat' | 'error';
  username?: string;
  text: string;
  createdAt: number;
};

export type SyncplayState = {
  connection: {
    status: ConnectionStatus;
    error: string | null;
  };
  profile: {
    username: string;
    room: string;
  };
  server: {
    version: string | null;
    motd: string | null;
  };
  playback: {
    position: number;
    paused: boolean;
    doSeek: boolean;
    setBy: string | null;
  };
  media: SyncplayFile | null;
  rooms: Record<string, RoomUser[]>;
  messages: ChatMessage[];
};

export type SyncplayAction =
  | { type: 'connection-status'; status: ConnectionStatus; error?: string | null }
  | { type: 'profile-updated'; username: string; room: string }
  | { type: 'media-updated'; media: SyncplayFile | null }
  | { type: 'local-playback-updated'; position: number; paused: boolean }
  | { type: 'server-message'; message: SyncplayServerMessage }
  | { type: 'local-system-message'; text: string };

let nextMessageId = 0;

export function createInitialSyncplayState(): SyncplayState {
  return {
    connection: {
      status: 'idle',
      error: null
    },
    profile: {
      username: 'Anonymous',
      room: 'default'
    },
    server: {
      version: null,
      motd: null
    },
    playback: {
      position: 0,
      paused: true,
      doSeek: false,
      setBy: null
    },
    media: null,
    rooms: {},
    messages: []
  };
}

export function syncplayReducer(state: SyncplayState, action: SyncplayAction): SyncplayState {
  switch (action.type) {
    case 'connection-status':
      return {
        ...state,
        connection: {
          status: action.status,
          error: action.error ?? null
        }
      };
    case 'profile-updated':
      return {
        ...state,
        profile: {
          username: action.username,
          room: action.room
        }
      };
    case 'media-updated':
      return {
        ...state,
        media: action.media
      };
    case 'local-playback-updated':
      return {
        ...state,
        playback: {
          ...state.playback,
          position: action.position,
          paused: action.paused,
          doSeek: false,
          setBy: null
        }
      };
    case 'server-message':
      return reduceServerMessage(state, action.message);
    case 'local-system-message':
      return addMessage(state, {
        kind: 'system',
        text: action.text
      });
    default:
      return state;
  }
}

function reduceServerMessage(state: SyncplayState, message: SyncplayServerMessage): SyncplayState {
  let next = state;

  if (message.Hello) {
    const username = message.Hello.username ?? next.profile.username;
    const room = message.Hello.room?.name ?? next.profile.room;
    next = {
      ...next,
      connection: {
        status: 'connected',
        error: null
      },
      profile: {
        username,
        room
      },
      server: {
        version: message.Hello.realversion ?? message.Hello.version ?? null,
        motd: message.Hello.motd ?? null
      }
    };

    if (message.Hello.motd) {
      next = addMessage(next, {
        kind: 'system',
        text: message.Hello.motd
      });
    }
  }

  if (message.List) {
    next = {
      ...next,
      rooms: normalizeRooms(message.List)
    };
  }

  if (message.Set) {
    next = reduceSetMessage(next, message.Set);
  }

  if (message.Chat) {
    next = addMessage(next, {
      kind: 'chat',
      username: message.Chat.username,
      text: message.Chat.message
    });
  }

  if (message.State?.playstate) {
    next = {
      ...next,
      playback: {
        position: message.State.playstate.position ?? next.playback.position,
        paused: message.State.playstate.paused ?? next.playback.paused,
        doSeek: message.State.playstate.doSeek ?? false,
        setBy: message.State.playstate.setBy ?? null
      }
    };
  }

  if (message.Error?.message) {
    next = {
      ...next,
      connection: {
        status: 'error',
        error: message.Error.message
      }
    };
    next = addMessage(next, {
      kind: 'error',
      text: message.Error.message
    });
  }

  return next;
}

function reduceSetMessage(state: SyncplayState, payload: Record<string, unknown>): SyncplayState {
  let next = state;

  const roomPayload = payload.room as { name?: string } | undefined;
  if (roomPayload?.name) {
    next = {
      ...next,
      profile: {
        ...next.profile,
        room: roomPayload.name
      }
    };
  }

  const userPayload = payload.user as Record<string, ServerUserPayload> | undefined;
  if (userPayload) {
    next = {
      ...next,
      rooms: applyUserUpdates(next.rooms, userPayload)
    };
  }

  const readyPayload = payload.ready as { username?: string; isReady?: boolean } | undefined;
  if (readyPayload?.username && typeof readyPayload.isReady === 'boolean') {
    next = {
      ...next,
      rooms: setUserReady(next.rooms, readyPayload.username, readyPayload.isReady)
    };
  }

  return next;
}

function normalizeRooms(payload: Record<string, Record<string, ServerUserPayload>>): Record<string, RoomUser[]> {
  const rooms: Record<string, RoomUser[]> = {};
  for (const [room, users] of Object.entries(payload)) {
    rooms[room] = Object.entries(users)
      .map(([username, user]) => normalizeUser(username, room, user))
      .sort((left, right) => left.username.localeCompare(right.username));
  }
  return rooms;
}

function applyUserUpdates(
  rooms: Record<string, RoomUser[]>,
  updates: Record<string, ServerUserPayload>
): Record<string, RoomUser[]> {
  let next = { ...rooms };
  for (const [username, payload] of Object.entries(updates)) {
    const room = payload.room?.name;
    if (payload.event?.left) {
      next = removeUser(next, username);
      continue;
    }

    if (!room) {
      continue;
    }

    next = removeUser(next, username);
    const users = next[room] ?? [];
    next[room] = [...users, normalizeUser(username, room, payload)].sort((left, right) =>
      left.username.localeCompare(right.username)
    );
  }
  return next;
}

function normalizeUser(username: string, fallbackRoom: string, user: ServerUserPayload): RoomUser {
  return {
    username,
    room: user.room?.name ?? fallbackRoom,
    file: isSyncplayFile(user.file) ? user.file : null,
    isReady: typeof user.isReady === 'boolean' ? user.isReady : null,
    isController: !!user.controller
  };
}

function removeUser(rooms: Record<string, RoomUser[]>, username: string): Record<string, RoomUser[]> {
  const next: Record<string, RoomUser[]> = {};
  for (const [room, users] of Object.entries(rooms)) {
    const remaining = users.filter(user => user.username !== username);
    if (remaining.length > 0) {
      next[room] = remaining;
    }
  }
  return next;
}

function setUserReady(rooms: Record<string, RoomUser[]>, username: string, isReady: boolean): Record<string, RoomUser[]> {
  return Object.fromEntries(
    Object.entries(rooms).map(([room, users]) => [
      room,
      users.map(user => (user.username === username ? { ...user, isReady } : user))
    ])
  );
}

function isSyncplayFile(file: unknown): file is SyncplayFile {
  return (
    !!file &&
    typeof (file as SyncplayFile).name === 'string' &&
    typeof (file as SyncplayFile).duration === 'number' &&
    typeof (file as SyncplayFile).size === 'number'
  );
}

function addMessage(state: SyncplayState, message: Omit<ChatMessage, 'id' | 'createdAt'>): SyncplayState {
  return {
    ...state,
    messages: [
      ...state.messages.slice(-99),
      {
        ...message,
        id: `${Date.now()}-${nextMessageId++}`,
        createdAt: Date.now()
      }
    ]
  };
}
