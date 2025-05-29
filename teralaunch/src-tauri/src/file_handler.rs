// File handler module for TeraLaunch
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{Read, Write, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Mutex, 
    time::{SystemTime, Instant, Duration}, 
    sync::atomic::{AtomicU64, AtomicUsize, Ordering}, 
};

use log::{info, warn, error, debug}; 
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Window, Manager, AppHandle}; 
use tokio::io::AsyncWriteExt; 
use tokio::time::sleep; 
use futures_util::StreamExt;
use sha2::{Sha256, Digest};
use lazy_static::lazy_static; 
use teralib::config::get_config_value; 
use crate::config_handler::get_game_path; 

// For generate_hash_file
use walkdir::WalkDir;
use rayon::prelude::*;
// use indicatif::{ProgressBar, ProgressStyle}; // ProgressBar removed as per previous step, using window events
use std::sync::Arc; 


#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileInfo {
    pub path: String,
    pub hash: String,
    pub size: u64,
    pub url: String,
}

#[derive(Clone, Serialize)]
pub struct ProgressPayload {
    pub file_name: String,
    pub progress: f64,
    pub speed: f64,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub total_files: usize,
    pub elapsed_time: f64,
    pub current_file_index: usize,
}

#[derive(Clone, Serialize)]
pub struct FileCheckProgress {
    pub current_file: String,
    pub progress: f64,
    pub current_count: usize,
    pub total_files: usize,
    pub elapsed_time: f64,
    pub files_to_update: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CachedFileInfo {
    pub hash: String,
    pub last_modified: SystemTime,
}

lazy_static! {
    pub static ref HASH_CACHE: Mutex<HashMap<String, CachedFileInfo>> = Mutex::new(HashMap::new());
}

pub fn is_ignored(path: &Path, game_path: &Path, ignored_paths: &HashSet<&str>) -> bool {
    let relative_path_os = match path.strip_prefix(game_path) {
        Ok(p) => p.to_os_string(),
        Err(_) => return false, 
    };
    let relative_path = match relative_path_os.into_string() {
        Ok(s) => s.replace("\\", "/"),
        Err(_) => return false, 
    };

    if !relative_path.contains('/') && path.parent() == Some(game_path) {
        if ignored_paths.contains(relative_path.as_str()) {
            return true;
        }
         if !relative_path.contains('/') { 
            if ignored_paths.contains(relative_path.as_str()) {
                return true;
            }
         }
    }

    for ignored_path_pattern in ignored_paths {
        if relative_path.starts_with(ignored_path_pattern) {
            return true;
        }
    }
    false
}


pub async fn get_server_hash_file() -> Result<serde_json::Value, String> {
    let url_str = get_hash_file_url();
    if url_str.is_empty() {
        return Err("HASH_FILE_URL is not configured.".to_string());
    }

    let client = reqwest::Client::new();
    let res = client
        .get(url_str) 
        .send().await
        .map_err(|e| format!("Failed to send request to HASH_FILE_URL: {}", e))?;
    
    if !res.status().is_success() {
        return Err(format!("Server returned error for HASH_FILE_URL: {} - {}", res.status(), res.text().await.unwrap_or_default()));
    }

    let json_text = res.text().await.map_err(|e| format!("Failed to read HASH_FILE_URL response text: {}", e))?;
    serde_json::from_str(&json_text).map_err(|e| format!("Failed to parse HASH_FILE_URL JSON: {}. Response text: {}", e, json_text))
}

pub fn calculate_file_hash<P: AsRef<Path>>(path: P) -> Result<String, String> {
    let file_path = path.as_ref();
    let mut file = File::open(file_path).map_err(|e| format!("Failed to open file {:?}: {}", file_path, e))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 8192]; // Using a slightly larger buffer

    loop {
        let bytes_read = file.read(&mut buffer).map_err(|e| format!("Failed to read file {:?}: {}", file_path, e))?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }

    let result = hasher.finalize();
    Ok(format!("{:x}", result))
}

pub fn get_cache_file_path() -> Result<PathBuf, String> {
    let mut path = std::env::current_exe().map_err(|e| e.to_string())?;
    path.pop();
    path.push("file_cache.json");
    Ok(path)
}

pub fn save_cache_to_disk(cache: &HashMap<String, CachedFileInfo>) -> Result<(), String> {
    let cache_path = get_cache_file_path()?;
    let serialized = serde_json::to_string_pretty(cache).map_err(|e| e.to_string())?; // Use pretty for readability
    let mut file = File::create(cache_path).map_err(|e| e.to_string())?;
    file.write_all(serialized.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn load_cache_from_disk() -> Result<HashMap<String, CachedFileInfo>, String> {
    let cache_path = get_cache_file_path()?;
    if !cache_path.exists() { 
        return Ok(HashMap::new());
    }
    let mut file = File::open(cache_path).map_err(|e| e.to_string())?;
    let mut contents = String::new();
    file.read_to_string(&mut contents).map_err(|e| e.to_string())?;
    let cache: HashMap<String, CachedFileInfo> = serde_json::from_str(&contents).map_err(|e| e.to_string())?;
    Ok(cache)
}

pub fn get_hash_file_url() -> String {
    get_config_value("HASH_FILE_URL").unwrap_or_else(|e| {
        warn!("HASH_FILE_URL not found in config (Error: {}), using empty string.", e);
        String::new() 
    })
}

pub fn get_files_server_url() -> String {
    get_config_value("FILE_SERVER_URL").unwrap_or_else(|e| {
        warn!("FILE_SERVER_URL not found in config (Error: {}), using empty string.", e);
        String::new() 
    })
}

pub fn format_bytes(bytes: u64) -> String {
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
pub async fn generate_hash_file(window: Window) -> Result<String, String> {
    let start_time = Instant::now();
    let game_path = get_game_path().map_err(|e| e.to_string())?; 
    info!("Game path: {:?}", game_path);
    let output_path = game_path.join("hash-file.json");
    info!("Output path: {:?}", output_path);

    let file_server_url = get_files_server_url();
    if file_server_url.is_empty() {
        return Err("FILE_SERVER_URL is not configured. Cannot generate hash file with proper download URLs.".to_string());
    }

    let ignored_paths_vec = vec![
        "$Patch", "Binaries/cookies.dat", "S1Game/GuildFlagUpload", "S1Game/GuildLogoUpload",
        "S1Game/ImageCache", "S1Game/Logs", "S1Game/Screenshots", "S1Game/Config/S1Engine.ini",
        "S1Game/Config/S1Game.ini", "S1Game/Config/S1Input.ini", "S1Game/Config/S1Lightmass.ini",
        "S1Game/Config/S1Option.ini", "S1Game/Config/S1SystemSettings.ini",
        "S1Game/Config/S1TBASettings.ini", "S1Game/Config/S1UI.ini", "Launcher.exe",
        "local.db", "version.ini", "unins000.dat", "unins000.exe",
    ];
    let ignored_paths: HashSet<&str> = ignored_paths_vec.into_iter().collect();

    let total_files = WalkDir::new(&game_path)
        .into_iter().filter_map(Result::ok)
        .filter(|e| e.file_type().is_file() && !is_ignored(e.path(), &game_path, &ignored_paths))
        .count();
    info!("Total files to process: {}", total_files);
    
    let processed_files_count = Arc::new(AtomicUsize::new(0));
    let total_size_accumulated = Arc::new(AtomicU64::new(0));
    let files_data_arc = Arc::new(Mutex::new(Vec::new()));
    let game_path_arc = Arc::new(game_path.clone());

    WalkDir::new(game_path).into_iter().filter_map(Result::ok)
    .par_bridge() 
    .filter(|e| e.file_type().is_file() && !is_ignored(e.path(), &game_path_arc, &ignored_paths))
    .try_for_each(|entry| -> Result<(), String> {
        let path = entry.path();
        let relative_path_os = path.strip_prefix(game_path_arc.as_ref()).map_err(|_e| "Failed to strip prefix".to_string())?;
        let relative_path = relative_path_os.to_str().ok_or("Path is not valid UTF-8")?.replace("\\", "/");

        let hash = calculate_file_hash(path)?;
        let size = fs::metadata(path).map_err(|e| e.to_string())?.len();
        
        let url = format!("{}/files/{}", file_server_url, relative_path);

        files_data_arc.lock().unwrap().push(FileInfo { path: relative_path.clone(), hash, size, url });
        total_size_accumulated.fetch_add(size, Ordering::Relaxed);
        
        let current_processed = processed_files_count.fetch_add(1, Ordering::Relaxed) + 1;
        let progress = (current_processed as f64 / total_files as f64) * 100.0;
        
        window.emit("hash_file_progress", json!({
            "current_file": relative_path,
            "progress": progress,
            "processed_files": current_processed,
            "total_files": total_files,
            "total_size": total_size_accumulated.load(Ordering::Relaxed)
        })).map_err(|e| e.to_string())?;
        
        Ok(())
    })?;

    info!("Generating JSON");
    let files_data = files_data_arc.lock().unwrap();
    let json_output = serde_json::to_string_pretty(&json!({ "files": *files_data })).map_err(|e| e.to_string())?;

    info!("Writing hash file to {:?}", output_path);
    let mut file = File::create(&output_path).map_err(|e| e.to_string())?;
    file.write_all(json_output.as_bytes()).map_err(|e| e.to_string())?;

    let duration = start_time.elapsed();
    info!("Hash file generation completed in {:?}", duration);
    Ok(format!("Hash file generated. Processed {} files.", processed_files_count.load(Ordering::Relaxed)))
}

#[tauri::command]
pub async fn select_game_folder() -> Result<String, String> {
    use tauri::api::dialog::FileDialogBuilder; 
    let (tx, rx) = tokio::sync::oneshot::channel(); 

    FileDialogBuilder::new().pick_folder(move |folder_path| {
        if let Some(path) = folder_path {
            let _ = tx.send(path.to_string_lossy().into_owned());
        } else {
            let _ = tx.send("".to_string()); 
        }
    });

    match rx.await {
        Ok(path_str) if !path_str.is_empty() => Ok(path_str),
        Ok(_) => Err("Folder selection cancelled.".into()), 
        Err(_) => Err("Failed to receive folder path from dialog.".into()),
    }
}

#[tauri::command]
pub async fn get_files_to_update(window: Window) -> Result<Vec<FileInfo>, String> {
    info!("Starting get_files_to_update");
    let start_time = Instant::now();
    let server_hash_file = get_server_hash_file().await?;
    let local_game_path = get_game_path()?; 

    let files_on_server = server_hash_file["files"].as_array().ok_or("Invalid server hash file format (files array missing)")?;
    info!("Server hash file parsed, {} files found on server", files_on_server.len());

    let mut cache = load_cache_from_disk().unwrap_or_else(|err| {
        warn!("Failed to load cache from disk ({}). Using empty cache.", err);
        HashMap::new()
    });

    let total_server_files = files_on_server.len();
    let processed_count = Arc::new(AtomicUsize::new(0));
    let files_to_update_count = Arc::new(AtomicUsize::new(0));
    let total_update_size = Arc::new(AtomicU64::new(0));

    let files_to_update_list: Vec<FileInfo> = files_on_server.par_iter()
        .filter_map(|file_entry_json| {
            let path_str = match file_entry_json["path"].as_str() {
                Some(p) => p,
                None => {
                    warn!("Skipping file entry in server hash due to missing 'path': {:?}", file_entry_json);
                    return None;
                }
            };
            let server_hash = match file_entry_json["hash"].as_str() {
                Some(h) => h,
                None => {
                    warn!("Skipping file entry for '{}' due to missing 'hash': {:?}", path_str, file_entry_json);
                    return None;
                }
            };
            let size_u64 = match file_entry_json["size"].as_u64() {
                Some(s) => s,
                None => {
                    warn!("Skipping file entry for '{}' due to missing 'size': {:?}", path_str, file_entry_json);
                    return None;
                }
            };
            let url_str = file_entry_json["url"].as_str().unwrap_or("").to_string(); 

            let local_file_full_path = local_game_path.join(path_str);

            let current_processed = processed_count.fetch_add(1, Ordering::Relaxed) + 1;
            if current_processed % 50 == 0 || current_processed == total_server_files { 
                let _ = window.emit("file_check_progress", FileCheckProgress {
                    current_file: path_str.to_string(),
                    progress: (current_processed as f64 / total_server_files as f64) * 100.0,
                    current_count: current_processed,
                    total_files: total_server_files,
                    elapsed_time: start_time.elapsed().as_secs_f64(),
                    files_to_update: files_to_update_count.load(Ordering::Relaxed),
                });
            }

            if !local_file_full_path.exists() {
                files_to_update_count.fetch_add(1, Ordering::Relaxed);
                total_update_size.fetch_add(size_u64, Ordering::Relaxed);
                return Some(FileInfo { path: path_str.to_string(), hash: server_hash.to_string(), size: size_u64, url: url_str });
            }

            let metadata = match fs::metadata(&local_file_full_path) {
                Ok(m) => m,
                Err(e) => {
                    warn!("Could not get metadata for local file {}: {}. Marking for update.", path_str, e);
                    files_to_update_count.fetch_add(1, Ordering::Relaxed); 
                    total_update_size.fetch_add(size_u64, Ordering::Relaxed); 
                    return Some(FileInfo { path: path_str.to_string(), hash: server_hash.to_string(), size: size_u64, url: url_str });
                }
            };

            if metadata.len() != size_u64 { 
                files_to_update_count.fetch_add(1, Ordering::Relaxed);
                total_update_size.fetch_add(size_u64, Ordering::Relaxed);
                return Some(FileInfo { path: path_str.to_string(), hash: server_hash.to_string(), size: size_u64, url: url_str });
            }
            
            let local_modified_time = metadata.modified().ok()?; // If this is None, we might need to re-hash
            if let Some(cached_info) = cache.get(path_str) {
                 if cached_info.last_modified == local_modified_time && cached_info.hash == server_hash {
                    return None; 
                }
            }

            let local_hash = match calculate_file_hash(&local_file_full_path) {
                Ok(h) => h,
                Err(e) => {
                    warn!("Could not calculate hash for local file {}: {}. Marking for update.", path_str, e);
                    files_to_update_count.fetch_add(1, Ordering::Relaxed);
                    total_update_size.fetch_add(size_u64, Ordering::Relaxed);
                    return Some(FileInfo { path: path_str.to_string(), hash: server_hash.to_string(), size: size_u64, url: url_str });
                }
            };
            
            if let Some(mod_time) = local_modified_time { // Ensure we have a mod_time before caching
               cache.insert(path_str.to_string(), CachedFileInfo { hash: local_hash.clone(), last_modified: mod_time });
            }


            if local_hash != server_hash {
                files_to_update_count.fetch_add(1, Ordering::Relaxed);
                total_update_size.fetch_add(size_u64, Ordering::Relaxed);
                Some(FileInfo { path: path_str.to_string(), hash: server_hash.to_string(), size: size_u64, url: url_str })
            } else {
                None
            }
        })
        .collect();

    save_cache_to_disk(&cache).unwrap_or_else(|err| warn!("Failed to save cache: {}", err));
    
    info!("File check completed. Files to update: {}", files_to_update_list.len());
    let _ = window.emit("file_check_completed", json!({
        "total_files": total_server_files,
        "files_to_update": files_to_update_list.len(),
        "total_size": total_update_size.load(Ordering::Relaxed), 
        "total_time_seconds": start_time.elapsed().as_secs_f64(),
        "average_time_per_file_ms": if total_server_files > 0 { (start_time.elapsed().as_millis() as f64) / (total_server_files as f64) } else { 0.0 }
    }));

    Ok(files_to_update_list)
}


#[tauri::command]
pub async fn check_update_required(window: Window) -> Result<bool, String> {
    match get_files_to_update(window).await {
        Ok(files) => Ok(!files.is_empty()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn update_file(
    app_handle: AppHandle, 
    window: Window, 
    file_info: FileInfo,
    total_files_to_download: usize, 
    current_file_overall_index: usize, 
    total_download_size_bytes: u64, 
    accumulated_downloaded_bytes: u64, 
) -> Result<u64, String> { 
    let game_path = get_game_path()?; 
    let file_path_local = game_path.join(&file_info.path);

    if let Some(parent_dir) = file_path_local.parent() {
        tokio::fs::create_dir_all(parent_dir).await.map_err(|e| e.to_string())?;
    }

    let client = reqwest::Client::builder().no_proxy().build().map_err(|e| e.to_string())?;
    let res = client.get(&file_info.url).send().await.map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("Failed to download file {}: Server responded with {}", file_info.path, res.status()));
    }

    let current_file_total_size = res.content_length().unwrap_or(file_info.size);
    let mut file_on_disk = tokio::fs::File::create(&file_path_local).await.map_err(|e| e.to_string())?;
    
    let mut downloaded_for_current_file: u64 = 0;
    let mut stream = res.bytes_stream();
    let download_start_time = Instant::now();
    let mut last_progress_update_time = Instant::now();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| e.to_string())?;
        file_on_disk.write_all(&chunk).await.map_err(|e| e.to_string())?;
        downloaded_for_current_file += chunk.len() as u64;

        if last_progress_update_time.elapsed() >= Duration::from_millis(100) || downloaded_for_current_file == current_file_total_size {
            let elapsed_since_download_start = download_start_time.elapsed();
            let current_speed = if elapsed_since_download_start.as_secs_f64() > 0.0 {
                downloaded_for_current_file as f64 / elapsed_since_download_start.as_secs_f64()
            } else { 0.0 }; // Avoid division by zero if elapsed time is too short

            let overall_downloaded_bytes = accumulated_downloaded_bytes + downloaded_for_current_file;

            let _ = window.emit("download_progress", ProgressPayload {
                file_name: file_info.path.clone(),
                // Calculate overall progress based on total downloaded bytes for all files vs total size of all files
                progress: if total_download_size_bytes > 0 { (overall_downloaded_bytes as f64 / total_download_size_bytes as f64) * 100.0 } else { 0.0 },
                speed: current_speed,
                downloaded_bytes: overall_downloaded_bytes, 
                total_bytes: total_download_size_bytes,
                total_files: total_files_to_download,
                elapsed_time: elapsed_since_download_start.as_secs_f64(), 
                current_file_index: current_file_overall_index,
            });
            last_progress_update_time = Instant::now();
        }
        // Consider removing the small sleep if network backpressure is sufficient
        // tokio::time::sleep(Duration::from_millis(1)).await; 
    }
    file_on_disk.flush().await.map_err(|e| e.to_string())?;

    let downloaded_hash = calculate_file_hash(&file_path_local)?;
    if downloaded_hash != file_info.hash {
        return Err(format!("Hash mismatch for downloaded file: {}. Expected {}, got {}", file_info.path, file_info.hash, downloaded_hash));
    }
    
    Ok(downloaded_for_current_file)
}


#[tauri::command]
pub async fn download_all_files(
    app_handle: AppHandle,
    window: Window,
    files_to_update: Vec<FileInfo>
) -> Result<Vec<u64>, String> {
    let total_files = files_to_update.len();
    let overall_total_size: u64 = files_to_update.iter().map(|f| f.size).sum();

    if total_files == 0 {
        info!("No files to download.");
        window.emit("download_complete", json!({})).map_err(|e| e.to_string())?;
        return Ok(vec![]);
    }

    let mut individual_downloaded_sizes = Vec::with_capacity(total_files);
    let mut current_accumulated_bytes: u64 = 0;

    for (index, file_info) in files_to_update.into_iter().enumerate() {
        info!("Downloading file {}/{}: {}", index + 1, total_files, file_info.path);
        match update_file(
            app_handle.clone(),
            window.clone(),
            file_info.clone(), 
            total_files,
            index + 1,
            overall_total_size,
            current_accumulated_bytes, // Pass the current total, not just this file's downloaded
        ).await {
            Ok(bytes_downloaded_for_file) => {
                individual_downloaded_sizes.push(bytes_downloaded_for_file);
                current_accumulated_bytes += bytes_downloaded_for_file;
            }
            Err(e) => {
                error!("Failed to download file {}: {}", file_info.path, e);
                return Err(format!("Failed to download {}: {}", file_info.path, e));
            }
        }
    }

    info!("All files downloaded successfully.");
    window.emit("download_complete", json!({})).map_err(|e| e.to_string())?;
    Ok(individual_downloaded_sizes)
}
