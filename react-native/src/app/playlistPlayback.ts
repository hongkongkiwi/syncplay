type MediaLibraryItem = { name: string; uri: string; size: number; duration: number | null; directory: string | null };

function findMediaByName(items: MediaLibraryItem[], name: string): MediaLibraryItem | undefined {
  const stripped = (name.replace(/^.*[\\/]/, '').split('?')[0] ?? '').split('#')[0] ?? '';
  return items.find(item => {
    const itemName = (item.name.replace(/^.*[\\/]/, '').split('?')[0] ?? '').split('#')[0] ?? '';
    return itemName.toLowerCase() === stripped.toLowerCase();
  });
}

function isStreamUri(uri: string): boolean {
  return /^(https?:\/\/|rtmp:\/\/|rtsp:\/\/)/i.test(uri);
}

export type PlaylistResolution =
  | { kind: 'none' }
  | { kind: 'stream'; uri: string }
  | { kind: 'local'; item: MediaLibraryItem }
  | { kind: 'missing'; filename: string };

export function resolvePlaylistItem(
  files: string[],
  index: number | null,
  mediaLibrary: MediaLibraryItem[]
): PlaylistResolution {
  if (index === null || index < 0 || index >= files.length) {
    return { kind: 'none' };
  }

  const item = files[index];
  if (!item) {
    return { kind: 'none' };
  }

  if (isStreamUri(item)) {
    return { kind: 'stream', uri: item };
  }

  const libraryItem = findMediaByName(mediaLibrary, item);
  if (libraryItem) {
    return { kind: 'local', item: libraryItem };
  }

  return { kind: 'missing', filename: item };
}
