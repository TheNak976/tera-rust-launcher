// External crate imports
use lazy_static::lazy_static;
use log::{error, info,Record, Level, Metadata};
use once_cell::sync::Lazy;
use prost::Message;
use winapi::um::errhandlingapi::GetLastError;
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::process::Command;
use std::ptr::null_mut;
use std::slice;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::runtime::Runtime;
use winapi::shared::minwindef::{BOOL, LPARAM, LRESULT, TRUE, UINT, WPARAM};
use winapi::shared::windef::HWND;
use winapi::um::libloaderapi::GetModuleHandleW;
use winapi::um::winuser::*;
use dotenv::dotenv;
use std::env;
use std::process::ExitStatus;
use crate::global_credentials::{GLOBAL_CREDENTIALS, set_credentials};
use reqwest;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::{watch, Notify, mpsc as other_mpsc};
use winapi::um::winuser::GetClassInfoExW;

// Constants
const WM_GAME_EXITED: u32 = WM_USER + 1;

// Module includes
mod serverlist {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "\\src\\_serverlist_proto.rs"));
}
use serverlist::{server_list::ServerInfo, ServerList};

// Global static variables
lazy_static! {
    static ref SERVER_LIST_SENDER: Mutex<Option<mpsc::Sender<(WPARAM, usize)>>> = Mutex::new(None);
}

static WINDOW_HANDLE: Lazy<Mutex<Option<SafeHWND>>> = Lazy::new(|| Mutex::new(None));

static GAME_RUNNING: Lazy<AtomicBool> = Lazy::new(|| AtomicBool::new(false));
static GAME_STATUS_SENDER: Lazy<watch::Sender<bool>> = Lazy::new(|| {
    let (tx, _) = watch::channel(false);
    tx
});

// Struct definitions
#[derive(Clone, Copy)]
struct SafeHWND(HWND);

// Implementations
unsafe impl Send for SafeHWND {}
unsafe impl Sync for SafeHWND {}

impl SafeHWND {
    fn new(hwnd: HWND) -> Self {
        SafeHWND(hwnd)
    }

    fn get(&self) -> HWND {
        self.0
    }
}

pub struct TeraLogger {
    sender: other_mpsc::Sender<String>,
}

impl log::Log for TeraLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.target().starts_with("teralib") && metadata.level() <= Level::Info
    }

    fn log(&self, record: &Record) {
        if self.enabled(record.metadata()) {
            let log_message = format!("{} - {}", record.level(), record.args());
            let _ = self.sender.try_send(log_message);
        }
    }

    fn flush(&self) {}
}



/// Sets up logging for the application.
///
/// This function initializes the global logger with an Info level filter.
/// It uses a lazy initialization pattern to ensure the logger is only set up once.
pub fn setup_logging() -> (TeraLogger, other_mpsc::Receiver<String>) {
    let (sender, receiver) = other_mpsc::channel(100);
    (TeraLogger { sender }, receiver)
}




/// Runs the game with the provided credentials and language.
///
/// This function sets the credentials, checks if the game is already running,
/// and launches the game asynchronously.
///
/// # Arguments
///
/// * `account_name` - The account name as a &str.
/// * `ticket` - The session ticket as a &str.
/// * `game_lang` - The game language as a &str.
///
/// # Returns
///
/// A Result containing the exit status of the game process or an error.
pub async fn run_game(account_name: &str, characters_count:&str, ticket: &str, game_lang: &str, game_path: &str) -> Result<ExitStatus, Box<dyn std::error::Error>> {
    info!("Starting run_game function");

    if is_game_running() {
        return Err("Game is already running".into());
    }

    set_credentials(account_name, characters_count, ticket, game_lang, game_path);

    info!(
        "Set credentials - Account: {}, Characters_count: {}, Ticket: {}, Lang: {}, Game Path: {}",
        GLOBAL_CREDENTIALS.get_account_name(),
        GLOBAL_CREDENTIALS.get_characters_count(),
        GLOBAL_CREDENTIALS.get_ticket(),
        GLOBAL_CREDENTIALS.get_game_lang(),
        GLOBAL_CREDENTIALS.get_game_path()
    );

    launch_game().await
}

/// Launches the game and handles the game process lifecycle.
///
/// This function spawns the game process, manages the game window, and handles
/// server list requests asynchronously.
///
/// # Returns
///
/// A Result containing the exit status of the game process or an error.
async fn launch_game() -> Result<ExitStatus, Box<dyn std::error::Error>> {
    if GAME_RUNNING.load(Ordering::SeqCst) {
        return Err("Game is already running".into());
    }

    GAME_RUNNING.store(true, Ordering::SeqCst);
    GAME_STATUS_SENDER.send(true).unwrap();
    info!("Game status set to running");

    info!("Launching game for account: {}", GLOBAL_CREDENTIALS.get_account_name());

    let (tx, rx) = mpsc::channel::<(WPARAM, usize)>();
    *SERVER_LIST_SENDER.lock().unwrap() = Some(tx);

    let tcs = Arc::new(tokio::sync::Notify::new());
    let tcs_clone = Arc::clone(&tcs);

    let handle = tokio::task::spawn_blocking(move || unsafe { create_and_run_game_window(tcs_clone) });

    tokio::spawn(async move {
        while let Ok((w_param, sender)) = rx.recv() {
            unsafe {
                handle_server_list_request(w_param, sender);
            }
        }
    });

    tcs.notified().await;

    let mut child = Command::new(GLOBAL_CREDENTIALS.get_game_path(),
    )
    .arg(format!("-LANGUAGEEXT={}", GLOBAL_CREDENTIALS.get_game_lang()))
    .spawn()?;

    let pid = child.id();
    info!("Game process spawned with PID: {}", pid);

    let status = child.wait()?;
    info!("Game process exited with status: {:?}", status);

    GAME_RUNNING.store(false, Ordering::SeqCst);
    GAME_STATUS_SENDER.send(false).unwrap();
    info!("Game status set to not running");

    if let Ok(handle) = WINDOW_HANDLE.lock() {
        if let Some(safe_hwnd) = *handle {
            let hwnd = safe_hwnd.get();
            unsafe {
                PostMessageW(hwnd, WM_GAME_EXITED, 0, 0);
            }
        } else {
            error!("Window handle not found when trying to post WM_GAME_EXITED message");
        }
    } else {
        error!("Failed to acquire lock on WINDOW_HANDLE");
    }
    handle.await?;

    Ok(status)
}



/// Converts a Rust string slice to a null-terminated wide string (UTF-16).
///
/// This function is useful for interoperability with Windows API functions
/// that expect wide string parameters.
///
/// # Arguments
///
/// * `s` - The input string slice to convert.
///
/// # Returns
///
/// A vector of u16 values representing the wide string, including a null terminator.
fn to_wstring(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(Some(0)).collect()
}

/// Returns a receiver for game status updates.
///
/// This function provides a way to subscribe to game status changes.
///
/// # Returns
///
/// A `watch::Receiver<bool>` that can be used to receive game status updates.
pub fn get_game_status_receiver() -> watch::Receiver<bool> {
    GAME_STATUS_SENDER.subscribe()
}

/// Checks if the game is currently running.
///
/// # Returns
///
/// A boolean indicating whether the game is running (true) or not (false).
pub fn is_game_running() -> bool {
    GAME_RUNNING.load(Ordering::SeqCst)
}

/// Resets the global state of the application.
///
/// This function performs the following actions:
/// 1. Sets the game running status to false.
/// 2. Sends a game status update.
/// 3. Clears the stored window handle.
///
/// It's typically called when cleaning up or restarting the application state.
pub fn reset_global_state() {
    GAME_RUNNING.store(false, Ordering::SeqCst);
    if let Err(e) = GAME_STATUS_SENDER.send(false) {
        error!("Failed to send game status: {:?}", e);
    }
    if let Ok(mut handle) = WINDOW_HANDLE.lock() {
        *handle = None;
    }
    info!("Global state reset completed");
}

/// Window procedure for handling Windows messages.
///
/// This function is called by the Windows operating system to process messages
/// for the application's window.
///
/// # Safety
///
/// This function is unsafe because it deals directly with raw pointers and
/// Windows API calls.
///
/// # Arguments
///
/// * `h_wnd` - The handle to the window.
/// * `msg` - The message identifier.
/// * `w_param` - Additional message information (depends on the message).
/// * `l_param` - Additional message information (depends on the message).
///
/// # Returns
///
/// The result of the message processing.
unsafe extern "system" fn wnd_proc(
    h_wnd: HWND,
    msg: UINT,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    info!("Received message: {}", msg);
    match msg {
        WM_COPYDATA => {
            let copy_data = &*(l_param as *const COPYDATASTRUCT);
            info!("Received WM_COPYDATA message");
            let event_id = copy_data.dwData;
            info!("Event ID: {}", event_id);
            let payload = if copy_data.cbData > 0 {
                slice::from_raw_parts(copy_data.lpData as *const u8, copy_data.cbData as usize)
            } else {
                &[]
            };
            let hex_payload: Vec<String> = payload.iter().map(|b| format!("{:02X}", b)).collect();
            info!("Payload (hex): {}", hex_payload.join(" "));

            match event_id {
                1 => handle_account_name_request(w_param, h_wnd),
                3 => handle_session_ticket_request(w_param, h_wnd),
                5 => handle_server_list_request(w_param, h_wnd as usize),
                7 => handle_enter_lobby_or_world(w_param, h_wnd, payload),
                1000 => handle_game_start(w_param, h_wnd, payload),
                1001..=1016 => handle_game_event(w_param, h_wnd, event_id, payload),
                1020 => handle_game_exit(w_param, h_wnd, payload),
                1021 => handle_game_crash(w_param, h_wnd, payload),
                _ => {
                    info!("Unhandled event ID: {}", event_id);
                }
            }
            1
        },
        WM_GAME_EXITED => {
            info!("Received WM_GAME_EXITED in wnd_proc");
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(h_wnd, msg, w_param, l_param),
    }
}

/// Creates and runs the game window.
///
/// This function sets up the window class, creates the window, and enters
/// the message loop for processing window messages. It also handles cleanup
/// when the window is closed.
///
/// # Safety
///
/// This function is unsafe due to its use of raw pointers and Windows API calls.
///
/// # Arguments
///
/// * `tcs` - An `Arc<Notify>` used to signal when the window has been created.
unsafe fn create_and_run_game_window(tcs: Arc<Notify>) {
    let launcher_class_name = "LAUNCHER_CLASS";
    let launcher_window_title = "LAUNCHER_WINDOW";
    let class_name = to_wstring(launcher_class_name);
    let window_name = to_wstring(&launcher_window_title);
    let wnd_class = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        style: 0,
        lpfnWndProc: Some(wnd_proc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: GetModuleHandleW(null_mut()),
        hIcon: null_mut(),
        hCursor: null_mut(),
        hbrBackground: null_mut(),
        lpszMenuName: null_mut(),
        lpszClassName: class_name.as_ptr(),
        hIconSm: null_mut(),
    };

    let atom = RegisterClassExW(&wnd_class);
    if atom == 0 {
        error!("Failed to register window class");
        return;
    }

    let hwnd = CreateWindowExW(
        0,
        class_name.as_ptr(),
        window_name.as_ptr(),
        0,
        0,
        0,
        0,
        0,
        null_mut(),
        null_mut(),
        GetModuleHandleW(null_mut()),
        null_mut(),
    );

    if hwnd.is_null() {
        error!("Failed to create window");
        UnregisterClassW(class_name.as_ptr(), GetModuleHandleW(null_mut()));
        return;
    }

    info!("Window created with HWND: {:?}", hwnd);

    if let Ok(mut handle) = WINDOW_HANDLE.lock() {
        handle.replace(SafeHWND::new(hwnd));
    } else {
        error!("Failed to acquire lock on WINDOW_HANDLE");
    }

    tcs.notify_one();

    let mut msg = std::mem::zeroed();
    info!("Entering message loop");
    while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
        if msg.message == WM_GAME_EXITED {
            info!("Received WM_GAME_EXITED message");
            break;
        }
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    info!("Exiting message loop");

    DestroyWindow(hwnd);
    UnregisterClassW(class_name.as_ptr(), GetModuleHandleW(null_mut()));

    reset_global_state();

    let mut wcex: WNDCLASSEXW = std::mem::zeroed();
    wcex.cbSize = std::mem::size_of::<WNDCLASSEXW>() as u32;
    
    EnumWindows(Some(enum_window_proc), class_name.as_ptr() as LPARAM);

    if GetClassInfoExW(GetModuleHandleW(null_mut()), class_name.as_ptr(), &mut wcex) != 0 {
        if UnregisterClassW(class_name.as_ptr(), GetModuleHandleW(null_mut())) == 0 {
            let error = GetLastError();
            error!("Failed to unregister class. Error code: {}", error);
        } else {
            info!("Tera ClassName Unregistered successfully");
        }
    } else {
        info!("Tera ClassName does not exist or is already unregistered");
    }
}

/// Callback function for enumerating windows.
///
/// This function is called for each top-level window on the screen.
/// It checks if the window's class name matches the given class name,
/// and if so, destroys the window.
///
/// # Safety
///
/// This function is unsafe because it deals with raw window handles and
/// destroys windows, which can have system-wide effects.
///
/// # Arguments
///
/// * `hwnd` - Handle to a top-level window.
/// * `lparam` - Application-defined value given in EnumWindows.
///
/// # Returns
///
/// Returns TRUE to continue enumeration, FALSE to stop.
unsafe extern "system" fn enum_window_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let mut class_name: [u16; 256] = [0; 256];
    let len = GetClassNameW(hwnd, class_name.as_mut_ptr(), 256) as usize;
    let class_name = &class_name[..len];

    let search_class = slice::from_raw_parts(lparam as *const u16, 256);
    let search_len = search_class.iter().position(|&c| c == 0).unwrap_or(256);
    let search_class = &search_class[..search_len];

    if class_name.starts_with(search_class) {
        DestroyWindow(hwnd);
    }
    TRUE
}

/// Sends a response message to a specified recipient.
///
/// This function constructs a COPYDATASTRUCT and sends it using the SendMessageW Windows API function.
///
/// # Safety
///
/// This function is unsafe due to its use of raw pointers and Windows API calls.
///
/// # Arguments
///
/// * `recipient` - The HWND of the recipient window as a WPARAM.
/// * `sender` - The sender's window handle as a HWND.
/// * `game_event` - The event identifier as a usize.
/// * `payload` - The data payload to be sent as a slice of bytes.
unsafe fn send_response_message(recipient: WPARAM, sender: HWND, game_event: usize, payload: &[u8]) {
    info!("Sending response message - Event: {}, Payload length: {}", game_event, payload.len());
    let copy_data = COPYDATASTRUCT {
        dwData: game_event,
        cbData: payload.len() as u32,
        lpData: payload.as_ptr() as *mut _,
    };
    let result = SendMessageW(
        recipient as HWND,
        WM_COPYDATA,
        sender as WPARAM,
        &copy_data as *const _ as LPARAM,
    );
    info!("SendMessageW result: {}", result);
}

/// Handles the account name request from the game client.
///
/// This function retrieves the account name and sends it back to the game client.
///
/// # Safety
///
/// This function is unsafe due to its use of raw pointers and Windows API calls.
///
/// # Arguments
///
/// * `recipient` - The HWND of the recipient window as a WPARAM.
/// * `sender` - The sender's window handle as a HWND.
unsafe fn handle_account_name_request(recipient: WPARAM, sender: HWND) {
    let account_name = GLOBAL_CREDENTIALS.get_account_name();
    info!("Account Name Request - Sending: {}", account_name);
    let account_name_utf16: Vec<u8> = account_name.encode_utf16()
        .flat_map(|c| c.to_le_bytes().to_vec())
        .collect();
    send_response_message(recipient, sender, 2, &account_name_utf16);
}

/// Handles the session ticket request from the game client.
///
/// This function retrieves the session ticket and sends it back to the game client.
///
/// # Safety
///
/// This function is unsafe due to its use of raw pointers and Windows API calls.
///
/// # Arguments
///
/// * `recipient` - The HWND of the recipient window as a WPARAM.
/// * `sender` - The sender's window handle as a HWND.
unsafe fn handle_session_ticket_request(recipient: WPARAM, sender: HWND) {
    let session_ticket = GLOBAL_CREDENTIALS.get_ticket();
    info!("Session Ticket Request - Sending: {}", session_ticket);
    send_response_message(recipient, sender, 4, session_ticket.as_bytes());
}

/// Handles the server list request from the game client.
///
/// This function retrieves the server list asynchronously and sends it back to the game client.
///
/// # Safety
///
/// This function is unsafe due to its use of raw pointers and Windows API calls.
///
/// # Arguments
///
/// * `recipient` - The HWND of the recipient window as a WPARAM.
/// * `sender` - The sender's window handle as a usize.
unsafe fn handle_server_list_request(recipient: WPARAM, sender: usize) {
    let runtime = Runtime::new().expect("Failed to create Tokio runtime");
    let server_list_data =
        runtime.block_on(async { get_server_list().await.expect("Failed to get server list") });
    send_response_message(recipient, sender as HWND, 6, &server_list_data);
}

/// Handles the event of entering a lobby or world.
///
/// This function processes the payload to determine if the player is entering a lobby or a specific world,
/// and sends an appropriate response.
///
/// # Safety
///
/// This function is unsafe due to its use of raw pointers and Windows API calls.
///
/// # Arguments
///
/// * `recipient` - The HWND of the recipient window as a WPARAM.
/// * `sender` - The HWND of the sender window.
/// * `payload` - The payload containing world information, if any.
unsafe fn handle_enter_lobby_or_world(recipient: WPARAM, sender: HWND, payload: &[u8]) {
    if payload.is_empty() {
        on_lobby_entered();
        send_response_message(recipient, sender, 8, &[]);
    } else {
        let world_name = String::from_utf8_lossy(payload);
        on_world_entered(&world_name);
        send_response_message(recipient, sender, 8, payload);
    }
}

/// Handles the game start event.
///
/// This function is called when the game starts. Currently, it only logs the event.
///
/// # Safety
///
/// This function is unsafe due to its use of raw pointers, but it doesn't perform any unsafe operations.
///
/// # Arguments
///
/// * `_recipient` - The HWND of the recipient window as a WPARAM (unused).
/// * `_sender` - The HWND of the sender window (unused).
/// * `_payload` - The payload associated with the game start event (unused).
unsafe fn handle_game_start(_recipient: WPARAM, _sender: HWND, _payload: &[u8]) {
    info!("Game started");
}

/// Handles various game events.
///
/// This function is called for various game events identified by the event_id.
/// Currently, it only logs the event.
///
/// # Safety
///
/// This function is unsafe due to its use of raw pointers, but it doesn't perform any unsafe operations.
///
/// # Arguments
///
/// * `_recipient` - The HWND of the recipient window as a WPARAM (unused).
/// * `_sender` - The HWND of the sender window (unused).
/// * `event_id` - The identifier of the game event.
/// * `_payload` - The payload associated with the game event (unused).
unsafe fn handle_game_event(_recipient: WPARAM, _sender: HWND, event_id: usize, _payload: &[u8]) {
    info!("Game event {} received", event_id);
}

/// Handles the game exit event.
///
/// This function is called when the game exits normally. Currently, it only logs the event.
///
/// # Safety
///
/// This function is unsafe due to its use of raw pointers, but it doesn't perform any unsafe operations.
///
/// # Arguments
///
/// * `_recipient` - The HWND of the recipient window as a WPARAM (unused).
/// * `_sender` - The HWND of the sender window (unused).
/// * `_payload` - The payload associated with the game exit event (unused).
unsafe fn handle_game_exit(_recipient: WPARAM, _sender: HWND, _payload: &[u8]) {
    info!("Game ended");
}

/// Handles the game crash event.
///
/// This function is called when the game crashes. Currently, it only logs the event as an error.
///
/// # Safety
///
/// This function is unsafe due to its use of raw pointers, but it doesn't perform any unsafe operations.
///
/// # Arguments
///
/// * `_recipient` - The HWND of the recipient window as a WPARAM (unused).
/// * `_sender` - The HWND of the sender window (unused).
/// * `_payload` - The payload associated with the game crash event (unused).
unsafe fn handle_game_crash(_recipient: WPARAM, _sender: HWND, _payload: &[u8]) {
    error!("Game crash detected");
}

/// Logs the event of entering the lobby.
fn on_lobby_entered() {
    info!("Entered the lobby");
}

/// Logs the event of entering a world.
///
/// # Arguments
///
/// * `world_name` - The name of the world being entered.
fn on_world_entered(world_name: &str) {
    info!("Entered the world: {}", world_name);
}

/// Asynchronously retrieves the server list.
///
/// This function sends a GET request to a local server to retrieve the server list,
/// then parses the JSON response into a ServerList struct.
///
/// # Returns
///
/// A Result containing a Vec<u8> of the encoded server list on success, or an error on failure.
async fn get_server_list() -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    
    let url = env::var("SERVER_LIST_URL").expect("SERVER_LIST_URL must be set");
    let client = reqwest::Client::new();
    let response = client
        .get(url)
        .timeout(Duration::from_secs(10))
        .send()
        .await?;

    if !response.status().is_success() {
        return Err(format!("Unsuccessful HTTP response: {}", response.status()).into());
    }

    let json: Value = response.json().await?;
    let server_list = parse_server_list_json(&json)?;
    
    let mut buf = Vec::new();
    server_list.encode(&mut buf)?;
    Ok(buf)
}

/// Parses a JSON Value into a ServerList struct.
///
/// This function takes a JSON representation of a server list and converts it
/// into a strongly-typed ServerList struct. It performs thorough error checking
/// to ensure all required fields are present and valid.
///
/// # Arguments
///
/// * `json` - A reference to a serde_json::Value containing the server list data.
///
/// # Returns
///
/// * `Result<ServerList, Box<dyn std::error::Error>>` - A Result which is either:
///   - Ok(ServerList): A fully populated ServerList struct
///   - Err(Box<dyn std::error::Error>): An error describing what went wrong during parsing
fn parse_server_list_json(json: &Value) -> Result<ServerList, Box<dyn std::error::Error>> {
    let mut server_list = ServerList {
        servers: vec![],
        last_server_id: 0,
        sort_criterion: 3,
    };

    // Parse GLOBAL_CREDENTIALS.get_characters_count()
    let credentials = GLOBAL_CREDENTIALS.get_characters_count();
    info!("Raw credentials string: {}", credentials);

    let parts: Vec<&str> = credentials.split('|').collect();
    
    let player_last_server = parts.get(0).unwrap_or(&"0");
    let player_last_server_id = if parts.len() > 1 && !parts[1].is_empty() {
        parts[1].split(',').next().unwrap_or("0").parse::<u32>().unwrap_or(0)
    } else {
        2800
    };
    let player_characters_count = if parts.len() > 1 {
        parts[1].split(',').nth(1).unwrap_or("0").parse::<u32>().unwrap_or(0)
    } else {
        0
    };

    info!("Parsed values - Last server: {}, Last server ID: {}, Characters count: {}", 
          player_last_server, player_last_server_id, player_characters_count);

    let display_count = if player_characters_count > 0 {
        format!("({})", player_characters_count)
    } else {
        String::new()
    };

    info!("Display count string: '{}'", display_count);

    let servers = json["servers"].as_array().ok_or("No servers found in JSON")?;
    for server in servers {
        let name = format!("{}{}", 
            server["name"].as_str().ok_or("Missing or invalid 'name' field")?,
            display_count
        );
        let title = format!("{}{}", 
            server["title"].as_str().ok_or("Missing or invalid 'title' field")?,
            display_count
        );

        info!("Formatted server name: {}", name);
        info!("Formatted server title: {}", title);

        let server_info = ServerInfo {
            id: server["id"].as_u64().ok_or("Missing or invalid 'id' field")? as u32,
            name: utf16_to_bytes(&name),
            category: utf16_to_bytes(server["category"].as_str().ok_or("Missing or invalid 'category' field")?),
            title: utf16_to_bytes(&title),
            queue: utf16_to_bytes(server["queue"].as_str().ok_or("Missing or invalid 'queue' field")?),
            population: utf16_to_bytes(server["population"].as_str().ok_or("Missing or invalid 'population' field")?),
            address: ipv4_to_u32(server["address"].as_str().ok_or("Missing or invalid 'address' field")?),
            port: server["port"].as_u64().ok_or("Missing or invalid 'port' field")? as u32,
            available: server["available"].as_u64().ok_or("Missing or invalid 'available' field")? as u32,
            unavailable_message: utf16_to_bytes(server["unavailable_message"].as_str().unwrap_or("")),
            host: utf16_to_bytes(server["host"].as_str().ok_or("Missing or invalid 'host' field")?),
        };
        server_list.servers.push(server_info);
    }

    server_list.last_server_id = player_last_server_id;
    server_list.sort_criterion = json["sort_criterion"].as_u64().unwrap_or(3) as u32;

    Ok(server_list)
}

/// Converts a Rust string to UTF-16 little-endian bytes.
///
/// This function is useful for preparing strings for Windows API calls that expect UTF-16.
///
/// # Arguments
///
/// * `s` - A string slice that holds the text to be converted.
///
/// # Returns
///
/// A vector of bytes representing the UTF-16 little-endian encoded string.
fn utf16_to_bytes(s: &str) -> Vec<u8> {
    s.encode_utf16()
        .flat_map(|c| c.to_le_bytes().to_vec())
        .collect()
}

/// Converts an IPv4 address string to a u32 representation.
///
/// # Arguments
///
/// * `ip` - A string slice that holds the IPv4 address.
///
/// # Returns
///
/// A u32 representation of the IP address, or 0 if parsing fails.
fn ipv4_to_u32(ip: &str) -> u32 {
    ip.parse::<std::net::Ipv4Addr>()
        .map(|addr| u32::from_be_bytes(addr.octets()))
        .unwrap_or(0)
}