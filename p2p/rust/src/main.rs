//! Syncplay P2P — WebSocket signaling server for WebRTC peer discovery.
//!
//! Usage:
//!   syncplay-signaling [--port PORT] [--bind ADDR]
//!
//! Environment:
//!   PORT — port to listen on (overridden by --port)

use std::net::SocketAddr;

use syncplay_p2p::signalling::SignalingServer;

fn usage() -> ! {
    eprintln!("Usage: syncplay-signaling [OPTIONS]");
    eprintln!();
    eprintln!("Options:");
    eprintln!("  --port, -p PORT    Port to listen on (default: 8998, env: PORT)");
    eprintln!("  --bind, -b ADDR    Bind address (default: 127.0.0.1)");
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
            other => {
                eprintln!("Unknown flag: {other}");
                eprintln!("Try --help");
                std::process::exit(1);
            }
        }
        i += 1;
    }

    let addr: SocketAddr = format!("{bind}:{port}").parse()?;
    let server = SignalingServer::new();
    eprintln!(
        "Syncplay signaling server v{}, listening on {addr}",
        env!("CARGO_PKG_VERSION")
    );
    server.run(addr).await?;

    Ok(())
}
