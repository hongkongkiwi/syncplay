export type MediaLibraryItem = {
  name: string;
  uri: string;
  size: number;
  duration: number | null;
  directory: string | null;
};

export type IncomingMediaLibraryItem = {
  name?: string | null;
  uri: string;
  size?: number | null;
  duration?: number | null;
  directory?: string | null;
};

export function addMediaItems(
  existingItems: MediaLibraryItem[],
  incomingItems: IncomingMediaLibraryItem[]
): MediaLibraryItem[] {
  const itemsByUri = new Map(existingItems.map(item => [item.uri, item]));

  for (const incomingItem of incomingItems) {
    if (!incomingItem.uri || itemsByUri.has(incomingItem.uri)) {
      continue;
    }

    itemsByUri.set(incomingItem.uri, normalizeMediaItem(incomingItem));
  }

  return Array.from(itemsByUri.values());
}

export function findMediaByName(
  items: MediaLibraryItem[],
  filename: string | null | undefined
): MediaLibraryItem | null {
  const target = normalizeFilename(filename);
  if (!target) {
    return null;
  }

  return items.find(item => normalizeFilename(item.name) === target) ?? null;
}

export function buildDirectoryLabels(items: MediaLibraryItem[]): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];

  for (const item of items) {
    if (!item.directory || seen.has(item.directory)) {
      continue;
    }

    seen.add(item.directory);
    labels.push(item.directory);
  }

  return labels;
}

export function getFilenameFromPath(path: string | null | undefined): string {
  if (!path) {
    return '';
  }

  const cleanPath = stripQueryAndHash(path);
  const parts = cleanPath.split(/[\\/]/).filter(Boolean);
  const filename = parts.at(-1) ?? cleanPath;
  return decodePathPart(filename);
}

function normalizeMediaItem(item: IncomingMediaLibraryItem): MediaLibraryItem {
  const name = item.name?.trim() || getFilenameFromPath(item.uri) || 'video';
  return {
    name,
    uri: item.uri,
    size: item.size ?? 0,
    duration: item.duration ?? null,
    directory: item.directory?.trim() || getDirectoryLabel(item.uri)
  };
}

function normalizeFilename(filename: string | null | undefined): string {
  return getFilenameFromPath(filename).trim().toLocaleLowerCase();
}

function getDirectoryLabel(uri: string): string | null {
  const cleanUri = stripQueryAndHash(uri);
  const parts = cleanUri.split(/[\\/]/).filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  const directory = parts[parts.length - 2];
  return directory ? decodePathPart(directory) || null : null;
}

function stripQueryAndHash(path: string): string {
  return path.split(/[?#]/, 1)[0] ?? path;
}

function decodePathPart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}
