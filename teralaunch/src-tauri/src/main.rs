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
use reqwest::Client;
use lazy_static::lazy_static;
use ini::Ini;
use sha2::{Sha256, Digest};
use futures_util::StreamExt;
use indicatif::{ProgressBar, ProgressStyle};
use walkdir::WalkDir;


// Struct definitions
#[derive(Serialize, Deserialize)]
struct LoginResponse {
    #[serde(rename = "Return")]
    return_value: bool,
    #[serde(rename = "ReturnCode")]
    return_code: i32,
    #[serde(rename = "Msg")]
    msg: String,
    #[serde(rename = "CharacterCount")]
    character_count: String,
    #[serde(rename = "Permission")]
    permission: i32,
    #[serde(rename = "Privilege")]
    privilege: i32,
    #[serde(rename = "UserNo")]
    user_no: i32,
    #[serde(rename = "UserName")]
    user_name: String,
    #[serde(rename = "AuthKey")]
    auth_key: String,
}

#[derive(Serialize)]
struct AuthInfo {
    character_count: String,
    permission: i32,
    privilege: i32,
    user_no: i32,
    user_name: String,
    auth_key: String,
}

struct GlobalAuthInfo {
    character_count: String,
    user_no: i32,
    user_name: String,
    auth_key: String,
}

lazy_static! {
    static ref GLOBAL_AUTH_INFO: RwLock<GlobalAuthInfo> = RwLock::new(GlobalAuthInfo {
        character_count: String::new(),
        user_no: 0,
        user_name: String::new(),
        auth_key: String::new(),
    });
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct FileInfo {
    path: String,
    hash: String,
    size: u64,
    url: String,
}

#[derive(Clone, Serialize)]
struct ProgressPayload {
    file_name: String,
    progress: f64,
    speed: f64,
    downloaded_bytes: u64,
    total_bytes: u64,
    total_files: usize,
    elapsed_time: f64,
    current_file_index: usize,
}

#[derive(Clone, Serialize)]
struct FileCheckProgress {
    current_file: String,
    progress: f64,
    current_count: usize,
    total_files: usize,
    elapsed_time: f64,
    files_to_update: usize,
}


#[derive(Debug, Serialize, Deserialize, Clone)]
struct CachedFileInfo {
    hash: String,
    last_modified: SystemTime,
}

struct GameState {
    status_receiver: Arc<Mutex<watch::Receiver<bool>>>,
    is_launching: Arc<Mutex<bool>>,
}


static INIT: Once = Once::new();
lazy_static! {
    static ref HASH_CACHE: Mutex<HashMap<String, CachedFileInfo>> = Mutex::new(HashMap::new());
}


fn is_ignored(path: &Path, game_path: &Path, ignored_paths: &HashSet<&str>) -> bool {
    let relative_path = path.strip_prefix(game_path).unwrap().to_str().unwrap().replace("\\", "/");
    
    // Ignore files at the root
    if relative_path.chars().filter(|&c| c == '/').count() == 0 {
        return true;
    }

    // Check if the path is in the list of ignored paths
    for ignored_path in ignored_paths {
        if relative_path.starts_with(ignored_path) {
            return true;
        }
    }

    false
}

async fn get_server_hash_file() -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let res = client
        .get(get_hash_file_url())
        .send().await
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(json)
}


fn calculate_file_hash<P: AsRef<Path>>(path: P) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 1024];

    loop {
        let bytes_read = file.read(&mut buffer).map_err(|e| format!("Failed to read file: {}", e))?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }

    let result = hasher.finalize();
    Ok(format!("{:x}", result))
}

fn get_cache_file_path() -> Result<PathBuf, String> {
    let mut path = std::env::current_exe().map_err(|e| e.to_string())?;
    path.pop();
    path.push("file_cache.json");
    Ok(path)
}

fn save_cache_to_disk(cache: &HashMap<String, CachedFileInfo>) -> Result<(), String> {
    let cache_path = get_cache_file_path()?;
    let serialized = serde_json::to_string(cache).map_err(|e| e.to_string())?;
    let mut file = File::create(cache_path).map_err(|e| e.to_string())?;
    file.write_all(serialized.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

fn load_cache_from_disk() -> Result<HashMap<String, CachedFileInfo>, String> {
    let cache_path = get_cache_file_path()?;
    let mut file = File::open(cache_path).map_err(|e| e.to_string())?;
    let mut contents = String::new();
    file.read_to_string(&mut contents).map_err(|e| e.to_string())?;
    let cache: HashMap<String, CachedFileInfo> = serde_json::from_str(&contents).map_err(|e| e.to_string())?;
    Ok(cache)
}


fn get_hash_file_url() -> String {
    env::var("HASH_FILE_URL").expect("HASH_FILE_URL must be set")
}

fn get_files_server_url() -> String {
    env::var("FILE_SERVER_URL").expect("FILE_SERVER_URL must be set")
}

fn find_config_file() -> Option<PathBuf> {
    let current_dir = env::current_dir().ok()?;
    let config_in_current = current_dir.join("config.ini");
    if config_in_current.exists() {
        return Some(config_in_current);
    }

    let parent_dir = current_dir.parent()?;
    let config_in_parent = parent_dir.join("config.ini");
    if config_in_parent.exists() {
        return Some(config_in_parent);
    }

    if let Ok(exe_path) = env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let config_in_exe_dir = exe_dir.join("config.ini");
            if config_in_exe_dir.exists() {
                return Some(config_in_exe_dir);
            }
        }
    }

    None
}

fn load_config() -> Result<(PathBuf, String), String> {
    let config_path = find_config_file().ok_or("Config file not found")?;
    let conf = Ini::load_from_file(&config_path).map_err(|e|
        format!("Failed to load config: {}", e)
    )?;

    let section = conf.section(Some("game")).ok_or("Game section not found in config")?;

    let game_path = section.get("path").ok_or("Game path not found in config")?;

    let game_path = PathBuf::from(game_path);

    let game_lang = section.get("lang").ok_or("Game language not found in config")?.to_string();

    Ok((game_path, game_lang))
}

/* fn save_config(game_path: &Path, game_lang: &str) -> Result<(), String> {
    let config_path = find_config_file().ok_or("Config file not found")?;
    let mut conf = Ini::new();

    conf.with_section(Some("game")).set("path", game_path.to_str().ok_or("Invalid game path")?);
    conf.with_section(Some("game")).set("lang", game_lang);

    let mut file = std::fs::File
        ::create(&config_path)
        .map_err(|e| format!("Failed to create config file: {}", e))?;

    conf.write_to(&mut file).map_err(|e| format!("Failed to write config: {}", e))?;

    Ok(())
} */




#[tauri::command]
async fn generate_hash_file(window: tauri::Window) -> Result<String, String> {
    let start_time = Instant::now();

    let game_path = get_game_path().map_err(|e| e.to_string())?;
    info!("Game path: {:?}", game_path);
    let output_path = game_path.join("hash-file.json");
    info!("Output path: {:?}", output_path);

    // List of files and directories to ignore
    let ignored_paths: HashSet<&str> = [
        "$Patch",
        "Binaries/cookies.dat",
        "S1Game/GuildFlagUpload",
        "S1Game/GuildLogoUpload",
        "S1Game/ImageCache",
        "S1Game/Logs",
        "S1Game/Screenshots",
        "S1Game/Config/S1Engine.ini",
        "S1Game/Config/S1Game.ini",
        "S1Game/Config/S1Input.ini",
        "S1Game/Config/S1Lightmass.ini",
        "S1Game/Config/S1Option.ini",
        "S1Game/Config/S1SystemSettings.ini",
        "S1Game/Config/S1TBASettings.ini",
        "S1Game/Config/S1UI.ini",
        "Launcher.exe",
        "local.db",
        "version.ini",
        "unins000.dat",
        "unins000.exe",
    ].iter().cloned().collect();

    let total_files = WalkDir::new(&game_path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| !is_ignored(e.path(), &game_path, &ignored_paths))
        .count();
    info!("Total files to process: {}", total_files);

    let progress_bar = ProgressBar::new(total_files as u64);
    let progress_style = ProgressStyle::default_bar()
        .template("[{elapsed_precise}] {bar:40.cyan/blue} {pos}/{len} {msg}")
        .map_err(|e| e.to_string())?
        .progress_chars("##-");
    progress_bar.set_style(progress_style);

    let processed_files = AtomicU64::new(0);
    let total_size = AtomicU64::new(0);
    let files = Arc::new(Mutex::new(Vec::new()));

    let result: Result<(), String> = WalkDir::new(&game_path)
        .into_iter()
        .par_bridge()
        .try_for_each(|entry| -> Result<(), String> {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.is_file() && !is_ignored(path, &game_path, &ignored_paths) {
                let relative_path = path.strip_prefix(&game_path).unwrap().to_str().unwrap().replace("\\", "/");
                info!("Processing file: {}", relative_path);

                let contents = std::fs::read(path).map_err(|e| e.to_string())?;
                let mut hasher = Sha256::new();
                hasher.update(&contents);
                let hash = format!("{:x}", hasher.finalize());
                let size = contents.len() as u64;
                let file_server_url = env::var("FILE_SERVER_URL").expect("FILE_SERVER_URL must be set");
                let url = format!("{}/files/{}", file_server_url, relative_path);

                files.blocking_lock().push(FileInfo {
                    path: relative_path.clone(),
                    hash,
                    size,
                    url,
                });

                total_size.fetch_add(size, Ordering::Relaxed);
                let current_processed = processed_files.fetch_add(1, Ordering::Relaxed) + 1;
                progress_bar.set_position(current_processed);

                let progress = (current_processed as f64 / total_files as f64) * 100.0;
                window.emit("hash_file_progress", json!({
                    "current_file": relative_path,
                    "progress": progress,
                    "processed_files": current_processed,
                    "total_files": total_files,
                    "total_size": total_size.load(Ordering::Relaxed)
                })).map_err(|e| e.to_string())?;
            }
            Ok(())
        });

    if let Err(e) = result {
        error!("Error during file processing: {:?}", e);
        return Err(e);
    }

    progress_bar.finish_with_message("File processing completed");

    info!("Generating JSON");
    let json = serde_json::to_string(&json!({
        "files": files.lock().await.clone()
    })).map_err(|e| e.to_string())?;

    info!("Writing hash file");
    let mut file = File::create(&output_path).map_err(|e| e.to_string())?;
    file.write_all(json.as_bytes()).map_err(|e| e.to_string())?;

    let duration = start_time.elapsed();
    let total_processed = processed_files.load(Ordering::Relaxed);
    let total_size = total_size.load(Ordering::Relaxed);
    info!("Hash file generation completed in {:?}", duration);
    info!("Total files processed: {}", total_processed);
    info!("Total size: {} bytes", total_size);

    Ok(format!("Hash file generated successfully. Processed {} files with a total size of {} bytes in {:?}", total_processed, total_size, duration))
}


#[tauri::command]
async fn select_game_folder() -> Result<String, String> {
    let (tx, mut rx) = mpsc::channel(1);

    FileDialogBuilder::new()
        .set_title("Select Tera Game Folder")
        .set_directory("/")
        .pick_folder(move |folder_path| {
            if let Some(path) = folder_path {
                let _ = tx.try_send(path);
            }
        });

    match rx.recv().await {
        Some(path) => Ok(path.to_string_lossy().into_owned()),
        None => Err("Folder selection cancelled or failed".into()),
    }
}


fn get_game_path() -> Result<PathBuf, String> {
    let (game_path, _) = load_config()?;
    Ok(game_path)
}


#[tauri::command]
fn save_game_path_to_config(path: String) -> Result<(), String> {
    let config_path = find_config_file().ok_or("Config file not found")?;
    let mut conf = Ini::load_from_file(&config_path).map_err(|e| 
        format!("Failed to load config: {}", e)
    )?;

    conf.with_section(Some("game")).set("path", &path);

    conf.write_to_file(&config_path).map_err(|e| format!("Failed to write config: {}", e))?;

    Ok(())
}

#[tauri::command]
fn get_game_path_from_config() -> Result<String, String> {
    let game_path = get_game_path()?;
    game_path.to_str()
        .ok_or_else(|| "Invalid UTF-8 in game path".to_string())
        .map(|s| s.to_string())
}

#[tauri::command]
async fn check_update_required(window: tauri::Window) -> Result<bool, String> {
    match get_files_to_update(window).await {
        Ok(files) => Ok(!files.is_empty()),
        Err(e) => Err(e),
    }
}

#[tauri::command]
async fn update_file(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    file_info: FileInfo,
    total_files: usize,
    current_file_index: usize,
    total_size: u64, 
    downloaded_size: u64,
) -> Result<u64, String> {
    let game_path = get_game_path()?;
    let file_path = game_path.join(&file_info.path);

    if let Some(parent) = file_path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }

    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())?;

    let res = client.get(&file_info.url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let file_size = res.content_length().unwrap_or(file_info.size);
    let mut file = tokio::fs::File::create(&file_path).await.map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    let mut stream = res.bytes_stream();
    let start_time = Instant::now();
    let mut last_update = Instant::now();

    println!("Downloading file: {}", file_info.path);

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;

        let now = Instant::now();
        if now.duration_since(last_update) >= Duration::from_millis(100) || downloaded == file_size {
            let elapsed = now.duration_since(start_time);
            let speed = if elapsed.as_secs() > 0 { downloaded / elapsed.as_secs() } else { downloaded };

            let total_downloaded = downloaded_size + downloaded;
            let progress_payload = ProgressPayload {
                file_name: file_info.path.clone(),
                progress: (downloaded as f64 / file_size as f64) * 100.0,
                speed: speed as f64,
                downloaded_bytes: total_downloaded,
                total_bytes: total_size,
                total_files,
                elapsed_time: elapsed.as_secs_f64(),
                current_file_index,
            };

            println!("Current file: {}, Download speed: {}/s, Progress: {:.2}%", 
                     file_info.path, format_bytes(speed), progress_payload.progress);

            if let Err(e) = window.emit("download_progress", &progress_payload) {
                println!("Failed to emit download_progress event: {}", e);
            }
            last_update = now;
        }

        tokio::time::sleep(Duration::from_millis(1)).await;
    }

    file.flush().await.map_err(|e| e.to_string())?;

    let downloaded_hash = tokio::task::spawn_blocking(move || calculate_file_hash(&file_path)).await.map_err(|e| e.to_string())??;
    if downloaded_hash != file_info.hash {
        return Err(format!("Hash mismatch for file: {}", file_info.path));
    }
    
    // Emit a final event for this file
    let final_progress_payload = ProgressPayload {
        file_name: file_info.path.clone(),
        progress: 100.0,
        speed: 0.0,
        downloaded_bytes: downloaded_size + downloaded,
        total_bytes: total_size,
        total_files,
        elapsed_time: start_time.elapsed().as_secs_f64(),
        current_file_index,
    };
    if let Err(e) = window.emit("download_progress", &final_progress_payload) {
        println!("Failed to emit final download_progress event: {}", e);
    }

    println!("File download completed: {}", file_info.path);
    
    Ok(downloaded)
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut size = bytes as f64;
    let mut unit_index = 0;

    while size >= 1024.0 && unit_index < UNITS.len() - 1 {
        size /= 1024.0;
        unit_index += 1;
    }

    format!("{:.2} {}", size, UNITS[unit_index])
}

#[tauri::command]
async fn download_all_files(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    files_to_update: Vec<FileInfo>
) -> Result<Vec<u64>, String> {
    let total_files = files_to_update.len();
    let total_size: u64 = files_to_update.iter().map(|f| f.size).sum();

    if total_files == 0 {
        println!("No files to download");
        if let Err(e) = window.emit("download_complete", ()) {
            eprintln!("Failed to emit download_complete event: {}", e);
        }
        return Ok(vec![]);
    }

    let mut downloaded_sizes = Vec::with_capacity(total_files);
    let mut downloaded_size: u64 = 0;

    for (index, file_info) in files_to_update.into_iter().enumerate() {
        let file_size = update_file(
            app_handle.clone(),
            window.clone(),
            file_info,
            total_files,
            index + 1,
            total_size,
            downloaded_size
        ).await?;

        downloaded_size += file_size;
        downloaded_sizes.push(file_size);
    }

    println!("Download complete for {} file(s)", total_files);
    if let Err(e) = window.emit("download_complete", ()) {
        eprintln!("Failed to emit download_complete event: {}", e);
    }

    Ok(downloaded_sizes)
}


#[tauri::command]
async fn get_files_to_update(window: tauri::Window) -> Result<Vec<FileInfo>, String> {
    println!("Starting get_files_to_update");

    let start_time = Instant::now();
    let server_hash_file = get_server_hash_file().await?;

    // Obtenir le chemin du jeu
    let local_game_path = get_game_path()?;
    println!("Local game path: {:?}", local_game_path);

    println!("Attempting to read server hash file");
    let files = server_hash_file["files"].as_array().ok_or("Invalid server hash file format")?;
    println!("Server hash file parsed, {} files found", files.len());

    println!("Starting file comparison");
    let _cache = load_cache_from_disk().unwrap_or_else(|_| HashMap::new());
    let cache = Arc::new(RwLock::new(_cache));

    let progress_bar = ProgressBar::new(files.len() as u64);
    progress_bar.set_style(ProgressStyle::default_bar()
        .template("[{elapsed_precise}] {bar:40.cyan/blue} {pos}/{len} {msg}")
        .unwrap()
        .progress_chars("##-"));

    let processed_count = Arc::new(AtomicUsize::new(0));
    let files_to_update_count = Arc::new(AtomicUsize::new(0));
    let total_size = Arc::new(AtomicU64::new(0));

    let files_to_update: Vec<FileInfo> = files.par_iter().enumerate()
        .filter_map(|(_index, file_info)| {
            let path = file_info["path"].as_str().unwrap_or("");
            let server_hash = file_info["hash"].as_str().unwrap_or("");
            let size = file_info["size"].as_u64().unwrap_or(0);
            let url = file_info["url"].as_str().unwrap_or("").to_string();

            let local_file_path = local_game_path.join(path);

            let current_count = processed_count.fetch_add(1, Ordering::SeqCst) + 1;
            if current_count % 100 == 0 || current_count == files.len() {
                let progress_payload = FileCheckProgress {
                    current_file: path.to_string(),
                    progress: (current_count as f64 / files.len() as f64) * 100.0,
                    current_count,
                    total_files: files.len(),
                    elapsed_time: start_time.elapsed().as_secs_f64(),
                    files_to_update: files_to_update_count.load(Ordering::SeqCst),
                };
            
                let _ = window.emit("file_check_progress", progress_payload)
                    .map_err(|e| {
                        println!("Error emitting file_check_progress event: {}", e);
                        e.to_string()
                    });
            }

            progress_bar.inc(1);

            if !local_file_path.exists() {
                files_to_update_count.fetch_add(1, Ordering::SeqCst);
                total_size.fetch_add(size, Ordering::SeqCst);
                return Some(FileInfo {
                    path: path.to_string(),
                    hash: server_hash.to_string(),
                    size,
                    url,
                });
            }

            let metadata = match fs::metadata(&local_file_path) {
                Ok(m) => m,
                Err(_) => {
                    files_to_update_count.fetch_add(1, Ordering::SeqCst);
                    total_size.fetch_add(size, Ordering::SeqCst);
                    return Some(FileInfo {
                        path: path.to_string(),
                        hash: server_hash.to_string(),
                        size,
                        url,
                    });
                }
            };

            let last_modified = metadata.modified().ok();

            let cache_read = cache.read().unwrap();
            if let Some(cached_info) = cache_read.get(path) {
                if let Some(lm) = last_modified {
                    if cached_info.last_modified == lm && cached_info.hash == server_hash {
                        return None;
                    }
                }
            }
            drop(cache_read);

            if metadata.len() != size {
                files_to_update_count.fetch_add(1, Ordering::SeqCst);
                total_size.fetch_add(size, Ordering::SeqCst);
                return Some(FileInfo {
                    path: path.to_string(),
                    hash: server_hash.to_string(),
                    size,
                    url,
                });
            }

            let local_hash = match calculate_file_hash(&local_file_path) {
                Ok(hash) => hash,
                Err(_) => {
                    files_to_update_count.fetch_add(1, Ordering::SeqCst);
                    total_size.fetch_add(size, Ordering::SeqCst);
                    return Some(FileInfo {
                        path: path.to_string(),
                        hash: server_hash.to_string(),
                        size,
                        url,
                    });
                }
            };

            let mut cache_write = cache.write().unwrap();
            cache_write.insert(path.to_string(), CachedFileInfo {
                hash: local_hash.clone(),
                last_modified: last_modified.unwrap_or_else(SystemTime::now),
            });
            drop(cache_write);

            if local_hash != server_hash {
                files_to_update_count.fetch_add(1, Ordering::SeqCst);
                total_size.fetch_add(size, Ordering::SeqCst);
                Some(FileInfo {
                    path: path.to_string(),
                    hash: server_hash.to_string(),
                    size,
                    url,
                })
            } else {
                None
            }
        })
        .collect();

    progress_bar.finish_with_message("File comparison completed");

    // Save the updated cache to disk
    let final_cache = cache.read().unwrap();
    if let Err(e) = save_cache_to_disk(&*final_cache) {
        eprintln!("Failed to save cache to disk: {}", e);
    }

    let total_time = start_time.elapsed();
    println!("File comparison completed. Files to update: {}", files_to_update.len());

    // Emit a final event with complete statistics
    let _ = window.emit("file_check_completed", json!({
        "total_files": files.len(),
        "files_to_update": files_to_update.len(),
        "total_size": total_size.load(Ordering::SeqCst),
        "total_time_seconds": total_time.as_secs(),
        "average_time_per_file_ms": (total_time.as_millis() as f64) / (files.len() as f64)
    }));

    Ok(files_to_update)
}


#[tauri::command]
async fn get_game_status(state: tauri::State<'_, GameState>) -> Result<bool, String> {
    let status = state.status_receiver.lock().await.borrow().clone();
    let is_launching = *state.is_launching.lock().await;
    Ok(status || is_launching)
}

#[tauri::command]
async fn handle_launch_game(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, GameState>
) -> Result<String, String> {
    println!("Total time: {:?}", 3);
    let mut is_launching = state.is_launching.lock().await;
    if *is_launching {
        return Err("Game is already launching".to_string());
    }
    *is_launching = true;

    let is_running = *state.status_receiver.lock().await.borrow();

    if is_running {
        *is_launching = false;
        return Err("Game is already running".to_string());
    }

    let auth_info = GLOBAL_AUTH_INFO.read().unwrap();
    let account_name = auth_info.user_no.to_string();
    let characters_count = auth_info.character_count.clone();
    let ticket = auth_info.auth_key.clone();
    let (game_path, game_lang) = load_config()?;

    let full_game_path = game_path.join("Binaries").join("Tera.exe");

    if !full_game_path.exists() {
        *is_launching = false;
        return Err(format!("Game executable not found at: {:?}", full_game_path));
    }

    let full_game_path_str = full_game_path
        .to_str()
        .ok_or("Invalid path to game executable")?
        .to_string();

    let app_handle_clone = app_handle.clone();
    let is_launching_clone = Arc::clone(&state.is_launching);

    tokio::task::spawn(async move {
        // Emit the game_status_changed event at the start of the launch
        if let Err(e) = app_handle_clone.emit_all("game_status_changed", true) {
            error!("Failed to emit game_status_changed event: {:?}", e);
        }

        info!("run_game reached");
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
                let result = format!("Game exited with status: {:?}", exit_status);
                app_handle_clone.emit_all("game_status", &result).unwrap();
                info!("{}", result);
            }
            Err(e) => {
                let error = format!("Error launching game: {:?}", e);
                app_handle_clone.emit_all("game_status", &error).unwrap();
                error!("{}", error);
            }
        }

        info!("Emitting game_ended event");
        if let Err(e) = app_handle_clone.emit_all("game_ended", ()) {
            error!("Failed to emit game_ended event: {:?}", e);
        }

        let mut is_launching = is_launching_clone.lock().await;
        *is_launching = false;
        if let Err(e) = app_handle_clone.emit_all("game_status_changed", false) {
            error!("Failed to emit game_status_changed event: {:?}", e);
        }

        reset_global_state();

        info!("Game launch state reset");
    });

    Ok("Game launch initiated".to_string())
}



#[tauri::command]
fn get_language_from_config() -> Result<String, String> {
    info!("Attempting to read language from config file");
    let (_, game_lang) = load_config()?;
    info!("Language read from config: {}", game_lang);
    Ok(game_lang)
}

#[tauri::command]
fn save_language_to_config(language: String) -> Result<(), String> {
    info!("Attempting to save language {} to config file", language);
    let config_path = find_config_file().ok_or("Config file not found")?;
    let mut conf = Ini::load_from_file(&config_path).map_err(|e|
        format!("Failed to load config: {}", e)
    )?;

    conf.with_section(Some("game")).set("lang", &language);

    conf.write_to_file(&config_path).map_err(|e| format!("Failed to write config: {}", e))?;

    info!("Language successfully saved to config");
    Ok(())
}

#[tauri::command]
async fn reset_launch_state(state: tauri::State<'_, GameState>) -> Result<(), String> {
    let mut is_launching = state.is_launching.lock().await;
    *is_launching = false;
    Ok(())
}

#[tauri::command]
fn set_auth_info(auth_key: String, user_name: String, user_no: i32, character_count: String) {
    let mut auth_info = GLOBAL_AUTH_INFO.write().unwrap();
    auth_info.auth_key = auth_key;
    auth_info.user_name = user_name;
    auth_info.user_no = user_no;
    auth_info.character_count = character_count;

    info!("Auth info set from frontend:");
    info!("User Name: {}", auth_info.user_name);
    info!("User No: {}", auth_info.user_no);
    info!("Character Count: {}", auth_info.character_count);
    info!("Auth Key: {}", auth_info.auth_key);
}

#[tauri::command]
async fn login(username: String, password: String) -> Result<String, String> {
    let client = Client::new();
    let url = env::var("LOGIN_ACTION_URL").expect("LOGIN_ACTION_URL must be set");

    let payload = format!("login={}&password={}", username, password);

    let res = client
        .post(url)
        .body(payload)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .send().await
        .map_err(|e| e.to_string())?;

    let body = res.text().await.map_err(|e| e.to_string())?;

    println!("Response body: {}", body);

    match serde_json::from_str::<Value>(&body) {
        Ok(json) => Ok(json.to_string()),
        Err(_) => Ok(body),
    }
}

#[tauri::command]
async fn handle_logout(state: tauri::State<'_, GameState>) -> Result<(), String> {
    let mut is_launching = state.is_launching.lock().await;
    *is_launching = false;

    // Reset global authentication information
    let mut auth_info = GLOBAL_AUTH_INFO.write().unwrap();
    auth_info.auth_key = String::new();
    auth_info.user_name = String::new();
    auth_info.user_no = 0;
    auth_info.character_count = String::new();

    Ok(())
}

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
    let game_state = GameState {
        status_receiver: Arc::new(Mutex::new(game_status_receiver)),
        is_launching: Arc::new(Mutex::new(false)),
    };

    tauri::Builder
        ::default()
        .manage(game_state)
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
                handle_launch_game,
                get_game_status,
                select_game_folder,
                get_game_path_from_config,
                save_game_path_to_config,
                reset_launch_state,
                login,
                set_auth_info,
                get_language_from_config,
                save_language_to_config,
                get_files_to_update,
                update_file,
                handle_logout,
                generate_hash_file,
                check_server_connection,
                check_update_required,
                download_all_files,
            ]
        )
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
