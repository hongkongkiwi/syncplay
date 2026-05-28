import type { ServerUserPayload, SyncplayFile, SyncplayServerMessage } from './protocol';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

export type RoomUser = {
  username: string;
  room: string;
  file: SyncplayFile | null;
  isReady: boolean | null;
  isController: boolean;
};

type RoomMap = Record<string, RoomUser[]>;

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
  rooms: RoomMap;
  playlist: {
    files: string[];
    index: number | null;
    updatedBy: string | null;
  };
  managedRoom: {
    lastCreatedRoom: string | null;
    lastPassword: string | null;
    controllerRooms: Record<string, string>;
  };
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
    rooms: createRoomMap(),
    playlist: {
      files: [],
      index: null,
      updatedBy: null
    },
    managedRoom: {
      lastCreatedRoom: null,
      lastPassword: null,
      controllerRooms: {}
    },
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
    next = applyUserWithEvents(next, userPayload);
  }

  const readyPayload = payload.ready as { username?: string; isReady?: boolean } | undefined;
  if (readyPayload?.username && typeof readyPayload.isReady === 'boolean') {
    next = {
      ...next,
      rooms: setUserReady(next.rooms, readyPayload.username, readyPayload.isReady)
    };
  }

  const newControlledRoomPayload = payload.newControlledRoom as
    | { roomName?: string; password?: string }
    | undefined;
  if (newControlledRoomPayload?.roomName) {
    next = {
      ...next,
      profile: {
        ...next.profile,
        room: newControlledRoomPayload.roomName
      },
      managedRoom: {
        ...next.managedRoom,
        lastCreatedRoom: newControlledRoomPayload.roomName,
        lastPassword: newControlledRoomPayload.password ?? null
      }
    };
    next = addMessage(next, {
      kind: 'system',
      text: `Controlled room "${newControlledRoomPayload.roomName}" created. Password: ${newControlledRoomPayload.password ?? '(none)'}`
    });
  }

  const controllerAuthPayload = payload.controllerAuth as
    | { user?: string; room?: string; success?: boolean }
    | undefined;
  if (controllerAuthPayload?.success && controllerAuthPayload.room && controllerAuthPayload.user) {
    next = {
      ...next,
      rooms: setUserController(next.rooms, controllerAuthPayload.user, true),
      managedRoom: {
        ...next.managedRoom,
        controllerRooms: {
          ...next.managedRoom.controllerRooms,
          [controllerAuthPayload.room]: controllerAuthPayload.user
        }
      }
    };
    next = addMessage(next, {
      kind: 'system',
      text: `${controllerAuthPayload.user} is now controller of ${controllerAuthPayload.room}.`
    });
  }

  const playlistChangePayload = payload.playlistChange as
    | { user?: string; files?: unknown }
    | undefined;
  if (Array.isArray(playlistChangePayload?.files)) {
    next = {
      ...next,
      playlist: {
        ...next.playlist,
        files: playlistChangePayload.files.filter((file): file is string => typeof file === 'string'),
        updatedBy: playlistChangePayload.user ?? null
      }
    };
  }

  const playlistIndexPayload = payload.playlistIndex as
    | { user?: string; index?: number }
    | undefined;
  if (typeof playlistIndexPayload?.index === 'number') {
    next = {
      ...next,
      playlist: {
        ...next.playlist,
        index: playlistIndexPayload.index,
        updatedBy: playlistIndexPayload.user ?? next.playlist.updatedBy
      }
    };
  }

  return next;
}

function applyUserWithEvents(state: SyncplayState, updates: Record<string, ServerUserPayload>): SyncplayState {
  let next = state;

  for (const [username, payload] of Object.entries(updates)) {
    if (payload.event?.joined) {
      next = addMessage(next, {
        kind: 'system',
        text: `${username} joined the room.`
      });
    }
    if (payload.event?.left) {
      next = addMessage(next, {
        kind: 'system',
        text: `${username} left the room.`
      });
    }
  }

  return {
    ...next,
    rooms: applyUserUpdates(next.rooms, updates)
  };
}

function normalizeRooms(payload: Record<string, Record<string, ServerUserPayload>>): RoomMap {
  const rooms = createRoomMap();
  for (const [room, users] of Object.entries(payload)) {
    rooms[room] = Object.entries(users)
      .map(([username, user]) => normalizeUser(username, room, user))
      .sort((left, right) => left.username.localeCompare(right.username));
  }
  return rooms;
}

function applyUserUpdates(
  rooms: RoomMap,
  updates: Record<string, ServerUserPayload>
): RoomMap {
  let next = cloneRoomMap(rooms);
  for (const [username, payload] of Object.entries(updates)) {
    const room = payload.room?.name;
    const previous = findUser(next, username);
    if (payload.event?.left) {
      next = removeUser(next, username);
      continue;
    }

    if (!room) {
      continue;
    }

    next = removeUser(next, username);
    const users = next[room] ?? [];
    next[room] = [...users, normalizeUser(username, room, payload, previous)].sort((left, right) =>
      left.username.localeCompare(right.username)
    );
  }
  return next;
}

function normalizeUser(
  username: string,
  fallbackRoom: string,
  user: ServerUserPayload,
  previous?: RoomUser | null
): RoomUser {
  return {
    username,
    room: user.room?.name ?? fallbackRoom,
    file: resolveUserFile(user, previous),
    isReady: typeof user.isReady === 'boolean' ? user.isReady : previous?.isReady ?? null,
    isController: typeof user.controller === 'boolean' ? user.controller : previous?.isController ?? false
  };
}

function findUser(rooms: RoomMap, username: string): RoomUser | null {
  for (const users of Object.values(rooms)) {
    const match = users.find(user => user.username === username);
    if (match) {
      return match;
    }
  }
  return null;
}

function removeUser(rooms: RoomMap, username: string): RoomMap {
  const next = createRoomMap();
  for (const [room, users] of Object.entries(rooms)) {
    const remaining = users.filter(user => user.username !== username);
    if (remaining.length > 0) {
      next[room] = remaining;
    }
  }
  return next;
}

function setUserReady(rooms: RoomMap, username: string, isReady: boolean): RoomMap {
  const next = createRoomMap();
  for (const [room, users] of Object.entries(rooms)) {
    next[room] = users.map(user => (user.username === username ? { ...user, isReady } : user));
  }
  return next;
}

function setUserController(rooms: RoomMap, username: string, isController: boolean): RoomMap {
  const next = createRoomMap();
  for (const [room, users] of Object.entries(rooms)) {
    next[room] = users.map(user => (user.username === username ? { ...user, isController } : user));
  }
  return next;
}

function resolveUserFile(user: ServerUserPayload, previous?: RoomUser | null): SyncplayFile | null {
  if (!Object.hasOwn(user, 'file')) {
    return previous?.file ?? null;
  }
  return isSyncplayFile(user.file) ? user.file : null;
}

function isSyncplayFile(file: unknown): file is SyncplayFile {
  return (
    !!file &&
    typeof (file as SyncplayFile).name === 'string' &&
    typeof (file as SyncplayFile).duration === 'number' &&
    typeof (file as SyncplayFile).size === 'number'
  );
}

function createRoomMap(): RoomMap {
  return Object.create(null) as RoomMap;
}

function cloneRoomMap(rooms: RoomMap): RoomMap {
  const next = createRoomMap();
  for (const [room, users] of Object.entries(rooms)) {
    next[room] = users;
  }
  return next;
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
