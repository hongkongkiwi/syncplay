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
use syncplay_p2p::signalling::{SignalingConfig, SignalingServer};

fn usage() -> ! {
    eprintln!("Usage: syncplay-signaling [OPTIONS]");
    eprintln!();
    eprintln!("Options:");
    eprintln!("  --port, -p PORT          Port to listen on (default: 8998, env: PORT)");
    eprintln!("  --bind, -b ADDR          Bind address (default: 127.0.0.1)");
    eprintln!(
        "  --sfu                    Enable SFU mode (star topology, server routes data + audio)"
    );
    eprintln!("  --tls-cert PATH          TLS certificate file (PEM format, enables wss://)");
    eprintln!("  --tls-key PATH           TLS private key file (PEM format, enables wss://)");
    eprintln!("  --max-conn N             Max total connections (default: 5000)");
    eprintln!("  --max-conn-per-ip N      Max connections per IP (default: 50)");
    eprintln!("  --max-rooms N            Max rooms (default: 10000)");
    eprintln!("  --max-peers-per-room N   Max peers per room (default: 100)");
    eprintln!("  --help, -h               Show this help");
    eprintln!("  --version, -V            Show version");
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

    // DoS protection defaults
    let mut max_conn: usize = 5000;
    let mut max_conn_per_ip: usize = 50;
    let mut max_rooms: usize = 10_000;
    let mut max_peers_per_room: usize = 100;

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
            "--max-conn" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("--max-conn requires a value");
                    std::process::exit(1);
                }
                max_conn = args[i].parse().unwrap_or_else(|_| {
                    eprintln!("Invalid --max-conn value: {}", args[i]);
                    std::process::exit(1);
                });
            }
            "--max-conn-per-ip" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("--max-conn-per-ip requires a value");
                    std::process::exit(1);
                }
                max_conn_per_ip = args[i].parse().unwrap_or_else(|_| {
                    eprintln!("Invalid --max-conn-per-ip value: {}", args[i]);
                    std::process::exit(1);
                });
            }
            "--max-rooms" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("--max-rooms requires a value");
                    std::process::exit(1);
                }
                max_rooms = args[i].parse().unwrap_or_else(|_| {
                    eprintln!("Invalid --max-rooms value: {}", args[i]);
                    std::process::exit(1);
                });
            }
            "--max-peers-per-room" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("--max-peers-per-room requires a value");
                    std::process::exit(1);
                }
                max_peers_per_room = args[i].parse().unwrap_or_else(|_| {
                    eprintln!("Invalid --max-peers-per-room value: {}", args[i]);
                    std::process::exit(1);
                });
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

    // Build server config with DoS protection limits
    let server_config = SignalingConfig {
        max_connections_total: max_conn,
        max_connections_per_ip: max_conn_per_ip,
        max_rooms,
        max_peers_per_room,
        ..SignalingConfig::default()
    };

    let server = if sfu_mode {
        let sfu = SfuServer::new(SfuConfig::default()).await?;
        SignalingServer::new_with_config(server_config).with_sfu(sfu)
    } else {
        SignalingServer::new_with_config(server_config)
    };

    let server = Arc::new(server);

    // Set up graceful shutdown on SIGTERM/SIGINT
    let server_shutdown = {
        let srv = server.clone();
        tokio::spawn(async move {
            #[cfg(unix)]
            {
                use tokio::signal::unix::{signal, SignalKind};
                let mut sigterm =
                    signal(SignalKind::terminate()).expect("failed to register SIGTERM handler");
                let mut sigint =
                    signal(SignalKind::interrupt()).expect("failed to register SIGINT handler");
                tokio::select! {
                    _ = sigterm.recv() => {
                        eprintln!("\nReceived SIGTERM, shutting down gracefully...");
                    }
                    _ = sigint.recv() => {
                        eprintln!("\nReceived SIGINT, shutting down gracefully...");
                    }
                }
            }
            #[cfg(not(unix))]
            {
                tokio::signal::ctrl_c().await.ok();
                eprintln!("\nReceived Ctrl+C, shutting down gracefully...");
            }
            srv.shutdown();
        })
    };

    server.run(addr, tls_config).await?;

    // Wait for shutdown handler to complete
    server_shutdown.await.ok();

    Ok(())
}
