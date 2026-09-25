use std::str::FromStr;
use std::sync::Mutex;

use enigo::{Direction, Enigo, Key, Keyboard, Settings as EnigoSettings};
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, WebviewWindow,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[derive(Serialize, Deserialize, Clone)]
struct HotkeyConfig {
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
    code: String,
    label: String,
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        HotkeyConfig {
            ctrl: true,
            alt: true,
            shift: false,
            meta: false,
            code: "KeyK".into(),
            label: "Ctrl+Alt+K".into(),
        }
    }
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct AppConfig {
    hotkey: HotkeyConfig,
    window_x: Option<i32>,
    window_y: Option<i32>,
    monitor_x: Option<i32>,
    monitor_y: Option<i32>,
}

struct HotkeyState(Mutex<Shortcut>);

const TRAY_ID: &str = "main";
const AUTOSTART_FLAG: &str = "--autostart";

fn app_data_file(app: &tauri::AppHandle, name: &str) -> std::path::PathBuf {
    let dir = app.path().app_data_dir().expect("no app data dir");
    let _ = std::fs::create_dir_all(&dir);
    dir.join(name)
}

fn config_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    app_data_file(app, "config.json")
}

fn load_config(app: &tauri::AppHandle) -> AppConfig {
    let path = config_path(app);
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_config(app: &tauri::AppHandle, cfg: &AppConfig) {
    let path = config_path(app);
    if let Ok(s) = serde_json::to_string_pretty(cfg) {
        let _ = std::fs::write(path, s);
    }
}

fn build_shortcut(cfg: &HotkeyConfig) -> Result<Shortcut, String> {
    let code = Code::from_str(&cfg.code).map_err(|_| format!("unsupported key: {}", cfg.code))?;
    let mut mods = Modifiers::empty();
    if cfg.ctrl {
        mods |= Modifiers::CONTROL;
    }
    if cfg.alt {
        mods |= Modifiers::ALT;
    }
    if cfg.shift {
        mods |= Modifiers::SHIFT;
    }
    if cfg.meta {
        mods |= Modifiers::META;
    }
    let mods = if mods.is_empty() { None } else { Some(mods) };
    Ok(Shortcut::new(mods, code))
}

/// Where to place the window when it's about to be shown: prefer the
/// monitor the mouse cursor is currently on. If the last dragged position
/// was on that same monitor, restore it exactly; otherwise center on it.
fn compute_show_position(window: &WebviewWindow) -> Option<tauri::PhysicalPosition<i32>> {
    let cursor = window.cursor_position().ok()?;
    let monitors = window.available_monitors().ok()?;
    let target = monitors.into_iter().find(|m| {
        let pos = m.position();
        let size = m.size();
        let (cx, cy) = (cursor.x as i32, cursor.y as i32);
        cx >= pos.x && cx < pos.x + size.width as i32 && cy >= pos.y && cy < pos.y + size.height as i32
    })?;

    let cfg = load_config(window.app_handle());
    let win_size = window.outer_size().ok()?;
    let mp = target.position();
    let ms = target.size();

    if let (Some(x), Some(y), Some(mx), Some(my)) =
        (cfg.window_x, cfg.window_y, cfg.monitor_x, cfg.monitor_y)
    {
        if mx == mp.x && my == mp.y {
            return Some(tauri::PhysicalPosition::new(x, y));
        }
    }

    let cx = mp.x + (ms.width as i32 - win_size.width as i32) / 2;
    let cy = mp.y + (ms.height as i32 - win_size.height as i32) / 2;
    Some(tauri::PhysicalPosition::new(cx, cy))
}

fn show_window(window: &WebviewWindow) {
    if !window.is_visible().unwrap_or(false) {
        if let Some(pos) = compute_show_position(window) {
            let _ = window.set_position(pos);
        }
    }
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    // Lets the frontend reset search/selection for a fresh peek.
    let _ = window.emit("shown", ());
}

fn toggle_window(window: &WebviewWindow) {
    if window.is_visible().unwrap_or(false) {
        hide_and_save(window);
    } else {
        show_window(window);
    }
}

fn hide_and_save(window: &WebviewWindow) {
    if let Ok(pos) = window.outer_position() {
        let app = window.app_handle();
        let mut cfg = load_config(app);
        cfg.window_x = Some(pos.x);
        cfg.window_y = Some(pos.y);
        if let Ok(Some(monitor)) = window.current_monitor() {
            let mp = monitor.position();
            cfg.monitor_x = Some(mp.x);
            cfg.monitor_y = Some(mp.y);
        }
        save_config(app, &cfg);
    }
    let _ = window.hide();
}

#[tauri::command]
fn hide_window(window: WebviewWindow) {
    hide_and_save(&window);
}

/// Copies `text`, hides the board so focus returns to the previous app,
/// sends Ctrl+V there, then puts the user's previous clipboard text back.
#[tauri::command]
fn paste_kaomoji(app: tauri::AppHandle, window: WebviewWindow, text: String) -> Result<(), String> {
    let previous = app.clipboard().read_text().ok();
    app.clipboard().write_text(text).map_err(|e| e.to_string())?;
    hide_and_save(&window);

    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(120));
        if let Ok(mut enigo) = Enigo::new(&EnigoSettings::default()) {
            let _ = enigo.key(Key::Control, Direction::Press);
            let _ = enigo.key(Key::Unicode('v'), Direction::Click);
            let _ = enigo.key(Key::Control, Direction::Release);
        }
        // Some apps read the clipboard asynchronously after Ctrl+V, so give
        // them a moment before restoring.
        if let Some(previous) = previous {
            std::thread::sleep(std::time::Duration::from_millis(600));
            let _ = app.clipboard().write_text(previous);
        }
    });
    Ok(())
}

/// User data (favorites, custom kaomoji, usage, prefs) lives in data.json
/// next to config.json, not in WebView storage. The frontend owns the schema.
/// Ok(None) means no file yet; Err means it exists but couldn't be read, so
/// the frontend must not overwrite it.
#[tauri::command]
fn load_data(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = app_data_file(&app, "data.json");
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s)
            .map(Some)
            .map_err(|e| format!("data.json is unreadable: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn save_data(app: tauri::AppHandle, data: serde_json::Value) -> Result<(), String> {
    let path = app_data_file(&app, "data.json");
    let tmp = path.with_extension("json.tmp");
    let s = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, s).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Unregisters the global hotkey while the settings panel records a new one,
/// so pressing the current combo doesn't toggle the window mid-recording.
#[tauri::command]
fn pause_hotkey(app: tauri::AppHandle, state: tauri::State<HotkeyState>) {
    if let Ok(current) = state.0.lock() {
        let _ = app.global_shortcut().unregister(*current);
    }
}

#[tauri::command]
fn resume_hotkey(app: tauri::AppHandle, state: tauri::State<HotkeyState>) {
    if let Ok(current) = state.0.lock() {
        // Errors if it's still registered, which is fine.
        let _ = app.global_shortcut().register(*current);
    }
}

fn update_tray_tooltip(app: &tauri::AppHandle, label: &str) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(format!("kaomoji board  ·  {label}")));
    }
}

#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> serde_json::Value {
    let cfg = load_config(&app);
    let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
    serde_json::json!({
        "hotkey": cfg.hotkey,
        "autostart": autostart_enabled,
    })
}

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    result.map_err(|e| e.to_string())
}

#[tauri::command]
fn set_hotkey(
    app: tauri::AppHandle,
    state: tauri::State<HotkeyState>,
    hotkey: HotkeyConfig,
) -> Result<(), String> {
    let new_shortcut = build_shortcut(&hotkey)?;

    let mut current = state.0.lock().map_err(|_| "lock poisoned".to_string())?;
    let shortcuts = app.global_shortcut();

    let _ = shortcuts.unregister(*current);
    if let Err(e) = shortcuts.register(new_shortcut) {
        let _ = shortcuts.register(*current);
        return Err(format!("could not register that combo: {e}"));
    }
    *current = new_shortcut;
    drop(current);

    update_tray_tooltip(&app, &hotkey.label);
    let mut cfg = load_config(&app);
    cfg.hotkey = hotkey;
    save_config(&app, &cfg);

    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        // Must be first: a second launch (e.g. Start Menu while autostart
        // already has one running) just surfaces the existing board.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                show_window(&window);
            }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_FLAG]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    let state = app.state::<HotkeyState>();
                    let is_match = state.0.lock().map(|s| &*s == shortcut).unwrap_or(false);
                    if is_match {
                        if let Some(window) = app.get_webview_window("main") {
                            toggle_window(&window);
                        }
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            hide_window,
            paste_kaomoji,
            load_data,
            save_data,
            get_settings,
            set_autostart,
            set_hotkey,
            pause_hotkey,
            resume_hotkey
        ])
        .setup(|app| {
            let handle = app.handle();
            let cfg = load_config(handle);

            let initial_shortcut = build_shortcut(&cfg.hotkey).unwrap_or_else(|_| {
                build_shortcut(&HotkeyConfig::default()).expect("default hotkey is valid")
            });
            app.manage(HotkeyState(Mutex::new(initial_shortcut)));

            if let Err(e) = handle.global_shortcut().register(initial_shortcut) {
                eprintln!("could not register global hotkey: {e}");
            }

            let show_i = MenuItem::with_id(app, "show", "Show board", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::with_id(TRAY_ID)
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip(format!("kaomoji board  ·  {}", cfg.hotkey.label))
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            show_window(&window);
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            toggle_window(&window);
                        }
                    }
                })
                .build(app)?;

            if let Some(window) = app.get_webview_window("main") {
                if let (Some(x), Some(y)) = (cfg.window_x, cfg.window_y) {
                    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
                }

                // Stay hidden in the tray at login; show the board when the
                // user launches it themselves.
                if !std::env::args().any(|a| a == AUTOSTART_FLAG) {
                    show_window(&window);
                }

                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        hide_and_save(&window_clone);
                    }
                    if let tauri::WindowEvent::Focused(false) = event {
                        // Dragging the window via the title bar causes a brief,
                        // spurious focus-loss event in the webview. Re-check
                        // after a short delay so a real drag isn't mistaken
                        // for clicking away.
                        let window_clone = window_clone.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(250));
                            if !window_clone.is_focused().unwrap_or(false) {
                                hide_and_save(&window_clone);
                            }
                        });
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running kaomoji board");
}
