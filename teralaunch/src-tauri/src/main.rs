#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Standard library imports
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Once, RwLock};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime};

// Third-party imports
use dotenv::dotenv;
use log::{LevelFilter, error, info};
use tokio::sync::{watch, Mutex, mpsc};
use tokio::io::AsyncWriteExt;
use rayon::prelude::*;
use tokio::runtime::Runtime;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Manager};
use tauri::api::dialog::FileDialogBuilder;
use teralib::{get_game_status_receiver, run_game, reset_global_state};
use teralib::config::get_config_value;
use reqwest::Client;
use lazy_static::lazy_static;
use ini::Ini;
use sha2::{Sha256, Digest};
use futures_util::StreamExt;
use indicatif::{ProgressBar, ProgressStyle}; // Should be in file_handler.rs if only used there
use walkdir::WalkDir; // Should be in file_handler.rs if only used there

mod file_handler; // Declare the new module
// Use necessary items from the new module
use crate::file_handler::{FileInfo, ProgressPayload, FileCheckProgress, CachedFileInfo}; // Already present
mod config_handler; // Declare the new config_handler module
mod auth_handler; // Declare the new auth_handler module
mod game_handler; // Declare the new game_handler module
// Structs LoginResponse, AuthInfo, GlobalAuthInfo and static GLOBAL_AUTH_INFO are now in auth_handler.rs
// GameState struct is now in game_handler.rs


// Struct definitions (LoginResponse, AuthInfo, GlobalAuthInfo moved to auth_handler.rs)
// GameState struct moved to game_handler.rs



/* const CONFIG: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/config/config.json"));

lazy_static::lazy_static! {
    static ref CONFIG_JSON: Value = serde_json::from_str(CONFIG).expect("Failed to parse config");
} */

// Structs FileInfo, ProgressPayload, FileCheckProgress, CachedFileInfo are now in file_handler.rs

// GameState is now in game_handler.rs

// HASH_CACHE is now in file_handler.rs

// Helper functions like is_ignored, get_server_hash_file, calculate_file_hash, 
// get_cache_file_path, save_cache_to_disk, load_cache_from_disk,
// get_hash_file_url, get_files_server_url, format_bytes are now in file_handler.rs
// Tauri command functions generate_hash_file, select_game_folder, check_update_required, 
// update_file, download_all_files, get_files_to_update are now in file_handler.rs
// Note: get_game_path is still here for now, but depends on load_config.
// load_config and find_config_file are still here.
// save_game_path_to_config and get_game_path_from_config are still here.

// Config related functions (find_config_file, load_config) remain for now
// Config related functions (find_config_file, load_config, get_game_path)
// and Tauri commands (save_game_path_to_config, get_game_path_from_config, 
// get_language_from_config, save_language_to_config)
// are now moved to config_handler.rs.

// get_game_path is also removed from here as it's now in config_handler.rs
// and file_handler.rs uses `crate::config_handler::get_game_path`.

// GlobalAuthInfo static is now in auth_handler.rs

// get_game_status, handle_launch_game, and reset_launch_state functions are moved to game_handler.rs

// set_auth_info is now auth_handler::set_auth_info
// login is now auth_handler::login
// handle_logout is now auth_handler::handle_logout

#[tauri::command]
async fn check_server_connection() -> Result<bool, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    match client.get(get_files_server_url()).send().await {
        Ok(response) => Ok(response.status().is_success()),
        Err(e) => Err(e.to_string()),
    }
}


fn main() {


    dotenv().ok();

    let (tera_logger, mut tera_log_receiver) = teralib::setup_logging();

    // Configure only the teralib logger
    log::set_boxed_logger(Box::new(tera_logger)).expect("Failed to set logger");
    log::set_max_level(LevelFilter::Info);

    // Create an asynchronous channel for logs
    let (log_sender, mut log_receiver) = mpsc::channel::<String>(100);

    // Create a Tokio runtime
    let rt = Runtime::new().expect("Failed to create Tokio runtime");

    // Spawn a task to receive logs and send them through the channel
    rt.spawn(async move {
        while let Some(log_message) = tera_log_receiver.recv().await {
            println!("Teralib: {}", log_message);
            if let Err(e) = log_sender.send(log_message).await {
                eprintln!("Failed to send log message: {}", e);
            }
        }
    });


    let game_status_receiver = get_game_status_receiver();
    // Initialize GameState from game_handler module
    let game_state = game_handler::GameState { // Use game_handler::GameState
        status_receiver: Arc::new(Mutex::new(game_status_receiver)),
        is_launching: Arc::new(Mutex::new(false)),
    };

    tauri::Builder
        ::default()
        .manage(game_state) // Manage the new GameState type
        .setup(|app| {
            let window = app.get_window("main").unwrap();
            let app_handle = app.handle();
            println!("Tauri setup started");

            #[cfg(debug_assertions)]
            window.open_devtools();

            // Spawn an asynchronous task to receive logs from the channel and send them to the frontend
            tauri::async_runtime::spawn(async move {
                while let Some(log_message) = log_receiver.recv().await {
                    let _ = app_handle.emit_all("log_message", log_message);
                }
            });

            println!("Tauri setup completed");


            Ok(())
        })
        .invoke_handler(
            tauri::generate_handler![
                game_handler::handle_launch_game, // Updated path
                game_handler::get_game_status,    // Updated path
                file_handler::select_game_folder,
                config_handler::get_game_path_from_config,
                config_handler::save_game_path_to_config,
                game_handler::reset_launch_state, // Updated path
                auth_handler::login,                     
                auth_handler::set_auth_info,             
                config_handler::get_language_from_config,
                config_handler::save_language_to_config,
                file_handler::get_files_to_update,
                file_handler::update_file,
                auth_handler::handle_logout, 
                file_handler::generate_hash_file,
                check_server_connection, 
                file_handler::check_update_required,
                file_handler::download_all_files,
            ]
        )
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
