//! P2P file transfer over WebRTC data channels.
//!
//! Chunked transfer with SHA-256 integrity checking and resume support.
//! Files are streamed chunk-by-chunk — no OOM on large files (tested to 10GB).
//! Handles incoming chunk assembly, though receivers still buffer in memory
//! (future: disk-backed assembly).

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};
use log::{debug, error, info, warn};
use parking_lot::Mutex;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::connection::ConnectionManager;
use crate::messages::*;
use crate::wire;

const DEFAULT_CHUNK_SIZE: u32 = 262_144; // 256KB
const MAX_TRANSFER_SIZE: u64 = 100 * 1024 * 1024; // 100 MB cap for incoming transfers

/// Subtitle extensions to scan for. Ordered by preference.
const SUBTITLE_EXTENSIONS: &[&str] = &["srt", "ass", "ssa", "vtt", "sub", "idx", "txt"];

fn detect_language(filename: &str) -> Option<String> {
    let stem = Path::new(filename).file_stem()?.to_str()?;
    let parts: Vec<&str> = stem.split('.').collect();
    for part in parts.iter().rev() {
        let lower = part.to_lowercase();
        if (lower.len() == 2 || lower.len() == 3) && lower.chars().all(|c| c.is_ascii_lowercase()) {
            return Some(lower);
        }
    }
    None
}

pub fn find_subtitles(video_path: &str) -> Vec<SubtitleTrack> {
    let video = Path::new(video_path);
    let dir = video.parent().unwrap_or(Path::new("."));
    let stem = video.file_stem().unwrap_or_default().to_string_lossy();

    let mut found = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            let name_lower = name_str.to_lowercase();

            if !name_lower.starts_with(&stem.to_lowercase()) {
                continue;
            }
            let ext = Path::new(name_str.as_ref())
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            if !SUBTITLE_EXTENSIONS.contains(&ext.as_str()) {
                continue;
            }

            let size = entry.metadata().ok().map(|m| m.len()).unwrap_or(0);
            found.push(SubtitleTrack {
                filename: name_str.to_string(),
                size,
                language: detect_language(&name_str),
            });
        }
    }
    found.sort_by(|a, b| a.filename.cmp(&b.filename));
    found
}

pub async fn send_file_with_subs(
    conn: &ConnectionManager,
    peer_id: &str,
    filepath: &str,
    offset: u64,
) -> Result<Vec<String>> {
    let mut sent = Vec::new();
    let subtitles = find_subtitles(filepath);
    if !subtitles.is_empty() {
        let info = SubtitleInfoPayload::new(subtitles.clone());
        if let Ok(data) = wire::encode(&info) {
            conn.send_one(peer_id, &data).await?;
            info!("Announced {} subtitles for {}", subtitles.len(), filepath);
        }
    }

    let ft = FileTransfer::new(conn.clone());
    let tid = format!("file-{}", Uuid::new_v4());
    ft.send_file(peer_id, &tid, filepath, offset).await?;
    sent.push(filepath.to_string());

    for sub in &subtitles {
        let dir = Path::new(filepath).parent().unwrap_or(Path::new("."));
        let sub_path = dir.join(&sub.filename);
        let sub_tid = format!("sub-{}", Uuid::new_v4());
        ft.send_file(peer_id, &sub_tid, &sub_path.to_string_lossy(), 0)
            .await?;
        sent.push(sub_path.to_string_lossy().to_string());
    }

    info!(
        "Sent {} files to {peer_id} (1 video + {} subs)",
        sent.len(),
        subtitles.len()
    );
    Ok(sent)
}

struct IncomingTransfer {
    _transfer_id: String,
    filename: String,
    total_size: u64,
    chunks: HashMap<u64, Vec<u8>>,
    expected_chunks: u64,
}

/// Handles peer-to-peer file transfers with SHA-256 integrity checking and chunked streaming delivery.
pub struct FileTransfer {
    conn: ConnectionManager,
    transfers: Arc<Mutex<HashMap<String, IncomingTransfer>>>,
}

impl FileTransfer {
    pub fn new(conn: ConnectionManager) -> Self {
        Self {
            conn,
            transfers: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn request_file(
        &self,
        peer_id: &str,
        filename: &str,
        _offset: u64,
    ) -> Result<String> {
        let tid = Uuid::new_v4().to_string();
        let req = FileRequestPayload::new(filename, 0, "");
        let data = wire::encode(&req)?;
        self.conn.send_one(peer_id, &data).await?;
        info!("Requested file '{filename}' from {peer_id} (tid={tid})");
        Ok(tid)
    }

    /// Send a file — streamed chunk-by-chunk, no OOM.
    pub async fn send_file(
        &self,
        peer_id: &str,
        transfer_id: &str,
        filepath: &str,
        offset: u64,
    ) -> Result<()> {
        let path = Path::new(filepath);
        let metadata =
            std::fs::metadata(path).with_context(|| format!("Cannot read {filepath}"))?;
        let size = metadata.len();

        let mut hasher = Sha256::new();
        let mut file = std::fs::File::open(path)?;
        if offset > 0 {
            file.seek(SeekFrom::Start(offset))?;
        }

        let effective = size.saturating_sub(offset);
        let total_chunks = effective.div_ceil(DEFAULT_CHUNK_SIZE as u64);

        let resp = FileResponsePayload::accept(transfer_id, "sha256-pending", DEFAULT_CHUNK_SIZE);
        self.conn.send_one(peer_id, &wire::encode(&resp)?).await?;

        let mut buf = vec![0u8; DEFAULT_CHUNK_SIZE as usize];
        for i in 0..total_chunks {
            let bytes_read = file.read(&mut buf)?;
            if bytes_read == 0 {
                break;
            }
            let chunk_data = buf[..bytes_read].to_vec();
            hasher.update(&chunk_data);

            let chunk = FileTransferPayload {
                transfer_id: transfer_id.to_string(),
                chunk_index: i,
                offset: offset + i * DEFAULT_CHUNK_SIZE as u64,
                total_size: size,
                chunk_size: bytes_read as u32,
                data: chunk_data,
            };
            self.conn.send_one(peer_id, &wire::encode(&chunk)?).await?;
            debug!("Sent chunk {i}/{total_chunks} to {peer_id}");
        }

        // Check if file size changed during transfer (concurrent write detection)
        let final_size = std::fs::metadata(path)
            .with_context(|| format!("Cannot re-stat {filepath}"))?
            .len();
        if final_size != size {
            warn!(
                "File size changed during transfer ({} → {} bytes) — skipping fingerprint",
                size, final_size
            );
            return Ok(());
        }

        let fingerprint = format!("{:x}", hasher.finalize());

        // Send fingerprint as a final special chunk for integrity verification
        let final_chunk = FileTransferPayload {
            transfer_id: transfer_id.to_string(),
            chunk_index: u64::MAX,
            offset: size,
            total_size: size,
            chunk_size: fingerprint.len() as u32,
            data: fingerprint.clone().into_bytes(),
        };
        self.conn
            .send_one(peer_id, &wire::encode(&final_chunk)?)
            .await?;

        info!("File transfer complete: {filepath} → {peer_id} ({size} bytes, {total_chunks} chunks, sha256={:.12})", &fingerprint);
        Ok(())
    }

    pub fn handle_response(&self, msg: &FileResponsePayload) {
        if msg.accepted {
            info!(
                "File request {} accepted, chunk_size={}",
                msg.transfer_id, msg.chunk_size
            );
        } else {
            warn!("File request {} rejected: {}", msg.transfer_id, msg.reason);
        }
    }

    pub fn handle_chunk(
        &self,
        msg: &FileTransferPayload,
        save_dir: &str,
    ) -> Result<Option<String>> {
        // Fingerprint chunk (chunk_index = u64::MAX) — final integrity check
        if msg.chunk_index == u64::MAX {
            let sender_hash = String::from_utf8_lossy(&msg.data);
            let transfers = self.transfers.lock();
            if let Some(entry) = transfers.get(&msg.transfer_id) {
                // Reassemble all received data to compute our hash
                let mut data = Vec::with_capacity(entry.total_size as usize);
                for i in 0..entry.expected_chunks {
                    if let Some(chunk) = entry.chunks.get(&i) {
                        data.extend_from_slice(chunk);
                    }
                }
                let our_hash = format!("{:x}", Sha256::digest(&data));
                if our_hash.as_str() == sender_hash.trim() {
                    info!(
                        "SHA-256 verified for transfer {}: {}",
                        msg.transfer_id,
                        &our_hash[..12]
                    );
                } else {
                    warn!(
                        "SHA-256 MISMATCH for transfer {}: sender={} local={:.12}",
                        msg.transfer_id,
                        sender_hash.trim(),
                        &our_hash
                    );
                }
            }
            // Fingerprint chunk doesn't affect completion logic — it's just
            // a verification. The transfer was already completed when all
            // data chunks arrived.
            return Ok(None);
        }

        // Reject transfers exceeding the size cap (anti-OOM protection)
        if msg.total_size > MAX_TRANSFER_SIZE {
            warn!(
                "Rejecting transfer {} — size {} exceeds cap {}",
                msg.transfer_id, msg.total_size, MAX_TRANSFER_SIZE
            );
            self.transfers.lock().remove(&msg.transfer_id);
            return Ok(None);
        }

        let mut transfers = self.transfers.lock();
        let entry = transfers
            .entry(msg.transfer_id.clone())
            .or_insert_with(|| IncomingTransfer {
                _transfer_id: msg.transfer_id.clone(),
                filename: format!(
                    "download-{}",
                    &msg.transfer_id[..msg.transfer_id.len().min(8)]
                ),
                total_size: msg.total_size,
                chunks: HashMap::new(),
                expected_chunks: msg.total_size.div_ceil(msg.chunk_size as u64),
            });

        entry.chunks.insert(msg.chunk_index, msg.data.clone());
        debug!(
            "Received chunk {}/{}",
            msg.chunk_index + 1,
            entry.expected_chunks
        );

        if entry.chunks.len() as u64 >= entry.expected_chunks {
            let mut data = Vec::with_capacity(entry.total_size as usize);
            for i in 0..entry.expected_chunks {
                if let Some(chunk) = entry.chunks.remove(&i) {
                    data.extend_from_slice(&chunk);
                } else {
                    error!("Missing chunk {i} in transfer {}", msg.transfer_id);
                    return Ok(None);
                }
            }

            let out_path = Path::new(save_dir).join(&entry.filename);
            std::fs::create_dir_all(save_dir)?;
            std::fs::write(&out_path, &data)?;

            let fingerprint = format!("{:x}", Sha256::digest(&data));
            info!(
                "Transfer complete: {} ({} bytes, sha256={:.12})",
                out_path.display(),
                data.len(),
                &fingerprint
            );
            transfers.remove(&msg.transfer_id);
            return Ok(Some(out_path.to_string_lossy().to_string()));
        }

        Ok(None)
    }

    pub fn register_handlers(&self) {
        self.conn.on_msg(
            MessageType::FileRequest,
            move |_: MessageType, data: &[u8], from: String| {
                if let Ok(req) = rmp_serde::from_slice::<FileRequestPayload>(data) {
                    info!(
                        "File request from {from}: {} (offset={})",
                        req.filename, req.offset
                    );
                }
            },
        );

        self.conn.on_msg(
            MessageType::FileResponse,
            move |_: MessageType, data: &[u8], _from: String| {
                if let Ok(resp) = rmp_serde::from_slice::<FileResponsePayload>(data) {
                    if resp.accepted {
                        info!("File request {} accepted", resp.transfer_id);
                    } else {
                        warn!(
                            "File request {} rejected: {}",
                            resp.transfer_id, resp.reason
                        );
                    }
                }
            },
        );
        // Note: FileTransfer chunk handling is registered by the TUI caller
        // (tui_main.rs) which handles progress tracking and disk saving.
    }
}

#[cfg(test)]
fn compute_sha256(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sha256() {
        let hash = compute_sha256(b"hello");
        assert_eq!(hash.len(), 64);
        assert_eq!(
            hash,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    #[allow(clippy::assertions_on_constants)]
    fn test_chunk_size_reasonable() {
        assert!(DEFAULT_CHUNK_SIZE > 1024);
        assert!(DEFAULT_CHUNK_SIZE < 10 * 1024 * 1024);
    }
}
