use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::SystemTime;
use tauri::Manager;

struct SpawnConfig {
    exe: PathBuf,
    entry: PathBuf,
    work_dir: PathBuf,
}

struct BackendProcesses {
    node: Option<Child>,
    python: Option<Child>,
    node_restarts: u32,
    python_restarts: u32,
    node_config: Option<SpawnConfig>,
    python_config: Option<SpawnConfig>,
}

/// Track whether wallpaper (click-through) mode is active
struct WallpaperState {
    enabled: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SystemInfo {
    pub platform: String,
    pub release: String,
    pub arch: String,
    pub hostname: String,
    pub total_memory: u64,
    pub free_memory: u64,
    pub home_dir: String,
    pub cpus: usize,
    pub uptime: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CommandResult {
    pub success: bool,
    pub output: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NativeFile {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
}

#[tauri::command]
fn get_system_info() -> SystemInfo {
    use sysinfo::System;
    let sys = System::new_all();
    // sysinfo reports memory in bytes; sys_info was KB. Preserve backward-compat by converting to KB.
    SystemInfo {
        platform: std::env::consts::OS.to_string(),
        release: System::long_os_version().unwrap_or_default(),
        arch: std::env::consts::ARCH.to_string(),
        hostname: System::host_name().unwrap_or_default(),
        total_memory: sys.total_memory() / 1024,
        free_memory: sys.available_memory() / 1024,
        home_dir: dirs_next::home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        cpus: sys.physical_core_count().unwrap_or(1),
        uptime: System::uptime(),
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TempReading {
    pub label: String,
    pub celsius: f32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LiveStats {
    pub cpu_percent: f32,
    pub memory_used_gb: f32,
    pub memory_total_gb: f32,
    pub memory_percent: f32,
    pub gpu_vendor: Option<String>,
    pub gpu_utilization: Option<f32>,
    pub temperatures: Vec<TempReading>,
    pub fan_speed_rpm: Option<f32>,
    pub hostname: String,
    pub uptime_seconds: u64,
}

fn detect_gpu() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("wmic")
            .args([
                "path",
                "Win32_VideoController",
                "get",
                "name",
                "/format:csv",
            ])
            .output();
        if let Ok(out) = output {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines().skip(2) {
                let parts: Vec<&str> = line.split(',').collect();
                if parts.len() >= 2 {
                    let name = parts[1].trim();
                    if !name.is_empty() {
                        return Some(name.to_string());
                    }
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Linux: check lspci
        let output = Command::new("sh")
            .args(["-c", "lspci | grep -i vga | head -1 | cut -d: -f3"])
            .output();
        if let Ok(out) = output {
            let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}

#[tauri::command]
fn get_live_stats() -> LiveStats {
    use sysinfo::System;

    let mut sys = System::new_all();
    sys.refresh_all();
    std::thread::sleep(std::time::Duration::from_millis(100));
    sys.refresh_cpu_all();

    let cpu_percent = sys.global_cpu_usage();
    let total_mem = sys.total_memory() as f32;
    let used_mem = sys.used_memory() as f32;
    let mem_percent = if total_mem > 0.0 {
        (used_mem / total_mem) * 100.0
    } else {
        0.0
    };

    let gpu_vendor = detect_gpu();

    let components = sysinfo::Components::new_with_refreshed_list();
    let temperatures: Vec<TempReading> = components
        .iter()
        .filter(|c| c.temperature().is_some())
        .map(|c| TempReading {
            label: c.label().to_string(),
            celsius: c.temperature().unwrap(),
        })
        .collect();

    LiveStats {
        cpu_percent: (cpu_percent * 100.0).min(100.0),
        memory_used_gb: used_mem / 1024.0 / 1024.0 / 1024.0,
        memory_total_gb: total_mem / 1024.0 / 1024.0 / 1024.0,
        memory_percent: mem_percent,
        gpu_vendor,
        gpu_utilization: None,
        temperatures,
        fan_speed_rpm: None,
        hostname: System::host_name().unwrap_or_default(),
        uptime_seconds: System::uptime(),
    }
}

#[tauri::command]
fn list_home_files() -> Vec<NativeFile> {
    let home = dirs_next::home_dir().unwrap_or_default();
    let entries = std::fs::read_dir(&home);
    match entries {
        Ok(iter) => iter
            .filter_map(|e| e.ok())
            .take(50)
            .map(|e| {
                let path = e.path();
                let is_dir = path.is_dir();
                NativeFile {
                    name: e.file_name().to_string_lossy().to_string(),
                    path: path.to_string_lossy().to_string(),
                    is_directory: is_dir,
                }
            })
            .collect(),
        Err(_) => vec![],
    }
}

#[tauri::command]
fn run_command(command: String) -> CommandResult {
    let now = SystemTime::now();
    let truncated: String = if command.len() > 500 {
        format!("{}... (truncated, {} bytes total)", &command[..500], command.len())
    } else {
        command.clone()
    };

    let output = if cfg!(target_os = "windows") {
        Command::new("cmd").args(["/C", &command]).output()
    } else {
        Command::new("sh").args(["-c", &command]).output()
    };

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            let success = out.status.success();
            eprintln!(
                "[LumiOS Audit] ts={:?} ok={} cmd={}",
                now, success, truncated
            );
            CommandResult {
                success,
                output: if stdout.is_empty() { stderr } else { stdout },
            }
        }
        Err(e) => {
            eprintln!(
                "[LumiOS Audit] ts={:?} ok=false cmd={} err={}",
                now, truncated, e
            );
            CommandResult {
                success: false,
                output: e.to_string(),
            }
        }
    }
}

fn spawn_python(python_exe: &std::path::Path, api_py: &std::path::Path, work_dir: &std::path::Path) -> Option<Child> {
    let normalized_python = normalize_unc(python_exe);
    let normalized_api = normalize_unc(api_py);
    let normalized_cwd = normalize_unc(work_dir);
    println!(
        "[LumiOS] Starting GPT-SoVITS API: {} {} (cwd: {})",
        normalized_python.display(),
        normalized_api.display(),
        normalized_cwd.display(),
    );
    match Command::new(normalized_python)
        .arg(normalized_api)
        .arg("-a")
        .arg("127.0.0.1")
        .arg("-p")
        .arg("9880")
        .arg("-c")
        .arg("GPT_SoVITS/configs/tts_infer.yaml")
        .current_dir(normalized_cwd)
        .spawn()
    {
        Ok(child) => {
            println!("[LumiOS] GPT-SoVITS API PID: {}", child.id());
            Some(child)
        }
        Err(e) => {
            eprintln!("[LumiOS] Failed to start GPT-SoVITS API: {}", e);
            None
        }
    }
}

fn resolve_resource_dir(resource_dir: &Path, name: &str) -> PathBuf {
    let direct = resource_dir.join(name);
    if direct.exists() {
        return direct;
    }

    let staged = resource_dir.join("desktop-resources").join(name);
    if staged.exists() {
        return staged;
    }

    // NSIS bundles resources inside a _up_ subdirectory (update-ready layout)
    let nsis = resource_dir.join("_up_").join("desktop-resources").join(name);
    if nsis.exists() {
        return nsis;
    }

    // Fallback: check relative to the executable's directory (some install scenarios)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let exe_relative = exe_dir.join(name);
            if exe_relative.exists() {
                return exe_relative;
            }
            let exe_nsis = exe_dir.join("_up_").join("desktop-resources").join(name);
            if exe_nsis.exists() {
                return exe_nsis;
            }
        }
    }

    direct
}

/// Strip Windows extended-length path prefix (\\?\) that external tools (Node.js) can't handle
fn normalize_unc(path: &Path) -> &Path {
    if let Some(s) = path.to_str() {
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            return Path::new(stripped);
        }
    }
    path
}

#[tauri::command]
fn open_item(target: String) -> CommandResult {
    // Open file, folder, app, or URL with the OS default handler
    let result = if cfg!(target_os = "windows") {
        Command::new("cmd")
            .args(["/C", "start", "", &target])
            .output()
    } else if cfg!(target_os = "macos") {
        Command::new("open").arg(&target).output()
    } else {
        Command::new("xdg-open").arg(&target).output()
    };
    match result {
        Ok(out) => CommandResult {
            success: out.status.success(),
            output: format!("Opened: {}", target),
        },
        Err(e) => CommandResult {
            success: false,
            output: e.to_string(),
        },
    }
}

#[tauri::command]
fn set_wallpaper_mode(
    enabled: bool,
    state: tauri::State<'_, Mutex<WallpaperState>>,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    let mut wallpaper = state.lock().map_err(|e| e.to_string())?;
    wallpaper.enabled = enabled;

    match window.set_ignore_cursor_events(enabled) {
        Ok(_) => println!("[LumiOS] set_ignore_cursor_events({}) succeeded", enabled),
        Err(e) => eprintln!("[LumiOS] set_ignore_cursor_events({}) FAILED: {}", enabled, e),
    }

    println!("[LumiOS] Wallpaper mode: {}", if enabled { "ON (click-through)" } else { "OFF" });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Mutex::new(BackendProcesses { node: None, python: None, node_restarts: 0, python_restarts: 0, node_config: None, python_config: None }))
        .manage(Mutex::new(WallpaperState { enabled: false }))
        .invoke_handler(tauri::generate_handler![
            get_system_info,
            get_live_stats,
            list_home_files,
            run_command,
            open_item,
            set_wallpaper_mode,
        ])
        .setup(|app| {
            let resource_dir = app
                .path()
                .resource_dir()
                .unwrap_or_default();

            // Position window on secondary monitor if available, otherwise use primary
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(monitors) = window.available_monitors() {
                    if monitors.len() > 1 {
                        let target = &monitors[1];
                        let pos = target.position();
                        let size = target.size();
                        println!(
                            "[LumiOS] Moving to monitor {} ({}x{} @ {},{}),",
                            monitors.len(),
                            size.width,
                            size.height,
                            pos.x,
                            pos.y
                        );
                        let _ = window.set_position(tauri::PhysicalPosition::new(pos.x, pos.y));
                        let _ = window.set_size(tauri::PhysicalSize::new(size.width, size.height));
                    }
                }
                let _ = window.set_fullscreen(false);
            }

            // Ensure WebView2Loader.dll is alongside the EXE
            if let Ok(exe_path) = std::env::current_exe() {
                if let Some(exe_dir) = exe_path.parent() {
                    let dll_dest = exe_dir.join("WebView2Loader.dll");
                    if !dll_dest.exists() {
                        let dll_src = resource_dir
                            .join("desktop-resources")
                            .join("WebView2Loader.dll");
                        if dll_src.exists() {
                            println!("[LumiOS] Copying WebView2Loader.dll to EXE directory");
                            let _ = std::fs::copy(&dll_src, &dll_dest);
                        }
                    }
                }
            }

            // In dev mode, the backend is started by beforeDevCommand; skip spawning Node.js
            if cfg!(debug_assertions) {
                println!("[LumiOS] Dev mode — skipping bundled backend spawn");
            } else {
            // ... rest of spawn code unchanged

            // Spawn Node.js backend
            let dist_server = resolve_resource_dir(&resource_dir, "dist-server");
            let node_exe = dist_server.join("node.exe");
            let server_js = dist_server.join("entry.cjs");
            let server_bundle = dist_server.join("server.mjs");

            if node_exe.exists() && server_js.exists() && server_bundle.exists() {
                let normalized_node = normalize_unc(&node_exe);
                let normalized_entry = normalize_unc(&server_js);
                let normalized_cwd = normalize_unc(&dist_server);
                println!(
                    "[LumiOS] Starting backend: {} {} (cwd: {})",
                    normalized_node.display(),
                    normalized_entry.display(),
                    normalized_cwd.display(),
                );
                match Command::new(&normalized_node)
                    .arg(&normalized_entry)
                    .env("LUMI_DESKTOP", "1")
                    .env("HOST", "127.0.0.1")
                    .current_dir(&normalized_cwd)
                    .spawn()
                {
                    Ok(child) => {
                        println!("[LumiOS] Backend PID: {}", child.id());
                        let app_state = app.state::<Mutex<BackendProcesses>>();
                        let mut state = app_state.lock().unwrap();
                        state.node_config = Some(SpawnConfig {
                            exe: normalized_node.to_path_buf(),
                            entry: normalized_entry.to_path_buf(),
                            work_dir: normalized_cwd.to_path_buf(),
                        });
                        state.node = Some(child);
                    }
                    Err(e) => {
                        eprintln!("[LumiOS] Failed to start backend: {}", e);
                    }
                }
            } else {
                eprintln!(
                    "[LumiOS] Backend not found. node.exe: {}, entry.cjs: {}, server.mjs: {}",
                    node_exe.exists(),
                    server_js.exists(),
                    server_bundle.exists()
                );
            }

            // Spawn GPT-SoVITS Python API server
            let gpt_sovits_dir = resolve_resource_dir(&resource_dir, "gpt-sovits-src");
            let python_exe = gpt_sovits_dir.join("venv/Scripts/python.exe");
            let api_py = gpt_sovits_dir.join("api_v2.py");
            let dev_python = std::path::PathBuf::from("../gpt-sovits-src/venv/Scripts/python.exe");
            let dev_api = std::path::PathBuf::from("../gpt-sovits-src/api_v2.py");

            let python_child = if python_exe.exists() && api_py.exists() {
                spawn_python(&python_exe, &api_py, normalize_unc(&gpt_sovits_dir))
            } else if dev_python.exists() && dev_api.exists() {
                spawn_python(&dev_python, &dev_api, Path::new("../gpt-sovits-src"))
            } else {
                eprintln!(
                    "[LumiOS] GPT-SoVITS API not found at {} or {}",
                    python_exe.display(),
                    dev_python.display()
                );
                None
            };
            if let Some(child) = python_child {
                let app_state = app.state::<Mutex<BackendProcesses>>();
                let mut state = app_state.lock().unwrap();
                if python_exe.exists() && api_py.exists() {
                    state.python_config = Some(SpawnConfig {
                        exe: python_exe,
                        entry: api_py,
                        work_dir: gpt_sovits_dir,
                    });
                } else {
                    state.python_config = Some(SpawnConfig {
                        exe: dev_python,
                        entry: dev_api,
                        work_dir: PathBuf::from("../gpt-sovits-src"),
                    });
                }
                state.python = Some(child);
            }
            } // end else (release mode spawns backend)

            // ── Child process health check (release mode, checks every 30s) ──
            if !cfg!(debug_assertions) {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    let max_restarts: u32 = 3;
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(30));
                        let app_state = app_handle.state::<Mutex<BackendProcesses>>();
                        let mut state = app_state.lock().unwrap();

                        // Check Node.js backend
                        let mut restart_node = false;
                        if let Some(ref mut child) = state.node {
                            match child.try_wait() {
                                Ok(Some(status)) => {
                                    eprintln!("[LumiOS] Node backend exited with status {:?}", status.code());
                                    restart_node = true;
                                }
                                Ok(None) => { /* still running */ }
                                Err(e) => {
                                    eprintln!("[LumiOS] Node backend health check failed: {}", e);
                                    restart_node = true;
                                }
                            }
                        }
                        if restart_node && state.node_restarts < max_restarts {
                            if let Some(ref cfg) = state.node_config {
                                eprintln!("[LumiOS] Restarting Node backend (attempt {}/{})", state.node_restarts + 1, max_restarts);
                                match Command::new(&cfg.exe)
                                    .arg(&cfg.entry)
                                    .env("LUMI_DESKTOP", "1")
                                    .env("HOST", "127.0.0.1")
                                    .current_dir(&cfg.work_dir)
                                    .spawn()
                                {
                                    Ok(child) => {
                                        println!("[LumiOS] Backend restarted, PID: {}", child.id());
                                        state.node = Some(child);
                                        state.node_restarts += 1;
                                    }
                                    Err(e) => {
                                        eprintln!("[LumiOS] Failed to restart Node backend: {}", e);
                                    }
                                }
                            }
                        } else if restart_node {
                            eprintln!("[LumiOS] Node backend max restarts ({}) reached, giving up", max_restarts);
                            state.node = None;
                        }

                        // Check GPT-SoVITS Python API
                        let mut restart_python = false;
                        if let Some(ref mut child) = state.python {
                            match child.try_wait() {
                                Ok(Some(status)) => {
                                    eprintln!("[LumiOS] Python API exited with status {:?}", status.code());
                                    restart_python = true;
                                }
                                Ok(None) => { /* still running */ }
                                Err(e) => {
                                    eprintln!("[LumiOS] Python API health check failed: {}", e);
                                    restart_python = true;
                                }
                            }
                        }
                        if restart_python && state.python_restarts < max_restarts {
                            if let Some(ref cfg) = state.python_config {
                                eprintln!("[LumiOS] Restarting Python API (attempt {}/{})", state.python_restarts + 1, max_restarts);
                                match Command::new(&cfg.exe)
                                    .arg(&cfg.entry)
                                    .arg("-a").arg("127.0.0.1")
                                    .arg("-p").arg("9880")
                                    .arg("-c").arg("GPT_SoVITS/configs/tts_infer.yaml")
                                    .current_dir(&cfg.work_dir)
                                    .spawn()
                                {
                                    Ok(child) => {
                                        println!("[LumiOS] Python API restarted, PID: {}", child.id());
                                        state.python = Some(child);
                                        state.python_restarts += 1;
                                    }
                                    Err(e) => {
                                        eprintln!("[LumiOS] Failed to restart Python API: {}", e);
                                    }
                                }
                            }
                        } else if restart_python {
                            eprintln!("[LumiOS] Python API max restarts ({}) reached, giving up", max_restarts);
                            state.python = None;
                        }
                    }
                });
            }

            // Register Alt+Space global shortcut (hide/show window)
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            let window = app.get_webview_window("main").unwrap();
            let reg = app.global_shortcut();
            let _ = reg.on_shortcut("Alt+Space", move |_app, _shortcut, _event| {
                if window.is_visible().unwrap_or(true) {
                    let _ = window.hide();
                } else {
                    let _ = window.show();
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Lumi OS")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<Mutex<BackendProcesses>>();
                let mut procs = state.lock().unwrap();
                if let Some(child) = procs.node.as_mut() {
                    println!("[LumiOS] Stopping Node backend...");
                    let _ = child.kill();
                }
                if let Some(child) = procs.python.as_mut() {
                    println!("[LumiOS] Stopping GPT-SoVITS API...");
                    let _ = child.kill();
                }
            }
        });
}
