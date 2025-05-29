// Authentication handler module for TeraLaunch

use serde::{Deserialize, Serialize};
use std::sync::RwLock;
use lazy_static::lazy_static;
use tauri;
use reqwest::Client;
use log::{info, error}; // error might be used in login
use teralib::config::get_config_value; // For login URL
use serde_json::Value; // For parsing login response


// This will be updated once GameState is moved or made public from main/game_handler
// For now, this assumes GameState will be accessible from the crate root.
// If GameState moves to game_handler, this will become:
use crate::game_handler::GameState; 
// For now, we'll add a placeholder that might error until GameState is settled.
// To make it compile temporarily if GameState is private in main:
// pub struct GameState; // Temporary placeholder if needed for compilation path

// Struct definitions (copied from main.rs)
#[derive(Serialize, Deserialize, Debug)]
pub struct LoginResponse {
    #[serde(rename = "Return")]
    pub return_value: bool,
    #[serde(rename = "ReturnCode")]
    pub return_code: i32,
    #[serde(rename = "Msg")]
    pub msg: String,
    #[serde(rename = "CharacterCount")]
    pub character_count: String,
    #[serde(rename = "Permission")]
    pub permission: i32,
    #[serde(rename = "Privilege")]
    pub privilege: i32,
    #[serde(rename = "UserNo")]
    pub user_no: i32,
    #[serde(rename = "UserName")]
    pub user_name: String,
    #[serde(rename = "AuthKey")]
    pub auth_key: String,
}

#[derive(Serialize, Debug)] 
pub struct AuthInfo {
    pub character_count: String,
    pub permission: i32,
    pub privilege: i32,
    pub user_no: i32,
    pub user_name: String,
    pub auth_key: String,
}

#[derive(Debug, Default, Clone)] // Added Clone for read access
pub struct GlobalAuthInfo {
    pub character_count: String,
    pub user_no: i32,
    pub user_name: String,
    pub auth_key: String,
}

lazy_static! {
    pub static ref GLOBAL_AUTH_INFO: RwLock<GlobalAuthInfo> = RwLock::new(GlobalAuthInfo::default());
}

#[tauri::command]
pub fn set_auth_info(auth_key: String, user_name: String, user_no: i32, character_count: String) {
    let mut auth_info = GLOBAL_AUTH_INFO.write().unwrap();
    auth_info.auth_key = auth_key;
    auth_info.user_name = user_name;
    auth_info.user_no = user_no;
    auth_info.character_count = character_count;

    info!("Auth info set from frontend:");
    info!("User Name: {}", auth_info.user_name);
    info!("User No: {}", auth_info.user_no);
    info!("Character Count: {}", auth_info.character_count);
    // info!("Auth Key: {}", auth_info.auth_key); // Avoid logging sensitive key
}

#[tauri::command]
pub async fn login(username: String, password: String) -> Result<String, String> {
    let client = Client::new();
    let url = get_config_value("LOGIN_ACTION_URL").map_err(|e| e.to_string())?; // Handle Result

    let payload = format!("login={}&password={}", username, password);

    let res = client
        .post(url)
        .body(payload)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .send().await
        .map_err(|e| e.to_string())?;

    let body = res.text().await.map_err(|e| e.to_string())?;

    // The original code prints the body, which might be okay for debugging but not production.
    // println!("Response body: {}", body);

    // Attempt to parse as JSON, if it fails, return the raw body (which might be an error message).
    match serde_json::from_str::<Value>(&body) {
        Ok(json_value) => Ok(json_value.to_string()), // Return JSON string
        Err(_) => Ok(body), // Return raw body if not JSON
    }
}

// Placeholder for GameState, will be updated when game_handler is created
// This is a common pattern: define a minimal version of a struct for type checking
// if the actual definition is in a module not yet processed or accessible.
// However, for Tauri state, it must exactly match the managed state type.
// We will rely on `main.rs` to make its `GameState` pub for now, or update this use statement later.
// For now, to make this potentially compile in isolation, we'd need a local definition or a correct path.
// Assuming `main.rs` will expose `GameState` or `game_handler.rs` will define and `main.rs` use it.
// use crate::GameState; // This line is now effectively replaced by the use statement at the top of the file.

#[tauri::command]
pub async fn handle_logout(state: tauri::State<'_, GameState>) -> Result<(), String> {
    // The GameState type will be resolved once game_handler.rs is created and main.rs updated.
    // For now, this refers to crate::GameState which implies GameState is pub in main.rs or lib.rs of the crate.
    let mut is_launching = state.is_launching.lock().await;
    *is_launching = false;

    // Reset global authentication information
    let mut auth_info = GLOBAL_AUTH_INFO.write().unwrap();
    auth_info.auth_key = String::new();
    auth_info.user_name = String::new();
    auth_info.user_no = 0;
    auth_info.character_count = String::new();
    info!("User logged out, auth info reset.");
    Ok(())
}
