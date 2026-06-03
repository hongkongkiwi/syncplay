//! Syncplay TURN relay server.
//!
//! Lightweight TURN server for NAT traversal. Peers behind symmetric NAT
//! that can't establish direct WebRTC connections will relay media through
//! this server.
//!
//! Usage:
//!   syncplay-turn --public-ip 203.0.113.1 --users alice=secret,bob=secret
//!
//! The server allocates relay ports dynamically on the same machine.
//! Configure peers to use this relay with:
//!   --turn turn:user:pass@public-ip:3478
//!
//! For production, run behind coturn or a dedicated TURN deployment.
//! This binary is suitable for small groups (up to ~50 concurrent allocations).

use std::collections::HashMap;
use std::env;
use std::net::IpAddr;
use std::str::FromStr;
use std::sync::Arc;

use tokio::net::UdpSocket;
use tokio::signal;
use tokio::time::Duration;
use turn::auth::*;
use turn::relay::relay_static::*;
use turn::server::config::*;
use turn::server::*;
use webrtc_util::vnet::net::*;

struct StaticAuthHandler {
    cred_map: HashMap<String, Vec<u8>>,
}

impl StaticAuthHandler {
    fn new(cred_map: HashMap<String, Vec<u8>>) -> Self {
        Self { cred_map }
    }
}

impl AuthHandler for StaticAuthHandler {
    fn auth_handle(
        &self,
        username: &str,
        _realm: &str,
        _src_addr: std::net::SocketAddr,
    ) -> Result<Vec<u8>, turn::Error> {
        self.cred_map
            .get(username)
            .cloned()
            .ok_or(turn::Error::ErrFakeErr)
    }
}

fn print_usage() {
    eprintln!("Syncplay TURN relay server v{}", env!("CARGO_PKG_VERSION"));
    eprintln!();
    eprintln!("Usage: syncplay-turn [OPTIONS]");
    eprintln!();
    eprintln!("Options:");
    eprintln!("  --public-ip <IP>     Public IP address (required)");
    eprintln!("  --port <PORT>        Listening port [default: 3478]");
    eprintln!("  --users <LIST>       Comma-separated user=pass pairs (required)");
    eprintln!("  --realm <REALM>      Authentication realm [default: syncplay]");
    eprintln!("  --help, -h           Show this help");
    eprintln!("  --version, -V        Show version");
    eprintln!();
    eprintln!("Example:");
    eprintln!("  syncplay-turn --public-ip 203.0.113.1 --users alice=secret,bob=secret");
    eprintln!();
    eprintln!("Then connect peers with:");
    eprintln!("  syncplay-tui --turn turn:alice:secret@203.0.113.1:3478");
}

fn parse_args() -> Result<(String, u16, String, String), String> {
    let args: Vec<String> = env::args().collect();

    let mut public_ip = None;
    let mut port: u16 = 3478;
    let mut users = None;
    let mut realm = "syncplay".to_string();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--public-ip" => {
                i += 1;
                public_ip = Some(args.get(i).ok_or("--public-ip requires a value")?.clone());
            }
            "--port" => {
                i += 1;
                port = args
                    .get(i)
                    .ok_or("--port requires a value")?
                    .parse::<u16>()
                    .map_err(|_| "Invalid port number")?;
            }
            "--users" => {
                i += 1;
                users = Some(args.get(i).ok_or("--users requires a value")?.clone());
            }
            "--realm" => {
                i += 1;
                realm = args.get(i).ok_or("--realm requires a value")?.clone();
            }
            "--help" | "-h" => {
                print_usage();
                std::process::exit(0);
            }
            "--version" | "-V" => {
                println!("syncplay-turn v{}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            other => return Err(format!("Unknown argument: {other}")),
        }
        i += 1;
    }

    let public_ip = public_ip.ok_or("--public-ip is required")?;
    let users = users.ok_or("--users is required")?;

    Ok((public_ip, port, users, realm))
}

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let (public_ip, port, users, realm) = match parse_args() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("Error: {e}");
            eprintln!();
            print_usage();
            std::process::exit(1);
        }
    };

    // Parse user credentials and generate auth keys
    let mut cred_map = HashMap::new();
    for pair in users.split(',') {
        let parts: Vec<&str> = pair.splitn(2, '=').collect();
        if parts.len() != 2 {
            eprintln!("Error: invalid user format '{}' — expected user=pass", pair);
            std::process::exit(1);
        }
        let key = generate_auth_key(parts[0], &realm, parts[1]);
        cred_map.insert(parts[0].to_owned(), key);
    }

    // Bind UDP socket
    let conn = match UdpSocket::bind(format!("0.0.0.0:{port}")).await {
        Ok(c) => Arc::new(c),
        Err(e) => {
            eprintln!("Failed to bind UDP port {port}: {e}");
            std::process::exit(1);
        }
    };

    let local_addr = match conn.local_addr() {
        Ok(addr) => addr,
        Err(e) => {
            eprintln!("Failed to get local address: {e}");
            std::process::exit(1);
        }
    };
    log::info!("TURN relay listening on {local_addr}");
    log::info!("Public IP: {public_ip}");
    log::info!("Realm: {realm}");
    log::info!(
        "Users: {}",
        cred_map.keys().cloned().collect::<Vec<_>>().join(", ")
    );

    let public_ip_addr = IpAddr::from_str(&public_ip).unwrap_or_else(|e| {
        eprintln!("Invalid public IP '{}': {}", public_ip, e);
        std::process::exit(1);
    });

    let server = match Server::new(ServerConfig {
        conn_configs: vec![ConnConfig {
            conn,
            relay_addr_generator: Box::new(RelayAddressGeneratorStatic {
                relay_address: public_ip_addr,
                address: "0.0.0.0".to_owned(),
                net: Arc::new(Net::new(None)),
            }),
        }],
        realm,
        auth_handler: Arc::new(StaticAuthHandler::new(cred_map)),
        channel_bind_timeout: Duration::from_secs(0), // 0 = use library default (10 min)
        alloc_close_notify: None,
    })
    .await
    {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Failed to start TURN server: {e}");
            std::process::exit(1);
        }
    };

    log::info!("TURN relay ready — Ctrl-C to stop");

    match signal::ctrl_c().await {
        Ok(()) => {
            log::info!("Shutting down...");
        }
        Err(e) => {
            log::error!("Signal error: {e}");
        }
    }

    if let Err(e) = server.close().await {
        log::error!("Error closing server: {e}");
    }

    log::info!("TURN relay stopped");
}
