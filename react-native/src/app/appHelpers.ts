import type { DocumentPickerAsset } from 'expo-document-picker';

import type { TransferSession } from '../syncplay/fileTransfer';
import type { IncomingMediaLibraryItem } from '../syncplay/mediaLibrary';

type SyncplayFile = { name: string; duration: number; size: number };

export function isStreamUri(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value);
}

export function isManagedRoomName(room: string): boolean {
  return /^\+.*:\w{12}$/.test(room);
}

export function stripManagedRoomName(room: string): string {
  const match = room.match(/^\+(.*):\w{12}$/);
  return match?.[1] ?? room;
}

export function assetToMediaLibraryItem(asset: DocumentPickerAsset): IncomingMediaLibraryItem {
  return {
    name: asset.name,
    uri: asset.uri,
    size: asset.size ?? 0,
    duration: null,
    directory: null
  };
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'connecting':
      return 'Connecting';
    case 'connected':
      return 'Connected';
    case 'disconnected':
      return 'Disconnected';
    case 'error':
      return 'Connection error';
    default:
      return 'Idle';
  }
}

export function shouldAnnounceMediaOnConnection(
  wasConnected: boolean,
  isConnected: boolean,
  media: SyncplayFile | null
): media is SyncplayFile {
  return !wasConnected && isConnected && media !== null;
}

export function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  const remaining = Math.floor(safe % 60);
  return `${minutes}:${String(remaining).padStart(2, '0')}`;
}

export function formatClockTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export function formatBytes(bytes: number): string {
  if (!bytes) {
    return 'unknown size';
  }
  const megabytes = bytes / 1024 / 1024;
  return `${megabytes.toFixed(megabytes >= 100 ? 0 : 1)} MB`;
}

export type TransferDisplay = {
  label: string;
  detail: string;
  progress: number;
  canRetry: boolean;
};

export function getTransferDisplay(session: TransferSession): TransferDisplay {
  const progress = getTransferProgress(session.transferred, session.size);
  const progressLabel = session.size
    ? `${Math.round(progress * 100)}% · ${formatBytes(session.transferred)} / ${formatBytes(session.size)}`
    : formatBytes(session.transferred);

  switch (session.status) {
    case 'incoming-request':
      return {
        label: 'Approval needed',
        detail: `${session.receiver ?? 'Someone'} wants ${session.file?.name ?? 'this file'}.`,
        progress,
        canRetry: false
      };
    case 'approved':
      return {
        label: 'Connecting',
        detail: session.role === 'sender' ? 'Waiting for the receiver socket.' : 'Opening the download socket.',
        progress,
        canRetry: false
      };
    case 'downloading':
      return {
        label: session.role === 'sender' ? 'Uploading' : 'Downloading',
        detail: progressLabel,
        progress,
        canRetry: false
      };
    case 'paused-local':
      return {
        label: 'Paused',
        detail: `Stopped at ${progressLabel}.`,
        progress,
        canRetry: true
      };
    case 'paused-source-offline':
      return {
        label: 'Paused',
        detail: 'The sender left. Retry after they reconnect.',
        progress,
        canRetry: true
      };
    case 'paused-source-changed-media':
      return {
        label: 'Paused',
        detail: 'The sender changed files. Retry after they switch back.',
        progress,
        canRetry: true
      };
    case 'paused-receiver-offline':
      return {
        label: 'Paused',
        detail: 'The receiver left. Retry after they reconnect.',
        progress,
        canRetry: true
      };
    case 'complete':
      return {
        label: 'Saved',
        detail: session.completedPath ? `Saved to ${session.completedPath}` : progressLabel,
        progress: 1,
        canRetry: false
      };
    case 'cancelled':
      return {
        label: 'Cancelled',
        detail: session.errorMessage ?? 'Transfer cancelled.',
        progress,
        canRetry: false
      };
    case 'failed':
      return {
        label: 'Failed',
        detail: session.errorMessage ?? 'Transfer failed. Retry if both devices are still online.',
        progress,
        canRetry: Boolean(session.token)
      };
    default:
      return {
        label: session.status,
        detail: progressLabel,
        progress,
        canRetry: false
      };
  }
}

function getTransferProgress(transferred: number, size: number | null): number {
  if (!size || size <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, transferred / size));
}

export function shuffleFiles(files: string[], random = Math.random): string[] {
  const shuffled = [...files];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = shuffled[index];
    const swap = shuffled[swapIndex];
    if (current === undefined || swap === undefined) {
      continue;
    }
    shuffled[index] = swap;
    shuffled[swapIndex] = current;
  }

  return shuffled;
}

export type SlashCommandResult =
  | { kind: 'chat'; text: string }
  | { kind: 'me'; action: string }
  | { kind: 'nick'; username: string }
  | { kind: 'topic'; topic: string }
  | { kind: 'help'; commands: string };

export function parseSlashCommand(input: string, username: string): SlashCommandResult | null {
  const trimmed = input.trim();

  if (trimmed === '/help') {
    const commands = [
      '/help — Show this help',
      '/me <action> — Send an action message',
      '/nick <username> — Change your username',
      '/topic <text> — Set room topic'
    ].join('\n');
    return { kind: 'help', commands };
  }

  if (trimmed.startsWith('/me ')) {
    const action = trimmed.slice(4).trim();
    if (!action) {
      return null;
    }
    return { kind: 'me', action };
  }

  if (trimmed.startsWith('/nick ')) {
    const newUsername = trimmed.slice(6).trim();
    if (!newUsername) {
      return null;
    }
    return { kind: 'nick', username: newUsername };
  }

  if (trimmed.startsWith('/topic ')) {
    const topic = trimmed.slice(7).trim();
    if (!topic) {
      return null;
    }
    return { kind: 'topic', topic };
  }

  if (trimmed.startsWith('/')) {
    // Unknown command, send as plain chat
    return { kind: 'chat', text: trimmed };
  }

  // Not a command
  return null;
}
