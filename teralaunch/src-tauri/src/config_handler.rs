// Configuration handler module for TeraLaunch (tera_config.ini)

use std::{
    env,
    path::PathBuf,
    // fs::File, // Not needed directly here unless save_config was also moved and used it.
    // io::Write, // Not needed directly here
};
use ini::Ini;
use log::{info, error}; // error may not be needed if all Results are handled by callers
use tauri; // For Tauri commands

// Helper function to find the config file
// Made public so it could potentially be used by other parts of the application if necessary,
// though primarily it's a helper for load_config within this module.
pub fn find_config_file() -> Option<PathBuf> {
    let current_dir = env::current_dir().ok()?;
    let config_in_current = current_dir.join("tera_config.ini");
    if config_in_current.exists() {
        return Some(config_in_current);
    }

    // Check parent directory (if current_dir is not root)
    if let Some(parent_dir) = current_dir.parent() {
        let config_in_parent = parent_dir.join("tera_config.ini");
        if config_in_parent.exists() {
            return Some(config_in_parent);
        }
    }
    
    // Check directory of executable
    if let Ok(exe_path) = env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let config_in_exe_dir = exe_dir.join("tera_config.ini");
            if config_in_exe_dir.exists() {
                return Some(config_in_exe_dir);
            }
        }
    }
    None
}

// Loads the game path and language from tera_config.ini
// Made public for the same reasons as find_config_file.
pub fn load_config() -> Result<(PathBuf, String), String> {
    let config_path = find_config_file().ok_or_else(|| "Config file (tera_config.ini) not found".to_string())?;
    info!("Loading config from: {:?}", config_path);
    let conf = Ini::load_from_file(&config_path).map_err(|e|
        format!("Failed to load config: {}", e)
    )?;

    let section = conf.section(Some("game")).ok_or_else(|| "Section [game] not found in config".to_string())?;
    let game_path_str = section.get("path").ok_or_else(|| "Key 'path' not found in [game] section".to_string())?;
    let game_path = PathBuf::from(game_path_str);
    let game_lang = section.get("lang").ok_or_else(|| "Key 'lang' not found in [game] section".to_string())?.to_string();

    Ok((game_path, game_lang))
}

// Retrieves just the game path. Useful for other modules like file_handler.
pub fn get_game_path() -> Result<PathBuf, String> {
    let (game_path, _) = load_config()?;
    Ok(game_path)
}

#[tauri::command]
pub fn save_game_path_to_config(path: String) -> Result<(), String> {
    info!("Attempting to save game path to config: {}", path);
    let config_path = find_config_file().ok_or_else(|| "Config file (tera_config.ini) not found".to_string())?;
    let mut conf = Ini::load_from_file(&config_path).map_err(|e|
        format!("Failed to load config for saving: {}", e)
    )?;

    conf.with_section(Some("game")).set("path", &path);
    conf.write_to_file(&config_path).map_err(|e| format!("Failed to write config: {}", e))?;
    info!("Game path successfully saved to config: {}", path);
    Ok(())
}

#[tauri::command]
pub fn get_game_path_from_config() -> Result<String, String> {
    info!("Attempting to read game path from config file");
    match get_game_path() { // Uses the internal get_game_path
        Ok(game_path) => game_path
            .to_str()
            .ok_or_else(|| "Invalid UTF-8 sequence in game path".to_string())
            .map(|s| s.to_string()),
        Err(e) => {
            error!("Error getting game path from config: {}", e);
            if e.contains("Config file (tera_config.ini) not found") { // More specific error check
                Err("tera_config.ini is missing".to_string())
            } else {
                Err(e)
            }
        }
    }
}

#[tauri::command]
pub fn get_language_from_config() -> Result<String, String> {
    info!("Attempting to read language from config file");
    let (_, game_lang) = load_config()?;
    info!("Language read from config: {}", game_lang);
    Ok(game_lang)
}

#[tauri::command]
pub fn save_language_to_config(language: String) -> Result<(), String> {
    info!("Attempting to save language {} to config file", language);
    let config_path = find_config_file().ok_or_else(|| "Config file (tera_config.ini) not found".to_string())?;
    let mut conf = Ini::load_from_file(&config_path).map_err(|e|
        format!("Failed to load config for saving: {}", e)
    )?;

    conf.with_section(Some("game")).set("lang", &language);
    conf.write_to_file(&config_path).map_err(|e| format!("Failed to write config: {}", e))?;
    info!("Language successfully saved to config: {}", language);
    Ok(())
}
