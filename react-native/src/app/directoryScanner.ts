type IncomingMediaLibraryItem = { uri: string; name: string; size?: number; duration?: number | null; directory?: string | null };

export type ScanFileLike = {
  uri: string;
  name: string;
  size?: number;
};

export type ScanDirectoryLike = {
  uri: string;
  name: string;
  list(): ScanEntryLike[];
};

export type ScanEntryLike = ScanFileLike | ScanDirectoryLike;

export type DirectoryScanOptions = {
  maxDepth?: number;
  maxFiles?: number;
};

const VIDEO_EXTENSIONS = new Set([
  '.avi',
  '.m4v',
  '.mkv',
  '.mov',
  '.mp4',
  '.mpeg',
  '.mpg',
  '.webm'
]);

export function scanMediaDirectory(
  root: ScanDirectoryLike,
  options: DirectoryScanOptions = {}
): IncomingMediaLibraryItem[] {
  const maxDepth = options.maxDepth ?? 3;
  const maxFiles = options.maxFiles ?? 500;
  const items: IncomingMediaLibraryItem[] = [];

  scan(root, 0);
  return items;

  function scan(directory: ScanDirectoryLike, depth: number) {
    if (items.length >= maxFiles) {
      return;
    }

    for (const entry of directory.list()) {
      if (items.length >= maxFiles) {
        return;
      }

      if (isDirectoryLike(entry)) {
        if (depth < maxDepth) {
          scan(entry, depth + 1);
        }
        continue;
      }

      if (!isVideoFile(entry.name)) {
        continue;
      }

      items.push({
        name: entry.name,
        uri: entry.uri,
        size: entry.size ?? 0,
        duration: null,
        directory: directory.name || null
      });
    }
  }
}

function isDirectoryLike(entry: ScanEntryLike): entry is ScanDirectoryLike {
  return typeof (entry as ScanDirectoryLike).list === 'function';
}

function isVideoFile(name: string): boolean {
  const extension = name.slice(name.lastIndexOf('.')).toLocaleLowerCase();
  return VIDEO_EXTENSIONS.has(extension);
}
