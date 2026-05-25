import { findMediaByName, type MediaLibraryItem } from '../syncplay/mediaLibrary';
import { isStreamUri } from './appHelpers';

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
