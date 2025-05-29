// Game handler module for TeraLaunch

use std::sync::Arc;
use tauri::{self, AppHandle, Manager, State};
use tokio::sync::{watch, Mutex};
use log::{info, error};

use teralib::{get_game_status_receiver, run_game, reset_global_state}; // Corrected, get_game_status_receiver is not used directly here
use crate::config_handler; 
use crate::auth_handler::GLOBAL_AUTH_INFO;

// Struct definition (copied from main.rs)
#[derive(Debug)] 
pub struct GameState {
    pub status_receiver: Arc<Mutex<watch::Receiver<bool>>>, // This is how main.rs initializes it
    pub is_launching: Arc<Mutex<bool>>,
}

#[tauri::command]
pub async fn get_game_status(state: State<'_, GameState>) -> Result<bool, String> {
    let status_receiver_guard = state.status_receiver.lock().await;
    let status = *status_receiver_guard.borrow();
    drop(status_receiver_guard); // Release lock ASAP

    let is_launching_guard = state.is_launching.lock().await;
    let launching = *is_launching_guard;
    drop(is_launching_guard); // Release lock ASAP
    
    Ok(status || launching)
}

#[tauri::command]
pub async fn handle_launch_game(
    app_handle: AppHandle, // Changed from tauri::AppHandle for consistency
    state: State<'_, GameState>
) -> Result<String, String> {
    info!("handle_launch_game called");
    let mut is_launching_guard = state.is_launching.lock().await;
    if *is_launching_guard {
        return Err("Game is already launching".to_string());
    }
    *is_launching_guard = true;
    drop(is_launching_guard); // Release lock before async operations or long running tasks

    let status_receiver_guard = state.status_receiver.lock().await;
    let is_running = *status_receiver_guard.borrow();
    drop(status_receiver_guard);

    if is_running {
        let mut is_launching_guard_on_error = state.is_launching.lock().await;
        *is_launching_guard_on_error = false;
        drop(is_launching_guard_on_error);
        return Err("Game is already running".to_string());
    }

    let auth_info_lock = GLOBAL_AUTH_INFO.read().map_err(|e| format!("Failed to read auth info: {}", e))?;
    let account_name = auth_info_lock.user_no.to_string();
    let characters_count = auth_info_lock.character_count.clone();
    let ticket = auth_info_lock.auth_key.clone();
    drop(auth_info_lock); 

    let (game_path, game_lang) = config_handler::load_config()?; // Use from config_handler

    let full_game_path = game_path.join("Binaries").join("Tera.exe");

    if !full_game_path.exists() {
        let mut is_launching_guard_on_error = state.is_launching.lock().await;
        *is_launching_guard_on_error = false;
        drop(is_launching_guard_on_error);
        return Err(format!("Game executable not found at: {:?}", full_game_path));
    }

    let full_game_path_str = full_game_path
        .to_str()
        .ok_or("Invalid path to game executable")?
        .to_string();

    let app_handle_clone = app_handle.clone();
    let is_launching_arc_clone = Arc::clone(&state.is_launching);

    tokio::spawn(async move {
        if let Err(e) = app_handle_clone.emit_all("game_status_changed", true) {
            error!("Failed to emit game_status_changed (true) event: {:?}", e);
        }

        info!("Calling teralib::run_game");
        match
            run_game(
                &account_name,
                &characters_count,
                &ticket,
                &game_lang,
                &full_game_path_str
            ).await
        {
            Ok(exit_status) => {
                let result_msg = format!("Game exited with status: {:?}", exit_status);
                info!("{}", result_msg);
                if let Err(e) = app_handle_clone.emit_all("game_status", &result_msg) {
                    error!("Failed to emit game_status event: {:?}", e);
                }
            }
            Err(e) => {
                let error_msg = format!("Error launching game: {:?}", e);
                error!("{}", error_msg);
                if let Err(e_emit) = app_handle_clone.emit_all("game_status", &error_msg) {
                     error!("Failed to emit game_status (error) event: {:?}", e_emit);
                }
            }
        }

        info!("Emitting game_ended event");
        if let Err(e) = app_handle_clone.emit_all("game_ended", ()) {
            error!("Failed to emit game_ended event: {:?}", e);
        }
        
        let mut is_launching_lock_after_game = is_launching_arc_clone.lock().await;
        *is_launching_lock_after_game = false;
        drop(is_launching_lock_after_game);

        if let Err(e) = app_handle_clone.emit_all("game_status_changed", false) {
            error!("Failed to emit game_status_changed (false) event: {:?}", e);
        }
        
        reset_global_state(); // From teralib
        info!("Game launch process complete, state reset.");
    });

    Ok("Game launch initiated".to_string())
}

#[tauri::command]
pub async fn reset_launch_state(state: State<'_, GameState>) -> Result<(), String> {
    let mut is_launching = state.is_launching.lock().await;
    *is_launching = false;
    info!("Launch state reset via command.");
    Ok(())
}
