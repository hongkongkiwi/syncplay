import type { SyncplayFile } from './protocol';

export type TransferStatus =
  | 'incoming-request'
  | 'approved'
  | 'downloading'
  | 'paused-local'
  | 'paused-source-offline'
  | 'paused-source-changed-media'
  | 'paused-receiver-offline'
  | 'complete'
  | 'failed'
  | 'cancelled';

export const TRANSFER_STATUSES: readonly TransferStatus[] = [
  'incoming-request',
  'approved',
  'downloading',
  'paused-local',
  'paused-source-offline',
  'paused-source-changed-media',
  'paused-receiver-offline',
  'complete',
  'failed',
  'cancelled'
];

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
  fingerprint?: string | null;
  offset: number;
  completedPath?: string | null;
};

export function createIncomingTransfer(payload: Record<string, unknown>): TransferSession | null {
  const transferId = parseTransferId(payload.transferId);
  if (!transferId) {
    return null;
  }
  const offset = typeof payload.offset === 'number' && Number.isFinite(payload.offset) && payload.offset >= 0
    ? payload.offset
    : 0;
  return {
    transferId,
    role: 'sender',
    status: 'incoming-request',
    source: typeof payload.source === 'string' ? payload.source : null,
    receiver: typeof payload.receiver === 'string' ? payload.receiver : null,
    file: isSyncplayFile(payload.file) ? payload.file : null,
    transferred: 0,
    size: isSyncplayFile(payload.file) ? payload.file.size : null,
    offset
  };
}

export function parseTransferId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

export function isTransferStatus(value: unknown): value is TransferStatus {
  return typeof value === 'string' && TRANSFER_STATUSES.includes(value as TransferStatus);
}

export function statusFromTransferError(code: string): TransferStatus {
  if (code === 'source-offline') {
    return 'paused-source-offline';
  }
  if (code === 'source-changed-media') {
    return 'paused-source-changed-media';
  }
  if (code === 'receiver-offline') {
    return 'paused-receiver-offline';
  }
  if (code === 'cancelled') {
    return 'cancelled';
  }
  return 'failed';
}

function isSyncplayFile(file: unknown): file is SyncplayFile {
  const duration = (file as SyncplayFile | null)?.duration;
  const size = (file as SyncplayFile | null)?.size;
  return (
    !!file &&
    typeof (file as SyncplayFile).name === 'string' &&
    typeof duration === 'number' &&
    Number.isFinite(duration) &&
    duration >= 0 &&
    typeof size === 'number' &&
    Number.isFinite(size) &&
    size >= 0
  );
}
