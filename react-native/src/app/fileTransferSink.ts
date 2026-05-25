import { Directory, File, Paths } from 'expo-file-system';

import type { TransferFileSink, TransferFileSource } from '../syncplay/transferSocket';

export type ExpoTransferSink = TransferFileSink & {
  destinationPath: string;
  partPath: string;
  getOffset(): number;
};

export function createExpoTransferSink(filename: string, directory: Directory = Paths.document): ExpoTransferSink {
  const safeName = sanitizeFilename(filename);
  const destination = new File(directory, safeName);
  const part = new File(directory, `.syncplay-download.${safeName}.part`);

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
    readAll() {
      return file.bytes();
    }
  };
}

function sanitizeFilename(filename: string): string {
  const trimmed = filename.trim().split(/[\\/]/).filter(Boolean).at(-1);
  return trimmed || 'syncplay-download';
}
