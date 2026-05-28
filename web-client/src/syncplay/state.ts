import type {
  ServerUserPayload,
  SyncplayFile,
  SyncplayServerMessage,
  TransferDecisionPayload,
  TransferErrorPayload,
  TransferFailedPayload,
  TransferOfferPayload,
  TransferProgressPayload,
  TransferStatusChangePayload,
  TransferTicketPayload,
} from './protocol';

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

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

// ── Transfer types (mirrors react-native/src/syncplay/fileTransfer.ts) ─────

export type TransferStatus =
  | 'incoming-request'
  | 'approved'
  | 'downloading'
  | 'paused-local'
  | 'paused-source-offline'
  | 'paused-source-changed-media'
  | 'paused-receiver-offline'
  | 'complete'
  | 'failed'
  | 'cancelled';

export const TRANSFER_STATUSES: readonly TransferStatus[] = [
  'incoming-request',
  'approved',
  'downloading',
  'paused-local',
  'paused-source-offline',
  'paused-source-changed-media',
  'paused-receiver-offline',
  'complete',
  'failed',
  'cancelled',
];

export type TransferSession = {
  transferId: string;
  role: 'sender' | 'receiver' | null;
  status: TransferStatus;
  source?: string | null;
  receiver?: string | null;
  file?: SyncplayFile | null;
  transferred: number;
  size: number | null;
  fingerprint?: string | null;
  offset: number;
  completedPath?: string | null;
  token?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
};

export type TransferState = {
  transfers: Record<string, TransferSession>;
};

// ── Main state ─────────────────────────────────────────────────────────────

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
  transfer: TransferState;
};

// ── Actions ────────────────────────────────────────────────────────────────

export type SyncplayAction =
  | { type: 'connection-status'; status: ConnectionStatus; error?: string | null }
  | { type: 'profile-updated'; username: string; room: string }
  | { type: 'media-updated'; media: SyncplayFile | null }
  | { type: 'local-playback-updated'; position: number; paused: boolean }
  | { type: 'server-message'; message: SyncplayServerMessage }
  | { type: 'local-system-message'; text: string }
  // Transfer actions
  | { type: 'transfer-request'; payload: TransferOfferPayload }
  | { type: 'transfer-offer'; payload: TransferOfferPayload }
  | { type: 'transfer-decision'; payload: TransferDecisionPayload }
  | { type: 'transfer-ticket'; payload: TransferTicketPayload }
  | { type: 'transfer-progress'; payload: TransferProgressPayload }
  | { type: 'transfer-pause'; transferId: string }
  | { type: 'transfer-resume'; transferId: string }
  | { type: 'transfer-cancel'; transferId: string }
  | { type: 'transfer-error'; transferId: string; errorCode: string; errorMessage?: string }
  | { type: 'transfer-failed'; payload: TransferFailedPayload }
  | { type: 'transfer-completed'; transferId: string; size: number }
  | { type: 'transfer-status-change'; payload: TransferStatusChangePayload }
  // Internal: set transfer state for approved/rejected locally
  | { type: 'transfer-set-status'; transferId: string; status: TransferStatus; role?: 'sender' | 'receiver' | null }
  | { type: 'transfer-set-completed-path'; transferId: string; path: string | null };

// ── Helpers ────────────────────────────────────────────────────────────────

let nextMessageId = 0;

export function createInitialSyncplayState(): SyncplayState {
  return {
    connection: {
      status: 'idle',
      error: null,
    },
    profile: {
      username: 'Anonymous',
      room: 'default',
    },
    server: {
      version: null,
      motd: null,
    },
    playback: {
      position: 0,
      paused: true,
      doSeek: false,
      setBy: null,
    },
    media: null,
    rooms: createRoomMap(),
    playlist: {
      files: [],
      index: null,
      updatedBy: null,
    },
    managedRoom: {
      lastCreatedRoom: null,
      lastPassword: null,
      controllerRooms: {},
    },
    messages: [],
    transfer: createInitialTransferState(),
  };
}

export function createInitialTransferState(): TransferState {
  return { transfers: {} };
}

export function statusFromTransferError(code: string): TransferStatus {
  if (code === 'source-offline') return 'paused-source-offline';
  if (code === 'source-changed-media') return 'paused-source-changed-media';
  if (code === 'receiver-offline') return 'paused-receiver-offline';
  if (code === 'cancelled') return 'cancelled';
  return 'failed';
}

// ── Reducers ───────────────────────────────────────────────────────────────

export function syncplayReducer(
  state: SyncplayState,
  action: SyncplayAction,
): SyncplayState {
  switch (action.type) {
    case 'connection-status':
      return {
        ...state,
        connection: {
          status: action.status,
          error: action.error ?? null,
        },
      };
    case 'profile-updated':
      return {
        ...state,
        profile: {
          username: action.username,
          room: action.room,
        },
      };
    case 'media-updated':
      return {
        ...state,
        media: action.media,
      };
    case 'local-playback-updated':
      return {
        ...state,
        playback: {
          ...state.playback,
          position: action.position,
          paused: action.paused,
          doSeek: false,
          setBy: null,
        },
      };
    case 'server-message':
      return reduceServerMessage(state, action.message);
    case 'local-system-message':
      return addMessage(state, {
        kind: 'system',
        text: action.text,
      });

    // ── Transfer actions ──────────────────────────────────────────────

    case 'transfer-request':
    case 'transfer-offer': {
      const file = action.payload.file ?? null;
      return {
        ...state,
        transfer: {
          ...state.transfer,
          transfers: {
            ...state.transfer.transfers,
            [action.payload.transferId]: {
              transferId: action.payload.transferId,
              role: 'receiver',
              status: 'incoming-request',
              source: action.payload.username,
              receiver: state.profile.username,
              file,
              transferred: 0,
              size: file?.size ?? null,
              offset: 0,
            },
          },
        },
      };
    }

    case 'transfer-decision': {
      const session = state.transfer.transfers[action.payload.transferId];
      if (!session) return state;
      const status: TransferStatus = action.payload.accepted
        ? 'approved'
        : 'cancelled';
      return {
        ...state,
        transfer: {
          ...state.transfer,
          transfers: {
            ...state.transfer.transfers,
            [action.payload.transferId]: {
              ...session,
              status,
              fingerprint: action.payload.fingerprint ?? session.fingerprint,
            },
          },
        },
      };
    }

    case 'transfer-ticket': {
      const session = state.transfer.transfers[action.payload.transferId];
      return {
        ...state,
        transfer: {
          ...state.transfer,
          transfers: {
            ...state.transfer.transfers,
            [action.payload.transferId]: session
              ? {
                  ...session,
                  token: action.payload.token,
                  fingerprint:
                    action.payload.fingerprint ?? session.fingerprint,
                }
              : {
                  transferId: action.payload.transferId,
                  role: 'receiver',
                  status: 'approved',
                  transferred: 0,
                  size: null,
                  offset: 0,
                  token: action.payload.token,
                  fingerprint: action.payload.fingerprint ?? null,
                },
          },
        },
      };
    }

    case 'transfer-progress': {
      const session = state.transfer.transfers[action.payload.transferId];
      if (!session) return state;
      return {
        ...state,
        transfer: {
          ...state.transfer,
          transfers: {
            ...state.transfer.transfers,
            [action.payload.transferId]: {
              ...session,
              status: 'downloading',
              transferred: action.payload.transferred,
              size: action.payload.size ?? session.size,
            },
          },
        },
      };
    }

    case 'transfer-pause': {
      const session = state.transfer.transfers[action.transferId];
      if (!session) return state;
      return {
        ...state,
        transfer: {
          ...state.transfer,
          transfers: {
            ...state.transfer.transfers,
            [action.transferId]: {
              ...session,
              status: 'paused-local',
            },
          },
        },
      };
    }

    case 'transfer-resume': {
      const session = state.transfer.transfers[action.transferId];
      if (!session) return state;
      return {
        ...state,
        transfer: {
          ...state.transfer,
          transfers: {
            ...state.transfer.transfers,
            [action.transferId]: {
              ...session,
              status: 'downloading',
            },
          },
        },
      };
    }

    case 'transfer-cancel': {
      const session = state.transfer.transfers[action.transferId];
      if (!session) return state;
      return {
        ...state,
        transfer: {
          ...state.transfer,
          transfers: {
            ...state.transfer.transfers,
            [action.transferId]: {
              ...session,
              status: 'cancelled',
            },
          },
        },
      };
    }

    case 'transfer-error': {
      const session = state.transfer.transfers[action.transferId];
      if (!session) return state;
      return {
        ...state,
        transfer: {
          ...state.transfer,
          transfers: {
            ...state.transfer.transfers,
            [action.transferId]: {
              ...session,
              status: statusFromTransferError(action.errorCode),
              errorCode: action.errorCode,
              errorMessage: action.errorMessage ?? null,
            },
          },
        },
      };
    }

    case 'transfer-failed': {
      const session = state.transfer.transfers[action.payload.transferId];
      return {
        ...state,
        transfer: {
          ...state.transfer,
          transfers: {
            ...state.transfer.transfers,
            [action.payload.transferId]: session
              ? {
                  ...session,
                  status: statusFromTransferError(action.payload.errorCode),
                  errorCode: action.payload.errorCode,
                  errorMessage: action.payload.errorMessage ?? null,
                }
              : {
                  transferId: action.payload.transferId,
                  role: null,
                  status: statusFromTransferError(action.payload.errorCode),
                  transferred: 0,
                  size: null,
                  offset: 0,
                  errorCode: action.payload.errorCode,
                  errorMessage: action.payload.errorMessage ?? null,
                },
          },
        },
      };
    }

    case 'transfer-completed': {
      const session = state.transfer.transfers[action.transferId];
      if (!session) return state;
      return {
        ...state,
        transfer: {
          ...state.transfer,
          transfers: {
            ...state.transfer.transfers,
            [action.transferId]: {
              ...session,
              status: 'complete',
              size: action.size,
            },
          },
        },
      };
    }

    case 'transfer-status-change': {
      const session = state.transfer.transfers[action.payload.transferId];
      if (!session) return state;
      const newStatus = action.payload.status as TransferStatus;
      if (!TRANSFER_STATUSES.includes(newStatus)) return state;
      return {
        ...state,
        transfer: {
          ...state.transfer,
          transfers: {
            ...state.transfer.transfers,
            [action.payload.transferId]: {
              ...session,
              status: newStatus,
            },
          },
        },
      };
    }

    case 'transfer-set-status': {
      const session = state.transfer.transfers[action.transferId];
      return {
        ...state,
        transfer: {
          ...state.transfer,
          transfers: {
            ...state.transfer.transfers,
            [action.transferId]: session
              ? { ...session, status: action.status }
              : {
                  transferId: action.transferId,
                  role: action.role ?? null,
                  status: action.status,
                  transferred: 0,
                  size: null,
                  offset: 0,
                },
          },
        },
      };
    }

    case 'transfer-set-completed-path': {
      const session = state.transfer.transfers[action.transferId];
      if (!session) return state;
      return {
        ...state,
        transfer: {
          ...state.transfer,
          transfers: {
            ...state.transfer.transfers,
            [action.transferId]: {
              ...session,
              completedPath: action.path,
            },
          },
        },
      };
    }

    default:
      return state;
  }
}

// ── Server message reducer ─────────────────────────────────────────────────

function reduceServerMessage(
  state: SyncplayState,
  message: SyncplayServerMessage,
): SyncplayState {
  let next = state;

  if (message.Hello) {
    const username = message.Hello.username ?? next.profile.username;
    const room = message.Hello.room?.name ?? next.profile.room;
    next = {
      ...next,
      connection: {
        status: 'connected',
        error: null,
      },
      profile: { username, room },
      server: {
        version: message.Hello.realversion ?? message.Hello.version ?? null,
        motd: message.Hello.motd ?? null,
      },
    };

    if (message.Hello.motd) {
      next = addMessage(next, { kind: 'system', text: message.Hello.motd });
    }
  }

  if (message.List) {
    next = { ...next, rooms: normalizeRooms(message.List) };
  }

  if (message.Set) {
    next = reduceSetMessage(next, message.Set);
  }

  if (message.Chat) {
    next = addMessage(next, {
      kind: 'chat',
      username: message.Chat.username,
      text: message.Chat.message,
    });
  }

  if (message.State?.playstate) {
    next = {
      ...next,
      playback: {
        position:
          message.State.playstate.position ?? next.playback.position,
        paused: message.State.playstate.paused ?? next.playback.paused,
        doSeek: message.State.playstate.doSeek ?? false,
        setBy: message.State.playstate.setBy ?? null,
      },
    };
  }

  if (message.Error?.message) {
    next = {
      ...next,
      connection: { status: 'error', error: message.Error.message },
    };
    next = addMessage(next, {
      kind: 'error',
      text: message.Error.message,
    });
  }

  // ── Transfer messages from server ────────────────────────────────────

  if (message.Transfer) {
    next = reduceTransferMessage(next, message.Transfer);
  }

  return next;
}

function reduceTransferMessage(
  state: SyncplayState,
  payload: Record<string, unknown>,
): SyncplayState {
  // The server forwards Transfer sub-messages using this envelope:
  // { Transfer: { request: {...} } }
  // { Transfer: { offer: {...} } }
  // { Transfer: { decision: {...} } }
  // { Transfer: { ticket: {...} } }
  // { Transfer: { progress: {...} } }
  // { Transfer: { error: {...} } }
  // { Transfer: { failed: {...} } }
  // { Transfer: { statusChange: {...} } }
  // { Transfer: { completed: {...} } }
  // { Transfer: { sdp: {...} } }
  // { Transfer: { ice: {...} } }

  if (payload.sdp || payload.ice) {
    // Signaling messages are handled by the connection layer directly.
    // They still arrive here too; we skip them in the state reducer.
    return state;
  }

  if (payload.request) {
    const r = payload.request as Record<string, unknown>;
    return syncplayReducer(state, {
      type: 'transfer-request',
      payload: {
        transferId: (r.transferId as string) || '',
        username: (r.username as string) || '',
        file: r.file as SyncplayFile | undefined,
      },
    });
  }

  if (payload.offer) {
    const o = payload.offer as Record<string, unknown>;
    return syncplayReducer(state, {
      type: 'transfer-offer',
      payload: {
        transferId: (o.transferId as string) || '',
        username: (o.username as string) || '',
        file: o.file as SyncplayFile | undefined,
      },
    });
  }

  if (payload.decision) {
    const d = payload.decision as Record<string, unknown>;
    return syncplayReducer(state, {
      type: 'transfer-decision',
      payload: {
        transferId: (d.transferId as string) || '',
        accepted: Boolean(d.accepted),
        fingerprint: d.fingerprint as string | undefined,
      },
    });
  }

  if (payload.ticket) {
    const t = payload.ticket as Record<string, unknown>;
    return syncplayReducer(state, {
      type: 'transfer-ticket',
      payload: {
        transferId: (t.transferId as string) || '',
        token: (t.token as string) || '',
        fingerprint: t.fingerprint as string | undefined,
      },
    });
  }

  if (payload.progress) {
    const p = payload.progress as Record<string, unknown>;
    return syncplayReducer(state, {
      type: 'transfer-progress',
      payload: {
        transferId: (p.transferId as string) || '',
        transferred:
          typeof p.transferred === 'number' ? p.transferred : 0,
        size:
          typeof p.size === 'number' ? p.size : null,
      },
    });
  }

  if (payload.pause) {
    const p = payload.pause as Record<string, unknown>;
    return syncplayReducer(state, {
      type: 'transfer-pause',
      transferId: (p.transferId as string) || '',
    });
  }

  if (payload.resume) {
    const r = payload.resume as Record<string, unknown>;
    return syncplayReducer(state, {
      type: 'transfer-resume',
      transferId: (r.transferId as string) || '',
    });
  }

  if (payload.cancel) {
    const c = payload.cancel as Record<string, unknown>;
    return syncplayReducer(state, {
      type: 'transfer-cancel',
      transferId: (c.transferId as string) || '',
    });
  }

  if (payload.error) {
    const e = payload.error as Record<string, unknown>;
    return syncplayReducer(state, {
      type: 'transfer-error',
      transferId: (e.transferId as string) || '',
      errorCode: (e.errorCode as string) || 'unknown',
      errorMessage: e.errorMessage as string | undefined,
    });
  }

  if (payload.failed) {
    const f = payload.failed as Record<string, unknown>;
    return syncplayReducer(state, {
      type: 'transfer-failed',
      payload: {
        transferId: (f.transferId as string) || '',
        errorCode: (f.errorCode as string) || 'unknown',
        errorMessage: f.errorMessage as string | undefined,
      },
    });
  }

  if (payload.completed) {
    const c = payload.completed as Record<string, unknown>;
    return syncplayReducer(state, {
      type: 'transfer-completed',
      transferId: (c.transferId as string) || '',
      size: typeof c.size === 'number' ? c.size : 0,
    });
  }

  if (payload.statusChange) {
    const sc = payload.statusChange as Record<string, unknown>;
    return syncplayReducer(state, {
      type: 'transfer-status-change',
      payload: {
        transferId: (sc.transferId as string) || '',
        status: (sc.status as string) || '',
      },
    });
  }

  return state;
}

// ── Set message reducer ────────────────────────────────────────────────────

function reduceSetMessage(
  state: SyncplayState,
  payload: Record<string, unknown>,
): SyncplayState {
  let next = state;

  const roomPayload = payload.room as { name?: string } | undefined;
  if (roomPayload?.name) {
    next = {
      ...next,
      profile: { ...next.profile, room: roomPayload.name },
    };
  }

  const userPayload = payload.user as
    | Record<string, ServerUserPayload>
    | undefined;
  if (userPayload) {
    next = applyUserWithEvents(next, userPayload);
  }

  const readyPayload = payload.ready as
    | { username?: string; isReady?: boolean }
    | undefined;
  if (readyPayload?.username && typeof readyPayload.isReady === 'boolean') {
    next = {
      ...next,
      rooms: setUserReady(
        next.rooms,
        readyPayload.username,
        readyPayload.isReady,
      ),
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
        room: newControlledRoomPayload.roomName,
      },
      managedRoom: {
        ...next.managedRoom,
        lastCreatedRoom: newControlledRoomPayload.roomName,
        lastPassword: newControlledRoomPayload.password ?? null,
      },
    };
    next = addMessage(next, {
      kind: 'system',
      text: `Controlled room "${newControlledRoomPayload.roomName}" created. Password: ${newControlledRoomPayload.password ?? '(none)'}`,
    });
  }

  const controllerAuthPayload = payload.controllerAuth as
    | { user?: string; room?: string; success?: boolean }
    | undefined;
  if (
    controllerAuthPayload?.success &&
    controllerAuthPayload.room &&
    controllerAuthPayload.user
  ) {
    next = {
      ...next,
      rooms: setUserController(
        next.rooms,
        controllerAuthPayload.user,
        true,
      ),
      managedRoom: {
        ...next.managedRoom,
        controllerRooms: {
          ...next.managedRoom.controllerRooms,
          [controllerAuthPayload.room]: controllerAuthPayload.user,
        },
      },
    };
    next = addMessage(next, {
      kind: 'system',
      text: `${controllerAuthPayload.user} is now controller of ${controllerAuthPayload.room}.`,
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
        files: playlistChangePayload.files.filter(
          (file): file is string => typeof file === 'string',
        ),
        updatedBy: playlistChangePayload.user ?? null,
      },
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
        updatedBy:
          playlistIndexPayload.user ?? next.playlist.updatedBy,
      },
    };
  }

  return next;
}

// ── Room helpers ───────────────────────────────────────────────────────────

function applyUserWithEvents(
  state: SyncplayState,
  updates: Record<string, ServerUserPayload>,
): SyncplayState {
  let next = state;

  for (const [username, payload] of Object.entries(updates)) {
    if (payload.event?.joined) {
      next = addMessage(next, {
        kind: 'system',
        text: `${username} joined the room.`,
      });
    }
    if (payload.event?.left) {
      next = addMessage(next, {
        kind: 'system',
        text: `${username} left the room.`,
      });
    }
  }

  return { ...next, rooms: applyUserUpdates(next.rooms, updates) };
}

function normalizeRooms(
  payload: Record<string, Record<string, ServerUserPayload>>,
): RoomMap {
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
  updates: Record<string, ServerUserPayload>,
): RoomMap {
  let next = cloneRoomMap(rooms);
  for (const [username, payload] of Object.entries(updates)) {
    const room = payload.room?.name;
    const previous = findUser(next, username);
    if (payload.event?.left) {
      next = removeUser(next, username);
      continue;
    }

    if (!room) continue;

    next = removeUser(next, username);
    const users = next[room] ?? [];
    next[room] = [
      ...users,
      normalizeUser(username, room, payload, previous),
    ].sort((left, right) => left.username.localeCompare(right.username));
  }
  return next;
}

function normalizeUser(
  username: string,
  fallbackRoom: string,
  user: ServerUserPayload,
  previous?: RoomUser | null,
): RoomUser {
  return {
    username,
    room: user.room?.name ?? fallbackRoom,
    file: resolveUserFile(user, previous),
    isReady:
      typeof user.isReady === 'boolean'
        ? user.isReady
        : previous?.isReady ?? null,
    isController:
      typeof user.controller === 'boolean'
        ? user.controller
        : previous?.isController ?? false,
  };
}

function findUser(rooms: RoomMap, username: string): RoomUser | null {
  for (const users of Object.values(rooms)) {
    const match = users.find(user => user.username === username);
    if (match) return match;
  }
  return null;
}

function removeUser(rooms: RoomMap, username: string): RoomMap {
  const next = createRoomMap();
  for (const [room, users] of Object.entries(rooms)) {
    const remaining = users.filter(user => user.username !== username);
    if (remaining.length > 0) next[room] = remaining;
  }
  return next;
}

function setUserReady(
  rooms: RoomMap,
  username: string,
  isReady: boolean,
): RoomMap {
  const next = createRoomMap();
  for (const [room, users] of Object.entries(rooms)) {
    next[room] = users.map(user =>
      user.username === username ? { ...user, isReady } : user,
    );
  }
  return next;
}

function setUserController(
  rooms: RoomMap,
  username: string,
  isController: boolean,
): RoomMap {
  const next = createRoomMap();
  for (const [room, users] of Object.entries(rooms)) {
    next[room] = users.map(user =>
      user.username === username ? { ...user, isController } : user,
    );
  }
  return next;
}

function resolveUserFile(
  user: ServerUserPayload,
  previous?: RoomUser | null,
): SyncplayFile | null {
  if (!Object.hasOwn(user, 'file')) return previous?.file ?? null;
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

function addMessage(
  state: SyncplayState,
  message: Omit<ChatMessage, 'id' | 'createdAt'>,
): SyncplayState {
  return {
    ...state,
    messages: [
      ...state.messages.slice(-99),
      {
        ...message,
        id: `${Date.now()}-${nextMessageId++}`,
        createdAt: Date.now(),
      },
    ],
  };
}
