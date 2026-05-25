import type { SyncplayFile } from './protocol';

export type TransferStatus =
  | 'incoming-request'
  | 'approved'
  | 'downloading'
  | 'paused-local'
  | 'paused-source-offline'
  | 'paused-source-changed-media'
  | 'complete'
  | 'failed'
  | 'cancelled';

export type TransferSession = {
  transferId: string;
  role: 'sender' | 'receiver' | null;
  status: TransferStatus;
  source?: string | null;
  receiver?: string | null;
  file?: SyncplayFile | null;
  transferred: number;
  size: number | null;
  token?: string | null;
  offset: number;
  completedPath?: string | null;
};

export function createIncomingTransfer(payload: Record<string, unknown>): TransferSession {
  return {
    transferId: String(payload.transferId),
    role: 'sender',
    status: 'incoming-request',
    source: typeof payload.source === 'string' ? payload.source : null,
    receiver: typeof payload.receiver === 'string' ? payload.receiver : null,
    file: isSyncplayFile(payload.file) ? payload.file : null,
    transferred: 0,
    size: isSyncplayFile(payload.file) ? payload.file.size : null,
    offset: typeof payload.offset === 'number' ? payload.offset : 0
  };
}

export function statusFromTransferError(code: string): TransferStatus {
  if (code === 'source-offline') {
    return 'paused-source-offline';
  }
  if (code === 'source-changed-media') {
    return 'paused-source-changed-media';
  }
  if (code === 'cancelled') {
    return 'cancelled';
  }
  return 'failed';
}

function isSyncplayFile(file: unknown): file is SyncplayFile {
  return (
    !!file &&
    typeof (file as SyncplayFile).name === 'string' &&
    typeof (file as SyncplayFile).duration === 'number' &&
    typeof (file as SyncplayFile).size === 'number'
  );
}
