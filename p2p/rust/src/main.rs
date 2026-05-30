//! Syncplay P2P Signaling Server Binary
//!
//! Usage:
//!   syncplay-signaling [--port 8998]
//!
//! Replaces: `cd p2p/signaling-server && npm start`

use std::net::SocketAddr;

use syncplay_p2p::signalling::SignalingServer;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8998);

    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let server = SignalingServer::new();
    server.run(addr).await?;

    Ok(())
}
