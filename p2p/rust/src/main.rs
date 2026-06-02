//! Syncplay P2P — WebSocket signaling server for WebRTC peer discovery.
//!
//! Usage:
//!   syncplay-signaling [--port PORT] [--bind ADDR] [--sfu]
//!
//! In default mode, peers connect via full-mesh WebRTC (P2P).
//! With --sfu, the server acts as a Selective Forwarding Unit:
//!   • Each peer opens ONE WebRTC connection to the server
//!   • The server routes data channel messages between peers
//!   • The server forwards audio tracks (receive from one, send to others)
//!
//! Environment:
//!   PORT — port to listen on (overridden by --port)

use std::net::SocketAddr;
use std::sync::Arc;

use syncplay_p2p::sfu::{SfuConfig, SfuServer};
use syncplay_p2p::signalling::SignalingServer;

fn usage() -> ! {
    eprintln!("Usage: syncplay-signaling [OPTIONS]");
    eprintln!();
    eprintln!("Options:");
    eprintln!("  --port, -p PORT    Port to listen on (default: 8998, env: PORT)");
    eprintln!("  --bind, -b ADDR    Bind address (default: 127.0.0.1)");
    eprintln!("  --sfu              Enable SFU mode (star topology, server routes data + audio)");
    eprintln!("  --tls-cert PATH    TLS certificate file (PEM format, enables wss://)");
    eprintln!("  --tls-key PATH     TLS private key file (PEM format, enables wss://)");
    eprintln!("  --help, -h         Show this help");
    eprintln!("  --version, -V      Show version");
    std::process::exit(0);
}

fn version() -> ! {
    println!("syncplay-signaling v{}", env!("CARGO_PKG_VERSION"));
    std::process::exit(0);
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let mut port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8998);
    let mut bind = "127.0.0.1".to_string();
    let mut sfu_mode = false;
    let mut tls_cert: Option<String> = None;
    let mut tls_key: Option<String> = None;

    let args: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--help" | "-h" => usage(),
            "--version" | "-V" => version(),
            "--port" | "-p" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("--port requires a value");
                    std::process::exit(1);
                }
                port = args[i].parse().unwrap_or_else(|_| {
                    eprintln!("Invalid port: {}", args[i]);
                    std::process::exit(1);
                });
            }
            "--bind" | "-b" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("--bind requires a value");
                    std::process::exit(1);
                }
                bind = args[i].clone();
            }
            "--sfu" => {
                sfu_mode = true;
            }
            "--tls-cert" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("--tls-cert requires a path");
                    std::process::exit(1);
                }
                tls_cert = Some(args[i].clone());
            }
            "--tls-key" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("--tls-key requires a path");
                    std::process::exit(1);
                }
                tls_key = Some(args[i].clone());
            }
            other => {
                eprintln!("Unknown flag: {other}");
                eprintln!("Try --help");
                std::process::exit(1);
            }
        }
        i += 1;
    }

    // Validate TLS flags
    if tls_cert.is_some() != tls_key.is_some() {
        eprintln!("Error: --tls-cert and --tls-key must both be provided (or neither)");
        std::process::exit(1);
    }

    // Load TLS config if both flags provided
    let tls_config: Option<Arc<rustls::ServerConfig>> =
        if let (Some(cert_path), Some(key_path)) = (&tls_cert, &tls_key) {
            let certs = {
                let cert_file = std::fs::File::open(cert_path).unwrap_or_else(|e| {
                    eprintln!("Failed to open TLS cert file {cert_path}: {e}");
                    std::process::exit(1);
                });
                let mut reader = std::io::BufReader::new(cert_file);
                rustls_pemfile::certs(&mut reader)
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap_or_else(|e| {
                        eprintln!("Failed to parse TLS cert file {cert_path}: {e}");
                        std::process::exit(1);
                    })
            };
            if certs.is_empty() {
                eprintln!("Error: no certificates found in {cert_path}");
                std::process::exit(1);
            }

            let key = {
                let key_file = std::fs::File::open(key_path).unwrap_or_else(|e| {
                    eprintln!("Failed to open TLS key file {key_path}: {e}");
                    std::process::exit(1);
                });
                let mut reader = std::io::BufReader::new(key_file);
                rustls_pemfile::private_key(&mut reader)
                    .unwrap_or_else(|e| {
                        eprintln!("Failed to parse TLS key file {key_path}: {e}");
                        std::process::exit(1);
                    })
                    .unwrap_or_else(|| {
                        eprintln!("Error: no private key found in {key_path}");
                        std::process::exit(1);
                    })
            };

            let config = rustls::ServerConfig::builder()
                .with_no_client_auth()
                .with_single_cert(certs, key)
                .unwrap_or_else(|e| {
                    eprintln!("Failed to build TLS config: {e}");
                    std::process::exit(1);
                });
            Some(Arc::new(config))
        } else {
            None
        };

    let addr: SocketAddr = format!("{bind}:{port}").parse()?;

    let mode_label = if sfu_mode { "SFU" } else { "P2P" };
    let proto = if tls_config.is_some() { "wss" } else { "ws" };
    eprintln!(
        "Syncplay signaling server v{} ({mode_label} mode, {proto}://), listening on {addr}",
        env!("CARGO_PKG_VERSION")
    );

    let server = if sfu_mode {
        let sfu = SfuServer::new(SfuConfig::default()).await?;
        SignalingServer::new().with_sfu(sfu)
    } else {
        SignalingServer::new()
    };

    server.run(addr, tls_config).await?;

    Ok(())
}
