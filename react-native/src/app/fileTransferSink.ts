import { Directory, File, FileMode, Paths } from 'expo-file-system';

import type { TransferFileSink, TransferFileSource } from '../syncplay/transferSocket';

export type ExpoTransferSink = TransferFileSink & {
  destinationPath: string;
  partPath: string;
  getOffset(): number;
};

export function createExpoTransferSink(transferId: string, filename: string, directory: Directory = Paths.document): ExpoTransferSink {
  const safeName = sanitizeFilename(filename);
  const safeTransferId = sanitizeFilename(transferId);
  const destination = new File(directory, safeName);
  const part = new File(directory, `.syncplay-download.${safeTransferId}.${safeName}.part`);

  if (!part.exists) {
    part.create({ intermediates: true, overwrite: true });
  }

  return {
    destinationPath: destination.uri,
    partPath: part.uri,
    getOffset() {
      return part.exists ? part.info().size ?? 0 : 0;
    },
    write(chunk: Uint8Array) {
      part.write(chunk, { append: true });
    },
    finalize() {
      part.moveSync(destination, { overwrite: true });
      return destination.uri;
    }
  };
}

export function createExpoTransferSource(uri: string): TransferFileSource {
  const file = new File(uri);
  return {
    read(offset: number, length: number) {
      const handle = file.open(FileMode.ReadOnly);
      try {
        handle.offset = offset;
        return handle.readBytes(length);
      } finally {
        handle.close();
      }
    }
  };
}

function sanitizeFilename(filename: string): string {
  const trimmed = filename.trim().split(/[\\/]/).filter(Boolean).at(-1);
  return trimmed || 'syncplay-download';
}
