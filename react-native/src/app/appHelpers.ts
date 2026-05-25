import type { DocumentPickerAsset } from 'expo-document-picker';

import type { IncomingMediaLibraryItem } from '../syncplay/mediaLibrary';

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

export function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  const remaining = Math.floor(safe % 60);
  return `${minutes}:${String(remaining).padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (!bytes) {
    return 'unknown size';
  }
  const megabytes = bytes / 1024 / 1024;
  return `${megabytes.toFixed(megabytes >= 100 ? 0 : 1)} MB`;
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
