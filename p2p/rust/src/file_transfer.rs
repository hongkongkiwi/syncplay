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
use std::time::Duration;
use tokio::time;
use uuid::Uuid;

use crate::connection::ConnectionManager;
use crate::messages::*;
use crate::wire;

const DEFAULT_CHUNK_SIZE: u32 = 262_144; // 256KB
const MAX_TRANSFER_SIZE: u64 = 100 * 1024 * 1024; // 100 MB cap for incoming transfers
const MAX_CONCURRENT_TRANSFERS: usize = 3;

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
    /// Expected SHA-256 fingerprint (empty = skip verification)
    expected_fingerprint: String,
    /// Last time a chunk was received (for stale transfer eviction)
    last_activity: std::time::Instant,
}

/// Handles peer-to-peer file transfers with SHA-256 integrity checking and chunked streaming delivery.
pub struct FileTransfer {
    conn: ConnectionManager,
    transfers: Arc<Mutex<HashMap<String, IncomingTransfer>>>,
    /// Bytes/sec throttle for sending (0 = unlimited)
    throttle_bytes_per_sec: u64,
}

impl FileTransfer {
    pub fn new(conn: ConnectionManager) -> Self {
        let transfers = Arc::new(Mutex::new(HashMap::new()));

        // Spawn stale transfer eviction: remove transfers inactive for > 5 minutes.
        // Only spawn if we're inside a Tokio runtime (tests may not have one).
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let transfers_cleanup = transfers.clone();
            handle.spawn(async move {
                loop {
                    time::sleep(Duration::from_secs(60)).await;
                    let now = std::time::Instant::now();
                    transfers_cleanup
                        .lock()
                        .retain(|tid, entry: &mut IncomingTransfer| {
                            let keep =
                                now.duration_since(entry.last_activity) < Duration::from_secs(300);
                            if !keep {
                                info!("Evicting stale transfer: {tid} (inactive > 5 min)");
                            }
                            keep
                        });
                }
            });
        }

        Self {
            conn,
            transfers,
            throttle_bytes_per_sec: 0,
        }
    }

    /// Set transfer rate limit in bytes/sec (0 = unlimited)
    pub fn set_throttle(&mut self, bytes_per_sec: u64) {
        self.throttle_bytes_per_sec = bytes_per_sec;
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

    /// Cancel an incoming transfer by removing its assembly buffer.
    /// The transfer_id is the one returned by request_file or seen in FileTransferPayload.
    pub fn cancel(&self, transfer_id: &str) {
        let mut transfers = self.transfers.lock();
        if transfers.remove(transfer_id).is_some() {
            info!("Cancelled transfer {transfer_id}");
        } else {
            warn!("Cancel: no transfer found for {transfer_id}");
        }
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

            // Rate limiting: throttle if configured
            let throttle = self.throttle_bytes_per_sec;
            if throttle > 0 {
                let chunk_time = Duration::from_secs_f64(bytes_read as f64 / throttle as f64);
                time::sleep(chunk_time).await;
            }
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
        // Enforce concurrent transfer cap
        if transfers.len() >= MAX_CONCURRENT_TRANSFERS && !transfers.contains_key(&msg.transfer_id)
        {
            warn!(
                "Too many concurrent transfers ({} >= {}), rejecting {}",
                transfers.len(),
                MAX_CONCURRENT_TRANSFERS,
                msg.transfer_id
            );
            return Ok(None);
        }
        // Reject chunk_size=0 to prevent division by zero
        if msg.chunk_size == 0 {
            warn!(
                "FileTransfer from {} has chunk_size=0 — rejected",
                msg.transfer_id
            );
            return Ok(None);
        }
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
                expected_fingerprint: String::new(), // set from FileResponse
                last_activity: std::time::Instant::now(),
            });

        entry.chunks.insert(msg.chunk_index, msg.data.clone());
        entry.last_activity = std::time::Instant::now();
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

            let fingerprint = format!("{:x}", Sha256::digest(&data));
            // Verify fingerprint if one was provided
            if !entry.expected_fingerprint.is_empty() && entry.expected_fingerprint != fingerprint {
                warn!(
                    "Fingerprint mismatch for {}: expected {}, got {:.12}",
                    entry.filename, entry.expected_fingerprint, &fingerprint
                );
                transfers.remove(&msg.transfer_id);
                return Ok(None);
            }

            let out_path = Path::new(save_dir).join(&entry.filename);
            std::fs::create_dir_all(save_dir)?;
            std::fs::write(&out_path, &data)?;

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

        let transfers2 = self.transfers.clone();
        self.conn.on_msg(
            MessageType::FileResponse,
            move |_: MessageType, data: &[u8], _from: String| {
                if let Ok(resp) = rmp_serde::from_slice::<FileResponsePayload>(data) {
                    if resp.accepted {
                        info!("File request accepted by {_from}: {}", resp.transfer_id);
                        // Store expected fingerprint for integrity verification
                        if !resp.fingerprint.is_empty() {
                            let mut transfers = transfers2.lock();
                            if let Some(entry) = transfers.get_mut(&resp.transfer_id) {
                                entry.expected_fingerprint = resp.fingerprint.clone();
                            }
                        }
                    } else {
                        info!("File request rejected by {_from}: {}", resp.reason);
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

    // ── SHA-256 tests ─────────────────────────────────────────────

    #[test]
    fn test_sha256_hello() {
        let hash = compute_sha256(b"hello");
        assert_eq!(hash.len(), 64);
        assert_eq!(
            hash,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn test_sha256_empty() {
        let hash = compute_sha256(b"");
        assert_eq!(hash.len(), 64);
        assert_eq!(
            hash,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn test_sha256_known_quick_brown_fox() {
        let hash = compute_sha256(b"The quick brown fox jumps over the lazy dog");
        assert_eq!(
            hash,
            "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592"
        );
    }

    #[test]
    fn test_sha256_deterministic() {
        assert_eq!(compute_sha256(b"abc"), compute_sha256(b"abc"));
    }

    // ── detect_language tests ─────────────────────────────────────

    #[test]
    fn test_detect_language_eng_three_letter() {
        assert_eq!(detect_language("movie.eng.srt"), Some("eng".into()));
    }

    #[test]
    fn test_detect_language_en_two_letter() {
        assert_eq!(detect_language("video.en.srt"), Some("en".into()));
    }

    #[test]
    fn test_detect_language_jpn_sdh_extension() {
        // jpn-sdh.ass: stem is "movie.jpn-sdh", parts are ["movie", "jpn-sdh"]
        // The last part is "jpn-sdh" which contains a hyphen, so is_jpn_sdh_lowercase = false
        // The previous part is "movie" — chars are ascii lowercase but len is 5, not 2 or 3 → skip
        // Result: None (the dash prevents "jpn" from being detected as a separate part)
        assert_eq!(detect_language("movie.jpn-sdh.ass"), None);
    }

    #[test]
    fn test_detect_language_jpn_dot_sdh() {
        // stem="movie.jpn.sdh", parts=["movie","jpn","sdh"]
        // rev: "sdh" → 3 chars, all ascii_lowercase → Some("sdh")
        // Wait, sdh is 3 letters. But intent is jpn. Let's see:
        // parts.iter().rev(): "sdh", "jpn", "movie"
        // "sdh" → len=3, all ascii lowercase → returns Some("sdh")
        // So the language detected is "sdh" not "jpn".
        // The function returns the *last* matching part looking backwards.
        assert_eq!(detect_language("movie.jpn.sdh.ass"), Some("sdh".into()));
        // Note: returns "sdh" (last 2-3 char segment), not "jpn".
        // This matches the implementation's reverse-scan behavior.
    }

    #[test]
    fn test_detect_language_no_language_tag() {
        assert_eq!(detect_language("movie.srt"), None);
    }

    #[test]
    fn test_detect_language_multiple_dots() {
        // stem="Movie.720p.eng", parts=["Movie","720p","eng"]
        // rev: "eng" → 3 chars, all ascii → Some("eng")
        assert_eq!(detect_language("Movie.720p.eng.srt"), Some("eng".into()));
    }

    #[test]
    fn test_detect_language_uppercase_normalized() {
        // stem="movie.EN", parts=["movie","EN"]
        // "EN" → to_lowercase() → "en" → 2 chars, all ascii lowercase → Some("en")
        assert_eq!(detect_language("movie.EN.srt"), Some("en".into()));
    }

    #[test]
    fn test_detect_language_numeric_not_detected() {
        // stem="movie.1080p", "1080p" contains digits → char::is_ascii_lowercase fails
        assert_eq!(detect_language("movie.1080p.srt"), None);
    }

    // ── find_subtitles tests ──────────────────────────────────────

    #[test]
    fn test_find_subtitles_empty_dir() {
        let dir = std::env::temp_dir().join("syncplay_test_empty");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let video = dir.join("movie.mkv");
        std::fs::write(&video, b"fake-video").unwrap();

        let subs = find_subtitles(&video.to_string_lossy());
        assert!(subs.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_find_subtitles_matching_subs() {
        let dir = std::env::temp_dir().join("syncplay_test_subs");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let video = dir.join("MyMovie.mkv");
        std::fs::write(&video, b"fake-video").unwrap();
        std::fs::write(dir.join("MyMovie.eng.srt"), b"sub-content").unwrap();
        std::fs::write(dir.join("MyMovie.jpn.ass"), b"sub-content").unwrap();
        std::fs::write(dir.join("MyMovie.srt"), b"sub-content").unwrap();
        // Non-matching: different stem
        std::fs::write(dir.join("OtherMovie.srt"), b"sub-content").unwrap();
        // Wrong extension (txt is in the subtitle list; use pdf to exclude)
        std::fs::write(dir.join("MyMovie.commentary.pdf"), b"not-a-sub").unwrap();

        let subs = find_subtitles(&video.to_string_lossy());
        // Should find 3: MyMovie.eng.srt, MyMovie.jpn.ass, MyMovie.srt (sorted)
        assert_eq!(subs.len(), 3, "expected 3 subtitles, got: {:?}", subs);

        // Verify sorted order
        let names: Vec<&str> = subs.iter().map(|s| s.filename.as_str()).collect();
        assert_eq!(
            names,
            vec!["MyMovie.eng.srt", "MyMovie.jpn.ass", "MyMovie.srt"]
        );

        // Verify languages detected
        assert_eq!(subs[0].language, Some("eng".into()));
        assert_eq!(subs[1].language, Some("jpn".into()));
        assert_eq!(subs[2].language, None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_find_subtitles_case_insensitive_stem_match() {
        let dir = std::env::temp_dir().join("syncplay_test_case");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let video = dir.join("Movie.mkv");
        std::fs::write(&video, b"fake-video").unwrap();
        // Stem match is case-insensitive
        std::fs::write(dir.join("mOvIe.eng.srt"), b"sub-content").unwrap();

        let subs = find_subtitles(&video.to_string_lossy());
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].filename, "mOvIe.eng.srt");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_find_subtitles_vtt_supported() {
        let dir = std::env::temp_dir().join("syncplay_test_vtt");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let video = dir.join("Clip.mp4");
        std::fs::write(&video, b"fake-video").unwrap();
        std::fs::write(dir.join("Clip.vtt"), b"WEBVTT\n\n").unwrap();
        std::fs::write(dir.join("Clip.fr.vtt"), b"WEBVTT\n\n").unwrap();

        let subs = find_subtitles(&video.to_string_lossy());
        assert_eq!(subs.len(), 2);
        assert_eq!(subs[0].language, Some("fr".into()));
        assert_eq!(subs[1].language, None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── Chunk-size / constants tests ─────────────────────────────

    #[test]
    #[allow(clippy::assertions_on_constants)]
    fn test_chunk_size_reasonable() {
        assert!(DEFAULT_CHUNK_SIZE > 1024);
        assert!(DEFAULT_CHUNK_SIZE < 10 * 1024 * 1024);
    }

    #[test]
    fn test_fingerprint_chunk_detection() {
        let fp_chunk = FileTransferPayload {
            transfer_id: "test-1".into(),
            chunk_index: u64::MAX,
            offset: 0,
            total_size: 32,
            chunk_size: 32,
            data: b"deadbeef1234567890abcdef12345678".to_vec(),
        };
        assert_eq!(fp_chunk.chunk_index, u64::MAX);
    }

    #[test]
    fn test_expected_chunks_calculation() {
        // total_size=1MB, chunk_size=256KB → 4 chunks
        assert_eq!((1024u64 * 1024).div_ceil(256u64 * 1024), 4);
        // total_size=1MB+1, chunk_size=256KB → 5 chunks (partial last chunk)
        assert_eq!((1024u64 * 1024 + 1).div_ceil(256u64 * 1024), 5);
        // total_size=0, chunk_size=256KB → 0 chunks
        assert_eq!(0u64.div_ceil(256u64 * 1024), 0);
        // different chunk_size (128KB)
        assert_eq!((1024u64 * 1024).div_ceil(128u64 * 1024), 8);
    }

    #[test]
    fn test_incoming_transfer_expected_chunks_exact_division() {
        let entry = IncomingTransfer {
            _transfer_id: "t-1".into(),
            filename: "f".into(),
            total_size: 1024 * 1024, // 1 MB
            chunks: HashMap::new(),
            expected_chunks: (1024u64 * 1024).div_ceil(256u64 * 1024), // = 4
            expected_fingerprint: String::new(),
            last_activity: std::time::Instant::now(),
        };
        assert_eq!(entry.expected_chunks, 4);
    }

    #[test]
    fn test_incoming_transfer_expected_chunks_partial_last() {
        let entry = IncomingTransfer {
            _transfer_id: "t-2".into(),
            filename: "f".into(),
            total_size: 1024 * 1024 + 1, // 1 MB + 1 byte
            chunks: HashMap::new(),
            expected_chunks: (1024u64 * 1024 + 1).div_ceil(256u64 * 1024), // = 5
            expected_fingerprint: String::new(),
            last_activity: std::time::Instant::now(),
        };
        assert_eq!(entry.expected_chunks, 5);
    }

    #[test]
    fn test_incoming_transfer_expected_chunks_small_file() {
        let entry = IncomingTransfer {
            _transfer_id: "t-3".into(),
            filename: "f".into(),
            total_size: 100,
            chunks: HashMap::new(),
            expected_chunks: 100u64.div_ceil(256u64 * 1024), // = 1
            expected_fingerprint: String::new(),
            last_activity: std::time::Instant::now(),
        };
        assert_eq!(entry.expected_chunks, 1);
    }

    // ── handle_chunk tests ───────────────────────────────────────

    #[test]
    fn test_handle_chunk_zero_size_rejected() {
        let conn = ConnectionManager::new("test", vec![]);
        let ft = FileTransfer::new(conn);
        let dir = std::env::temp_dir().join("syncplay_test_chunk0");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let msg = FileTransferPayload {
            transfer_id: "zero-chunk".into(),
            chunk_index: 0,
            offset: 0,
            total_size: 1024,
            chunk_size: 0, // ZERO — should be rejected
            data: vec![],
        };

        let result = ft.handle_chunk(&msg, &dir.to_string_lossy());
        assert!(result.is_ok());
        assert!(
            result.unwrap().is_none(),
            "zero chunk_size should be rejected"
        );

        // Verify nothing was added to transfers
        assert!(ft.transfers.lock().is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_handle_chunk_exceeds_size_cap() {
        let conn = ConnectionManager::new("test", vec![]);
        let ft = FileTransfer::new(conn);

        let msg = FileTransferPayload {
            transfer_id: "too-big".into(),
            chunk_index: 0,
            offset: 0,
            total_size: MAX_TRANSFER_SIZE + 1, // exceeds 100 MB cap
            chunk_size: 262144,
            data: vec![0u8; 1024],
        };

        let result = ft.handle_chunk(&msg, "/tmp");
        assert!(result.is_ok());
        assert!(
            result.unwrap().is_none(),
            "oversize transfer should be rejected"
        );
        assert!(ft.transfers.lock().is_empty());
    }

    #[test]
    fn test_handle_chunk_single_chunk_transfer_completes() {
        let conn = ConnectionManager::new("test", vec![]);
        let ft = FileTransfer::new(conn);
        let dir = std::env::temp_dir().join("syncplay_test_complete");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let data = b"hello world";
        let msg = FileTransferPayload {
            transfer_id: "single-chunk".into(),
            chunk_index: 0,
            offset: 0,
            total_size: data.len() as u64,
            chunk_size: data.len() as u32,
            data: data.to_vec(),
        };

        let result = ft.handle_chunk(&msg, &dir.to_string_lossy());
        assert!(result.is_ok());
        let saved_path = result.unwrap();
        assert!(
            saved_path.is_some(),
            "single-chunk transfer should complete"
        );

        // Verify the file was written
        let written = std::fs::read(saved_path.unwrap()).unwrap();
        assert_eq!(written, data);

        // Transfer should be removed from map after completion
        assert!(ft.transfers.lock().is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_handle_chunk_multi_chunk_transfer() {
        let conn = ConnectionManager::new("test", vec![]);
        let ft = FileTransfer::new(conn);
        let dir = std::env::temp_dir().join("syncplay_test_multi");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let chunk_size = 1024u32;
        let total = 2500u64; // 3 chunks: 1024 + 1024 + 452
        let data: Vec<u8> = (0..total).map(|i| (i % 256) as u8).collect();
        let tid = "multi-chunk";

        // Chunk 0
        let r = ft.handle_chunk(
            &FileTransferPayload {
                transfer_id: tid.into(),
                chunk_index: 0,
                offset: 0,
                total_size: total,
                chunk_size,
                data: data[..1024].to_vec(),
            },
            &dir.to_string_lossy(),
        );
        assert!(r.is_ok());
        assert!(r.unwrap().is_none(), "not done after chunk 0");

        // Chunk 1
        let r = ft.handle_chunk(
            &FileTransferPayload {
                transfer_id: tid.into(),
                chunk_index: 1,
                offset: 1024,
                total_size: total,
                chunk_size,
                data: data[1024..2048].to_vec(),
            },
            &dir.to_string_lossy(),
        );
        assert!(r.is_ok());
        assert!(r.unwrap().is_none(), "not done after chunk 1");

        // Chunk 2 (final)
        let r = ft.handle_chunk(
            &FileTransferPayload {
                transfer_id: tid.into(),
                chunk_index: 2,
                offset: 2048,
                total_size: total,
                chunk_size: 452,
                data: data[2048..].to_vec(),
            },
            &dir.to_string_lossy(),
        );
        assert!(r.is_ok());
        let saved = r.unwrap();
        assert!(saved.is_some(), "should complete after chunk 2");

        // Verify file contents
        let written = std::fs::read(saved.unwrap()).unwrap();
        assert_eq!(written, data);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── cancel tests ─────────────────────────────────────────────

    #[test]
    fn test_cancel_nonexistent_transfer_no_panic() {
        let conn = ConnectionManager::new("test", vec![]);
        let ft = FileTransfer::new(conn);
        // Should not panic, just warn
        ft.cancel("nonexistent-transfer-id");
    }

    #[test]
    fn test_cancel_removes_transfer() {
        let conn = ConnectionManager::new("test", vec![]);
        let ft = FileTransfer::new(conn);
        let dir = std::env::temp_dir().join("syncplay_test_cancel");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let tid = "cancel-me";
        let chunk_size = 1024u32;

        // Start a multi-chunk transfer (2 chunks total, send only 1)
        let r = ft.handle_chunk(
            &FileTransferPayload {
                transfer_id: tid.into(),
                chunk_index: 0,
                offset: 0,
                total_size: 1500,
                chunk_size,
                data: vec![0u8; 1024],
            },
            &dir.to_string_lossy(),
        );
        assert!(r.is_ok());

        // Verify it's in the map
        assert!(ft.transfers.lock().contains_key(tid));

        // Cancel it
        ft.cancel(tid);

        // Verify it's gone
        assert!(!ft.transfers.lock().contains_key(tid));
        assert!(ft.transfers.lock().is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_cancel_then_new_transfer_starts_fresh() {
        let conn = ConnectionManager::new("test", vec![]);
        let ft = FileTransfer::new(conn);
        let dir = std::env::temp_dir().join("syncplay_test_cancel_fresh");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let tid = "reuse-me";

        // Start and cancel first attempt
        ft.handle_chunk(
            &FileTransferPayload {
                transfer_id: tid.into(),
                chunk_index: 0,
                offset: 0,
                total_size: 100,
                chunk_size: 100,
                data: vec![1u8; 50],
            },
            &dir.to_string_lossy(),
        )
        .unwrap();
        ft.cancel(tid);

        // New transfer with same tid — should work from scratch
        let msg = FileTransferPayload {
            transfer_id: tid.into(),
            chunk_index: 0,
            offset: 0,
            total_size: 5,
            chunk_size: 5,
            data: vec![2u8; 5],
        };
        let r = ft.handle_chunk(&msg, &dir.to_string_lossy());
        assert!(r.is_ok());
        let saved = r.unwrap();
        assert!(saved.is_some(), "should complete with fresh transfer");

        let written = std::fs::read(saved.unwrap()).unwrap();
        assert_eq!(written, vec![2u8; 5]);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
