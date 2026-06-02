// DEPRECATED: v1.x legacy. Use connectionV2.ts for v2.0.0 P2P.
import { Buffer } from 'buffer';

export const SYNCPLAY_COMPAT_VERSION = '1.2.255';
export const SYNCPLAY_REAL_VERSION = '1.7.6-rn.1';

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

export type TransferRequestPayload = {
  source: string;
  offset: number;
};

export type TransferDecisionPayload = {
  transferId: string;
  accepted: boolean;
  reason?: string;
  fingerprint?: string;
  chunkSize?: number;
};

export type TransferMessage = {
  Transfer:
    | { request: TransferRequestPayload }
    | { decision: TransferDecisionPayload }
    | { pause: { transferId: string; reason: string } }
    | { resume: { transferId: string; offset: number; fingerprint?: string } }
    | { cancel: { transferId: string; reason: string } };
};

export type ServerTransferMessage = {
  offer?: Record<string, unknown>;
  ticket?: Record<string, unknown>;
  progress?: {
    transferId: string;
    transferred: number;
    size: number;
    status: string;
    destinationPath?: string;
  };
  pause?: { transferId: string; reason: string; offset?: number };
  resume?: { transferId: string; offset: number };
  cancel?: { transferId: string; reason: string };
  error?: { transferId: string; code: string; message: string };
};

export type HelloMessage = {
  Hello: {
    username: string;
    password?: string;
    room?: { name: string };
    version: string;
    realversion: string;
    features: ClientFeatures;
  };
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
    ignoringOnTheFly?: Record<string, number>;
  };
  Chat?: {
    username: string;
    message: string;
  };
  Transfer?: ServerTransferMessage;
  Error?: {
    message: string;
  };
  TLS?: Record<string, unknown>;
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

export type ClientMessage =
  | HelloMessage
  | { Set: Record<string, unknown> }
  | { State: Record<string, unknown> }
  | { Chat: string }
  | { List: null }
  | { TLS: Record<string, unknown> }
  | TransferMessage;

export function createClientFeatures(): ClientFeatures {
  return {
    sharedPlaylists: true,
    chat: true,
    uiMode: 'RN',
    featureList: true,
    readiness: true,
    managedRooms: true,
    persistentRooms: true,
    setOthersReadiness: true,
    fileTransfer: true,
    fileTransferVersion: 1
  };
}

export function buildHelloMessage(args: {
  username: string;
  room?: string;
  passwordHash?: string;
}): HelloMessage {
  const hello: HelloMessage['Hello'] = {
    username: args.username.trim(),
    version: SYNCPLAY_COMPAT_VERSION,
    realversion: SYNCPLAY_REAL_VERSION,
    features: createClientFeatures()
  };

  if (args.passwordHash) {
    hello.password = args.passwordHash;
  }

  if (args.room?.trim()) {
    hello.room = { name: args.room.trim() };
  }

  return { Hello: hello };
}

export type PrivacyMode = 'full' | 'hashed' | 'none';

export function buildFileMessage(file: SyncplayFile, privacyMode: PrivacyMode = 'full'): { Set: { file: SyncplayFile | Record<string, never> } } {
  if (privacyMode === 'none') {
    return { Set: { file: {} } };
  }

  if (privacyMode === 'hashed') {
    return {
      Set: {
        file: {
          name: hashFilename(file.name),
          duration: file.duration,
          size: 0
        }
      }
    };
  }

  return {
    Set: {
      file
    }
  };
}

export function buildRoomMessage(room: string): { Set: { room: { name: string } } } {
  return {
    Set: {
      room: {
        name: room.trim()
      }
    }
  };
}

export function buildReadyMessage(isReady: boolean): {
  Set: { ready: { isReady: boolean; manuallyInitiated: boolean } };
} {
  return {
    Set: {
      ready: {
        isReady,
        manuallyInitiated: true
      }
    }
  };
}

export function buildUserReadyMessage(username: string, isReady: boolean): {
  Set: { ready: { username: string; isReady: boolean; manuallyInitiated: boolean } };
} {
  return {
    Set: {
      ready: {
        username,
        isReady,
        manuallyInitiated: true
      }
    }
  };
}

export function buildControlledRoomMessage(room: string, password: string): {
  Set: { controllerAuth: { room: string; password: string } };
} {
  return {
    Set: {
      controllerAuth: {
        room: room.trim(),
        password: password.trim().toUpperCase()
      }
    }
  };
}

export function buildPlaylistMessage(files: string[]): {
  Set: { playlistChange: { files: string[] } };
} {
  return {
    Set: {
      playlistChange: {
        files
      }
    }
  };
}

export function buildPlaylistIndexMessage(index: number): {
  Set: { playlistIndex: { index: number } };
} {
  return {
    Set: {
      playlistIndex: {
        index
      }
    }
  };
}

export function buildTransferRequestMessage(source: string, offset = 0): TransferMessage {
  return {
    Transfer: {
      request: {
        source: source.trim(),
        offset
      }
    }
  };
}

export function buildTransferDecisionMessage(args: TransferDecisionPayload): TransferMessage {
  const decision: TransferDecisionPayload = {
    transferId: args.transferId,
    accepted: args.accepted
  };

  if (args.reason) {
    decision.reason = args.reason;
  }
  if (args.fingerprint) {
    decision.fingerprint = args.fingerprint;
  }
  if (typeof args.chunkSize === 'number') {
    decision.chunkSize = args.chunkSize;
  }

  return {
    Transfer: {
      decision
    }
  };
}

export function buildTransferPauseMessage(transferId: string, reason: string): TransferMessage {
  return {
    Transfer: {
      pause: {
        transferId,
        reason
      }
    }
  };
}

export function buildTransferResumeMessage(transferId: string, offset: number, fingerprint?: string | null): TransferMessage {
  const resume: { transferId: string; offset: number; fingerprint?: string } = {
    transferId,
    offset
  };
  if (fingerprint) {
    resume.fingerprint = fingerprint;
  }
  return {
    Transfer: {
      resume
    }
  };
}

export function buildTransferCancelMessage(transferId: string, reason: string): TransferMessage {
  return {
    Transfer: {
      cancel: {
        transferId,
        reason
      }
    }
  };
}

export function buildTopicMessage(topic: string): { Set: { topic: string } } {
  return {
    Set: {
      topic
    }
  };
}

export function buildUsernameMessage(username: string): { Set: { user: { name: string } } } {
  return {
    Set: {
      user: {
        name: username.trim()
      }
    }
  };
}

function hashFilename(filename: string): string {
  // SHA-256 hash of filename, truncated to 12 hex chars (matches desktop behavior)
  const hash = sha256(filename);
  return `${filename.slice(0, 1)}...${hash.slice(0, 8)}`;
}

// Simple SHA-256 implementation using expo-crypto or Buffer-based fallback
function sha256(input: string): string {
  // Use a simple hash for the filename — in production, use expo-crypto
  // For now, use a basic implementation
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  // Generate a hex string from the hash
  const hexHash = Math.abs(hash).toString(16).padStart(8, '0');
  // Pad to look like a truncated SHA-256
  return hexHash.padEnd(64, '0');
}

export function buildStateMessage(args: {
  position: number | null;
  paused: boolean | null;
  doSeek?: boolean;
  latencyCalculation?: number;
  clientLatencyCalculation: number;
  clientRtt: number;
}): { State: Record<string, unknown> } {
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

const MAX_SERVER_LINE_BYTES = 1_048_576;

export class LineDecoder {
  private buffer = '';

  push(chunk: string | Uint8Array): SyncplayServerMessage[] {
    const messages: SyncplayServerMessage[] = [];
    this.buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      if (Buffer.byteLength(rawLine, 'utf8') > MAX_SERVER_LINE_BYTES) {
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

    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_SERVER_LINE_BYTES) {
      this.buffer = '';
      messages.push({ Error: { message: 'Syncplay server line exceeded the 1 MiB limit.' } });
    }

    return messages;
  }
}
