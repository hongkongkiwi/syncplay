#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::SocketAddr;
use std::sync::Arc;
use syncplay_p2p::signalling::SignalingServer;
use tauri::Manager;

pub fn run() {
    let addr: SocketAddr = "127.0.0.1:8998".parse().unwrap();
    let server = Arc::new(SignalingServer::new());
    let server_clone = server.clone();

    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            println!("Signaling server on {}", addr);
            if let Err(e) = server_clone.run(addr, None).await {
                eprintln!("Signaling error: {}", e);
            }
        });
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            app.manage(server.clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(srv) = window.try_state::<Arc<SignalingServer>>() {
                    srv.shutdown();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error running app");
}
