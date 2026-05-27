import md5 from 'blueimp-md5';

export const SYNCPLAY_COMPAT_VERSION = '1.2.255';
export const SYNCPLAY_WEB_VERSION = '1.7.6-web.1';

export type SyncplayFile = {
  name: string;
  duration: number;
  size: number;
};

export type ClientFeatures = {
  sharedPlaylists: boolean;
  chat: boolean;
  uiMode: string;
  featureList: boolean;
  readiness: boolean;
  managedRooms: boolean;
  persistentRooms: boolean;
  setOthersReadiness: boolean;
  fileTransfer: boolean;
  fileTransferVersion: number;
};

export type ServerUserPayload = {
  room?: { name?: string };
  file?: SyncplayFile | Record<string, never>;
  event?: {
    joined?: boolean;
    left?: boolean;
  };
  controller?: boolean;
  isReady?: boolean | null;
  features?: Record<string, unknown> | null;
};

export type SyncplayServerMessage = {
  Hello?: {
    username?: string;
    room?: { name?: string };
    version?: string;
    realversion?: string;
    motd?: string;
    features?: Record<string, unknown>;
  };
  Set?: Record<string, unknown>;
  List?: Record<string, Record<string, ServerUserPayload>>;
  State?: {
    playstate?: {
      position?: number;
      paused?: boolean;
      doSeek?: boolean;
      setBy?: string;
    };
    ping?: {
      latencyCalculation?: number;
      clientLatencyCalculation?: number;
      serverRtt?: number;
    };
  };
  Chat?: {
    username: string;
    message: string;
  };
  Error?: {
    message: string;
  };
};

export type ClientMessage =
  | { Hello: Record<string, unknown> }
  | { Set: Record<string, unknown> }
  | { State: Record<string, unknown> }
  | { Chat: string }
  | { List: null };

export function createClientFeatures(): ClientFeatures {
  return {
    sharedPlaylists: true,
    chat: true,
    uiMode: 'Web',
    featureList: true,
    readiness: true,
    managedRooms: false,
    persistentRooms: true,
    setOthersReadiness: false,
    fileTransfer: false,
    fileTransferVersion: 0
  };
}

export function buildHelloMessage(args: {
  username: string;
  room: string;
  password?: string;
}): ClientMessage {
  const hello: Record<string, unknown> = {
    username: args.username.trim(),
    room: { name: args.room.trim() },
    version: SYNCPLAY_COMPAT_VERSION,
    realversion: SYNCPLAY_WEB_VERSION,
    features: createClientFeatures()
  };

  if (args.password) {
    hello.password = md5(args.password);
  }

  return { Hello: hello };
}

export function buildFileMessage(file: SyncplayFile): ClientMessage {
  return { Set: { file } };
}

export function buildReadyMessage(isReady: boolean): ClientMessage {
  return {
    Set: {
      ready: {
        isReady,
        manuallyInitiated: true
      }
    }
  };
}

export function buildRoomMessage(room: string): ClientMessage {
  return {
    Set: {
      room: {
        name: room.trim()
      }
    }
  };
}

export function buildStateMessage(args: {
  position: number | null;
  paused: boolean | null;
  doSeek?: boolean;
  latencyCalculation?: number;
  clientLatencyCalculation: number;
  clientRtt: number;
}): ClientMessage {
  const state: {
    playstate?: {
      position: number;
      paused: boolean;
      doSeek?: boolean;
    };
    ping: {
      latencyCalculation?: number;
      clientLatencyCalculation: number;
      clientRtt: number;
    };
  } = {
    ping: {
      clientLatencyCalculation: args.clientLatencyCalculation,
      clientRtt: args.clientRtt
    }
  };

  if (typeof args.latencyCalculation === 'number') {
    state.ping.latencyCalculation = args.latencyCalculation;
  }

  if (typeof args.position === 'number' && typeof args.paused === 'boolean') {
    state.playstate = {
      position: args.position,
      paused: args.paused
    };
    if (args.doSeek) {
      state.playstate.doSeek = true;
    }
  }

  return { State: state };
}

export function encodeMessage(message: ClientMessage): string {
  return `${JSON.stringify(message)}\r\n`;
}

export class LineDecoder {
  private buffer = '';

  push(chunk: string): SyncplayServerMessage[] {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';

    const messages: SyncplayServerMessage[] = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      try {
        messages.push(JSON.parse(line) as SyncplayServerMessage);
      } catch {
        messages.push({ Error: { message: `Could not parse server line: ${line.slice(0, 80)}` } });
      }
    }

    return messages;
  }
}
