# File Transfers

Syncplay P2P v2.0 uses direct peer-to-peer file transfers over WebRTC data channels. There is no server relay — files go directly from sender to receiver.

## Architecture

- **Chunked transfer**: 256 KB default chunk size (configurable), streamed chunk-by-chunk to avoid memory issues with large files.
- **SHA-256 integrity**: Sender computes incremental SHA-256 during transfer. Final chunk (`chunkIndex = u64::MAX`) contains the fingerprint. Receiver verifies.
- **Resume support**: `FileRequest` includes an `offset` field for resuming interrupted transfers.
- **Anti-OOM protection**: Max incoming transfer size capped at 100 MB. Max 3 concurrent incoming transfers. Stale transfers (5 min inactivity) are auto-evicted.
- **Rate limiting**: Optional bytes/sec throttle on sending side.

## Protocol Messages

### FileRequest (0x0A)
Sent by the receiver to initiate or resume a transfer.

- `transferId`: UUID
- `filename`: requested filename on sender's side
- `offset`: resume offset (0 = from start)
- `fingerprint`: expected SHA-256 (empty = skip verification)

### FileResponse (0x0B)
Sent by the sender to accept or reject.

- `transferId`: UUID matching request
- `accepted`: boolean
- `reason`: rejection reason if not accepted
- `fingerprint`: SHA-256 of file being sent
- `chunkSize`: chunk size for this transfer

### FileTransfer (0x09)
Binary chunk data, sent directly peer-to-peer.

- `transferId`: UUID
- `chunkIndex`: sequence number (u64)
- `offset`: byte offset in file
- `totalSize`: total file size
- `chunkSize`: bytes in this chunk
- `data`: raw bytes (up to 256 KB)

Final verification chunk has `chunkIndex = 0xFFFFFFFFFFFFFFFF` (u64::MAX). Receiver assembles all chunks, computes SHA-256, and compares with fingerprint.

## Subtitle Bundling

When sending a video file, `send_file_with_subs()` automatically detects subtitle files in the same directory (7 formats: .srt, .ass, .ssa, .vtt, .sub, .idx, .txt). Subtitles are sent as separate file transfers following the main video.

## File Info (0x08)

Peers broadcast their currently loaded file metadata:

- `username`: who is sharing
- `file`: optional `{ name, duration, size, checksum? }` or null to clear

## Client APIs

### Rust (p2p/rust/src/file_transfer.rs)
```rust
// Send a video file with auto-detected subtitles
send_file_with_subs(&conn, peer_id, filepath, offset).await?;

// Request a file from a peer
ft.request_file(peer_id, filename, offset).await?;

// Cancel a transfer
ft.cancel(transfer_id);

// Set transfer rate throttle (bytes/sec, 0 = unlimited)
ft.set_throttle(bytes_per_sec);
```

### TypeScript (packages/p2p-client)
```typescript
// Send a file via 256KB chunks with SHA-256 verification
await stateManager.sendFile(file: File | Blob, targetPeerId?: string): Promise<string | null>

// Request a file from a peer
stateManager.requestFile(peerId, filename, offset?);

// Cancel an in-progress transfer
stateManager.cancelTransfer(transferId);
```

## Limits

| Limit | Value |
|-------|-------|
| Default chunk size | 256 KB |
| Max incoming transfer size | 100 MB |
| Max concurrent incoming transfers | 3 |
| Stale transfer eviction | 5 min inactivity |
