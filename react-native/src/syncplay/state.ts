import {
  createIncomingTransfer,
  isTransferStatus,
  parseTransferId,
  statusFromTransferError,
  type TransferSession
} from './fileTransfer';
import type { ServerUserPayload, SyncplayFile, SyncplayServerMessage } from './protocol';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

export type RoomUser = {
  username: string;
  room: string;
  file: SyncplayFile | null;
  isReady: boolean | null;
  isController: boolean;
  features: Record<string, unknown> | null;
};

export type SyncplayMessage = {
  id: string;
  kind: 'system' | 'chat' | 'error';
  text: string;
  username?: string;
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
    features: Record<string, unknown>;
  };
  media: SyncplayFile | null;
  playback: {
    position: number;
    paused: boolean;
    doSeek: boolean;
    setBy: string | null;
  };
  rooms: Record<string, RoomUser[]>;
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
  transfers: Record<string, TransferSession>;
  messages: SyncplayMessage[];
};

export type SyncplayAction =
  | { type: 'connection-status'; status: ConnectionStatus; error?: string | null }
  | { type: 'profile-updated'; username: string; room: string }
  | { type: 'media-updated'; media: SyncplayFile | null }
  | { type: 'local-playback-updated'; position: number; paused: boolean }
  | { type: 'transfer-completed'; transferId: string; completedPath: string }
  | { type: 'transfer-failed'; transferId: string; error?: string | null }
  | { type: 'transfer-retry'; transferId: string }
  | { type: 'server-message'; message: SyncplayServerMessage };

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
      features: {}
    },
    media: null,
    playback: {
      position: 0,
      paused: true,
      doSeek: false,
      setBy: null
    },
    rooms: {},
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
    transfers: {},
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
    case 'transfer-completed': {
      const previous = state.transfers[action.transferId];
      if (!previous) {
        return state;
      }
      return {
        ...state,
        transfers: {
          ...state.transfers,
          [action.transferId]: {
            ...previous,
            status: 'complete',
            completedPath: action.completedPath
          }
        }
      };
    }
    case 'transfer-failed': {
      const previous = state.transfers[action.transferId];
      if (!previous) {
        return state;
      }
      return {
        ...state,
        transfers: {
          ...state.transfers,
          [action.transferId]: {
            ...previous,
            status: 'failed',
            errorCode: null,
            errorMessage: action.error ?? previous.errorMessage ?? 'Transfer failed.'
          }
        }
      };
    }
    case 'transfer-retry': {
      const previous = state.transfers[action.transferId];
      if (!previous?.token || previous.status === 'complete' || previous.status === 'cancelled') {
        return state;
      }
      return {
        ...state,
        transfers: {
          ...state.transfers,
          [action.transferId]: {
            ...previous,
            status: 'approved',
            offset: Math.max(previous.offset, previous.transferred),
            errorCode: null,
            errorMessage: null
          }
        }
      };
    }
    case 'server-message':
      return reduceServerMessage(state, action.message);
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
        features: message.Hello.features ?? {}
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

  if (message.Transfer) {
    next = reduceTransferMessage(next, message.Transfer);
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

function reduceTransferMessage(state: SyncplayState, payload: NonNullable<SyncplayServerMessage['Transfer']>): SyncplayState {
  if (payload.offer) {
    const session = createIncomingTransfer(payload.offer);
    if (!session) {
      return state;
    }
    return {
      ...state,
      transfers: {
        ...state.transfers,
        [session.transferId]: session
      }
    };
  }

  if (payload.ticket) {
    const transferId = parseTransferId(payload.ticket.transferId);
    if (!transferId) {
      return state;
    }
    const previous = state.transfers[transferId];
    return {
      ...state,
      transfers: {
        ...state.transfers,
        [transferId]: {
          ...(previous ?? {
            transferId,
            role: null,
            status: 'approved',
            transferred: 0,
            size: null,
            offset: 0
          }),
          role: payload.ticket.role === 'sender' || payload.ticket.role === 'receiver' ? payload.ticket.role : null,
          status: 'approved',
          token: typeof payload.ticket.token === 'string' ? payload.ticket.token : null,
          fingerprint: typeof payload.ticket.fingerprint === 'string' ? payload.ticket.fingerprint : previous?.fingerprint ?? null,
          file: isTicketFile(payload.ticket.file) ? payload.ticket.file : previous?.file ?? null,
          size: isTicketFile(payload.ticket.file) ? payload.ticket.file.size : previous?.size ?? null,
          offset: typeof payload.ticket.offset === 'number' ? payload.ticket.offset : previous?.offset ?? 0
        }
      }
    };
  }

  if (payload.progress) {
    const transferId = parseTransferId(payload.progress.transferId);
    if (!transferId || !isTransferStatus(payload.progress.status)) {
      return state;
    }
    const previous = state.transfers[transferId];
    return {
      ...state,
      transfers: {
        ...state.transfers,
        [transferId]: {
          ...(previous ?? {
            transferId,
            role: null,
            file: null,
            source: null,
            receiver: null,
            offset: 0
          }),
          status: payload.progress.status,
          transferred: payload.progress.transferred,
          size: payload.progress.size,
          completedPath: payload.progress.status === 'complete'
            ? payload.progress.destinationPath ?? previous?.completedPath ?? null
            : previous?.completedPath ?? null,
          errorCode: null,
          errorMessage: null
        }
      }
    };
  }

  if (payload.error) {
    const transferId = parseTransferId(payload.error.transferId);
    if (!transferId) {
      return state;
    }
    const previous = state.transfers[transferId];
    return {
      ...state,
      transfers: {
        ...state.transfers,
        [transferId]: {
          ...(previous ?? {
            transferId,
            role: null,
            file: null,
            source: null,
            receiver: null,
            transferred: 0,
            size: null,
            offset: 0
          }),
          status: statusFromTransferError(payload.error.code),
          errorCode: payload.error.code,
          errorMessage: payload.error.message
        }
      }
    };
  }

  if (payload.pause) {
    return reduceTransferControl(state, payload.pause.transferId, 'paused-local', payload.pause.offset);
  }

  if (payload.resume) {
    return reduceTransferControl(state, payload.resume.transferId, 'downloading', payload.resume.offset);
  }

  if (payload.cancel) {
    return reduceTransferControl(state, payload.cancel.transferId, 'cancelled');
  }

  // WebRTC signaling — currently not supported on mobile (react-native-webrtc pending).
  // Silently acknowledged to prevent state corruption.
  if (payload.sdp || payload.ice) {
    return state;
  }

  return state;
}

function isTicketFile(file: unknown): file is SyncplayFile {
  return (
    !!file &&
    typeof (file as SyncplayFile).name === 'string' &&
    typeof (file as SyncplayFile).duration === 'number' &&
    typeof (file as SyncplayFile).size === 'number'
  );
}

function reduceTransferControl(
  state: SyncplayState,
  transferIdValue: unknown,
  status: TransferSession['status'],
  offset?: number
): SyncplayState {
  const transferId = parseTransferId(transferIdValue);
  if (!transferId) {
    return state;
  }
  const previous = state.transfers[transferId];
  return {
    ...state,
    transfers: {
      ...state.transfers,
      [transferId]: {
        ...(previous ?? {
          transferId,
          role: null,
          file: null,
          source: null,
          receiver: null,
          transferred: 0,
          size: null,
          offset: 0
        }),
        status,
        offset: typeof offset === 'number' ? offset : previous?.offset ?? 0,
        errorCode: status === 'downloading' ? null : previous?.errorCode ?? null,
        errorMessage: status === 'downloading' ? null : previous?.errorMessage ?? null
      }
    }
  };
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

function normalizeRooms(rooms: Record<string, Record<string, ServerUserPayload>>): Record<string, RoomUser[]> {
  return Object.fromEntries(
    Object.entries(rooms).map(([room, users]) => [
      room,
      Object.entries(users)
        .map(([username, payload]) => normalizeUser(username, room, payload))
        .sort(compareUsers)
    ])
  );
}

function applyUserUpdates(
  rooms: Record<string, RoomUser[]>,
  updates: Record<string, ServerUserPayload>
): Record<string, RoomUser[]> {
  const next = cloneRooms(rooms);

  for (const [username, payload] of Object.entries(updates)) {
    const previous = findUser(next, username);
    for (const users of Object.values(next)) {
      const index = users.findIndex(user => user.username === username);
      if (index >= 0) {
        users.splice(index, 1);
      }
    }

    if (payload.event?.left) {
      continue;
    }

    const room = payload.room?.name ?? previous?.room ?? 'default';
    const users = next[room] ?? [];
    users.push(normalizeUser(username, room, payload, previous));
    next[room] = users.sort(compareUsers);
  }

  return next;
}

function findUser(rooms: Record<string, RoomUser[]>, username: string): RoomUser | null {
  for (const users of Object.values(rooms)) {
    const user = users.find(candidate => candidate.username === username);
    if (user) {
      return user;
    }
  }

  return null;
}

function setUserReady(
  rooms: Record<string, RoomUser[]>,
  username: string,
  isReady: boolean
): Record<string, RoomUser[]> {
  const next = cloneRooms(rooms);

  for (const users of Object.values(next)) {
    const user = users.find(candidate => candidate.username === username);
    if (user) {
      user.isReady = isReady;
    }
  }

  return next;
}

function setUserController(
  rooms: Record<string, RoomUser[]>,
  username: string,
  isController: boolean
): Record<string, RoomUser[]> {
  const next = cloneRooms(rooms);

  for (const users of Object.values(next)) {
    const user = users.find(candidate => candidate.username === username);
    if (user) {
      user.isController = isController;
    }
  }

  return next;
}

function normalizeUser(
  username: string,
  room: string,
  payload: ServerUserPayload,
  previous?: RoomUser | null
): RoomUser {
  const hasFile = Object.prototype.hasOwnProperty.call(payload, 'file');
  const file = hasFile
    ? isSyncplayFile(payload.file)
      ? payload.file
      : null
    : previous?.file ?? null;

  return {
    username,
    room,
    file,
    isReady: payload.isReady ?? previous?.isReady ?? null,
    isController: payload.controller ?? previous?.isController ?? false,
    features: payload.features ?? previous?.features ?? null
  };
}

function isSyncplayFile(file: ServerUserPayload['file']): file is SyncplayFile {
  const duration = (file as SyncplayFile | null)?.duration;
  const size = (file as SyncplayFile | null)?.size;
  return (
    !!file &&
    typeof (file as SyncplayFile).name === 'string' &&
    typeof duration === 'number' &&
    Number.isFinite(duration) &&
    duration >= 0 &&
    typeof size === 'number' &&
    Number.isFinite(size) &&
    size >= 0
  );
}

function cloneRooms(rooms: Record<string, RoomUser[]>): Record<string, RoomUser[]> {
  return Object.fromEntries(
    Object.entries(rooms).map(([room, users]) => [
      room,
      users.map(user => ({ ...user }))
    ])
  );
}

function compareUsers(a: RoomUser, b: RoomUser): number {
  return a.username.localeCompare(b.username, undefined, { sensitivity: 'base' });
}

function addMessage(
  state: SyncplayState,
  message: Omit<SyncplayMessage, 'id' | 'createdAt'>
): SyncplayState {
  return {
    ...state,
    messages: [
      ...state.messages,
      {
        ...message,
        id: String(nextMessageId++),
        createdAt: Date.now()
      }
    ].slice(-120)
  };
}
