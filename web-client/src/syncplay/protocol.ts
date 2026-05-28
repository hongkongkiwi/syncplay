import md5 from 'blueimp-md5';

export const SYNCPLAY_COMPAT_VERSION = '1.2.255';
export const SYNCPLAY_WEB_VERSION = '1.7.6-web.1';

export type SyncplayFile = {
  name: string;
  duration: number;
  size: number;
};

// ── Transfer message types ────────────────────────────────────────────────

export type TransferSdpMessage = {
  transferId: string;
  sdp: { type: RTCSdpType; sdp: string };
  role: 'offer' | 'answer';
};

export type TransferIceMessage = {
  transferId: string;
  ice: RTCIceCandidateInit;
};

export type TransferRequestPayload = {
  username: string;
  file?: SyncplayFile;
};

export type TransferOfferPayload = {
  transferId: string;
  username: string;
  file?: SyncplayFile;
};

export type TransferDecisionPayload = {
  transferId: string;
  accepted: boolean;
  fingerprint?: string;
};

export type TransferTicketPayload = {
  transferId: string;
  token: string;
  fingerprint?: string;
};

export type TransferProgressPayload = {
  transferId: string;
  transferred: number;
  size: number | null;
};

export type TransferErrorPayload = {
  transferId: string;
  errorCode: string;
  errorMessage?: string;
};

export type TransferStatusChangePayload = {
  transferId: string;
  status: string;
};

export type TransferCompletePayload = {
  transferId: string;
  size: number;
};

export type TransferFailedPayload = {
  transferId: string;
  errorCode: string;
  errorMessage?: string;
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
  Transfer?: Record<string, unknown>;
};

export type ClientMessage =
  | { Hello: Record<string, unknown> }
  | { Set: Record<string, unknown> }
  | { State: Record<string, unknown> }
  | { Chat: string }
  | { List: null }
  | { Transfer: Record<string, unknown> };

export function createClientFeatures(): ClientFeatures {
  return {
    sharedPlaylists: true,
    chat: true,
    uiMode: 'Web',
    featureList: true,
    readiness: true,
    managedRooms: true,
    persistentRooms: true,
    setOthersReadiness: false,
    fileTransfer: true,
    fileTransferVersion: 1
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
    // NOTE: MD5 is used here for protocol compatibility with the Syncplay server.
    // This is NOT intended as a secure password hash.
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

export function buildNewControlledRoomMessage(roomName: string, password: string): ClientMessage {
  return {
    Set: {
      newControlledRoom: {
        roomName: roomName.trim(),
        password
      }
    }
  };
}

export function buildControllerAuthMessage(room: string, password: string): ClientMessage {
  return {
    Set: {
      controllerAuth: {
        room: room.trim(),
        password: password.toUpperCase()
      }
    }
  };
}

export function buildPlaylistChangeMessage(files: string[]): ClientMessage {
  return {
    Set: {
      playlistChange: {
        files
      }
    }
  };
}

export function buildPlaylistIndexMessage(index: number): ClientMessage {
  return {
    Set: {
      playlistIndex: {
        index
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

// ── Transfer message builders ──────────────────────────────────────────────

export function buildTransferSdpMessage(payload: TransferSdpMessage): ClientMessage {
  return {
    Transfer: {
      sdp: {
        transferId: payload.transferId,
        sdp: { type: payload.sdp.type, sdp: payload.sdp.sdp },
        role: payload.role,
      },
    },
  };
}

export function buildTransferIceMessage(payload: TransferIceMessage): ClientMessage {
  return {
    Transfer: {
      ice: {
        transferId: payload.transferId,
        ice: payload.ice,
      },
    },
  };
}

export function buildTransferRequestMessage(username: string, file?: SyncplayFile | null): ClientMessage {
  const request: Record<string, unknown> = { username };
  if (file) {
    request.file = file;
  }
  return { Transfer: { request } };
}

export function buildTransferDecisionMessage(
  transferId: string,
  accepted: boolean,
  fingerprint?: string,
): ClientMessage {
  const decision: Record<string, unknown> = { transferId, accepted };
  if (fingerprint) {
    decision.fingerprint = fingerprint;
  }
  return { Transfer: { decision } };
}

export function buildTransferPauseMessage(transferId: string): ClientMessage {
  return { Transfer: { pause: { transferId } } };
}

export function buildTransferResumeMessage(transferId: string): ClientMessage {
  return { Transfer: { resume: { transferId } } };
}

export function buildTransferCancelMessage(transferId: string): ClientMessage {
  return { Transfer: { cancel: { transferId } } };
}

const MAX_SERVER_LINE_BYTES = 1_048_576;
const textEncoder = new TextEncoder();

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

export class LineDecoder {
  private buffer = '';

  push(chunk: string): SyncplayServerMessage[] {
    const messages: SyncplayServerMessage[] = [];
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      if (utf8ByteLength(rawLine) > MAX_SERVER_LINE_BYTES) {
        messages.push({ Error: { message: 'Syncplay server line exceeded the 1 MiB limit.' } });
        continue;
      }

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

    if (utf8ByteLength(this.buffer) > MAX_SERVER_LINE_BYTES) {
      this.buffer = '';
      messages.push({ Error: { message: 'Syncplay server line exceeded the 1 MiB limit.' } });
    }

    return messages;
  }
}
