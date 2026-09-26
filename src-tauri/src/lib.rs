use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_updater::UpdaterExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[derive(Serialize, Deserialize, Clone, PartialEq)]
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

#[derive(Serialize, Deserialize, Default, Clone, PartialEq)]
struct AppConfig {
    hotkey: HotkeyConfig,
    window_x: Option<i32>,
    window_y: Option<i32>,
    monitor_x: Option<i32>,
    monitor_y: Option<i32>,
    /// Folder holding data.json when the user syncs it (e.g. a cloud drive);
    /// None means the app data dir.
    data_dir: Option<String>,
}

struct HotkeyState(Mutex<Shortcut>);

/// config.json, read once at startup and kept in memory; see load_config
/// and update_config.
struct ConfigState(Mutex<AppConfig>);

const TRAY_ID: &str = "main";
const AUTOSTART_FLAG: &str = "--autostart";
const DATA_FILE: &str = "data.json";

/// Set while a native dialog is open, so losing focus to it doesn't hide
/// the board (and the dialog with it).
static DIALOG_OPEN: AtomicBool = AtomicBool::new(false);

fn app_data_file(app: &tauri::AppHandle, name: &str) -> std::path::PathBuf {
    let dir = app.path().app_data_dir().expect("no app data dir");
    let _ = std::fs::create_dir_all(&dir);
    dir.join(name)
}

fn config_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    app_data_file(app, "config.json")
}

fn read_config_file(app: &tauri::AppHandle) -> AppConfig {
    std::fs::read_to_string(config_path(app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Current config, from memory. Showing and hiding the board read this, so
/// it shouldn't touch the disk.
fn load_config(app: &tauri::AppHandle) -> AppConfig {
    let state = app.state::<ConfigState>();
    let cfg = state.0.lock().unwrap_or_else(|e| e.into_inner());
    cfg.clone()
}

/// Applies a change and writes config.json only if something actually
/// changed (most hides leave the window where it was).
fn update_config(app: &tauri::AppHandle, change: impl FnOnce(&mut AppConfig)) {
    let state = app.state::<ConfigState>();
    let mut cfg = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let before = cfg.clone();
    change(&mut cfg);
    if *cfg != before {
        if let Ok(s) = serde_json::to_string_pretty(&*cfg) {
            let _ = std::fs::write(config_path(app), s);
        }
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

/// Chat apps that read Markdown, where * _ ~ ` | \ in a kaomoji get eaten.
const MARKDOWN_APPS: &[&str] = &[
    "discord.exe", "discordptb.exe", "discordcanary.exe", "vesktop.exe", "legcord.exe",
    "slack.exe", "ms-teams.exe", "teams.exe", "telegram.exe", "whatsapp.exe",
    "whatsapp.root.exe", "element.exe", "mattermost.exe", "revolt.exe", "zulip.exe",
];
/// The same apps open in a browser, recognized by the tab's window title.
const BROWSERS: &[&str] = &[
    "chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe",
    "vivaldi.exe", "arc.exe", "zen.exe", "librewolf.exe", "floorp.exe",
];
const MARKDOWN_SITES: &[&str] = &["Discord", "Slack", "Microsoft Teams", "Telegram", "WhatsApp", "Element", "Mattermost"];

/// Whether the board was last opened from one of those apps. Kept across
/// re-shows, where the "previous" app would be the board itself.
static FROM_MARKDOWN_APP: AtomicBool = AtomicBool::new(false);

/// The app that has focus right now: its exe name (lowercase) and window title.
#[cfg(windows)]
fn foreground_app() -> Option<(String, String)> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId};
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return None;
        }
        let mut title = [0u16; 512];
        let len = GetWindowTextW(hwnd, &mut title).max(0) as usize;
        let title = String::from_utf16_lossy(&title[..len]);

        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut path = [0u16; 1024];
        let mut size = path.len() as u32;
        let found = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(path.as_mut_ptr()), &mut size);
        let _ = CloseHandle(process);
        found.ok()?;
        let path = String::from_utf16_lossy(&path[..size as usize]);
        Some((path.rsplit('\\').next()?.to_lowercase(), title))
    }
}

#[cfg(not(windows))]
fn foreground_app() -> Option<(String, String)> {
    None
}

fn is_markdown_app(exe: &str, title: &str) -> bool {
    MARKDOWN_APPS.contains(&exe)
        || (BROWSERS.contains(&exe) && MARKDOWN_SITES.iter().any(|site| title.contains(site)))
}

fn show_window(window: &WebviewWindow) {
    if !window.is_visible().unwrap_or(false) {
        // Before the board takes focus, note where the user came from.
        let from_markdown = foreground_app().is_some_and(|(exe, title)| is_markdown_app(&exe, &title));
        FROM_MARKDOWN_APP.store(from_markdown, Ordering::SeqCst);
        if let Some(pos) = compute_show_position(window) {
            let _ = window.set_position(pos);
        }
    }
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    // Lets the frontend reset search/selection for a fresh peek.
    let _ = window.emit(
        "shown",
        serde_json::json!({ "fromMarkdownApp": FROM_MARKDOWN_APP.load(Ordering::SeqCst) }),
    );
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
        let monitor = window.current_monitor().ok().flatten().map(|m| *m.position());
        update_config(window.app_handle(), |cfg| {
            cfg.window_x = Some(pos.x);
            cfg.window_y = Some(pos.y);
            if let Some(mp) = monitor {
                cfg.monitor_x = Some(mp.x);
                cfg.monitor_y = Some(mp.y);
            }
        });
    }
    let _ = window.hide();
    // Lets the frontend reset to the default view while nobody's looking.
    let _ = window.emit("hidden", ());
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

// ---------- "Copied" HUD ----------

const HUD_LABEL: &str = "hud";
const HUD_MS: u64 = 1300;

/// Bumped on every HUD; a pending hide only fires if no newer HUD replaced it.
static HUD_GENERATION: AtomicU64 = AtomicU64::new(0);

/// A small window that confirms a copy or paste after the board hides.
/// Created once, hidden, so showing it later costs nothing.
/// Not click-through: tao does that with a layered window, which Windows
/// then never draws. It's only up for a second, and can't take focus.
fn create_hud(app: &tauri::AppHandle) -> tauri::Result<()> {
    tauri::WebviewWindowBuilder::new(app, HUD_LABEL, tauri::WebviewUrl::App("hud.html".into()))
        .title("kaomoji hud")
        .inner_size(420.0, 72.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .visible(false)
        .build()?;
    Ok(())
}

/// Shows and hides the HUD straight through Win32: tao's show() activates
/// the window, which would pull focus away from the app the user returned to.
#[cfg(windows)]
fn set_hud_visible(hwnd: isize, visible: bool) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_HIDE,
    };
    let hwnd = HWND(hwnd as *mut _);
    unsafe {
        if visible {
            let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
        } else {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
    }
}

#[tauri::command]
fn show_hud(app: tauri::AppHandle, label: String, text: String, dark: bool) {
    let (Some(hud), Some(main)) = (app.get_webview_window(HUD_LABEL), app.get_webview_window("main")) else {
        return;
    };
    // Bottom center of the monitor the board was on, just above the taskbar.
    if let Some(monitor) = main.current_monitor().ok().flatten() {
        let area = *monitor.work_area();
        let place = |hud: &WebviewWindow| {
            let size = hud.outer_size().unwrap_or_default();
            let x = area.position.x + (area.size.width as i32 - size.width as i32) / 2;
            let y = area.position.y + area.size.height as i32 - size.height as i32 - (40.0 * monitor.scale_factor()) as i32;
            let _ = hud.set_position(tauri::PhysicalPosition::new(x, y));
        };
        // Twice: moving onto a monitor with a different scale resizes it.
        place(&hud);
        place(&hud);
    }
    let _ = app.emit_to(HUD_LABEL, "hud", serde_json::json!({ "label": label, "text": text, "dark": dark }));

    #[cfg(windows)]
    if let Ok(hwnd) = hud.hwnd() {
        let hwnd = hwnd.0 as isize;
        let generation = HUD_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        std::thread::spawn(move || {
            // Give the page a moment to draw the new text before it appears.
            std::thread::sleep(std::time::Duration::from_millis(40));
            set_hud_visible(hwnd, true);
            std::thread::sleep(std::time::Duration::from_millis(HUD_MS));
            if HUD_GENERATION.load(Ordering::SeqCst) == generation {
                set_hud_visible(hwnd, false);
            }
        });
    }
}

/// Where data.json lives: the chosen sync folder, or the app data dir.
/// A sync folder that has gone missing (drive offline, folder deleted) is an
/// error rather than a silent fallback, so nothing starts over from empty.
fn data_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    match load_config(app).data_dir {
        Some(dir) => {
            let dir = PathBuf::from(dir);
            if dir.is_dir() {
                Ok(dir.join(DATA_FILE))
            } else {
                Err(format!("Sync folder not found: {}", dir.display()))
            }
        }
        None => Ok(app_data_file(app, DATA_FILE)),
    }
}

/// Ok(None) means no file yet; Err means it exists but couldn't be read, so
/// the frontend must not overwrite it.
fn read_data_file(path: &PathBuf) -> Result<Option<serde_json::Value>, String> {
    match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s)
            .map(Some)
            .map_err(|e| format!("{} is unreadable: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// User data (favorites, custom kaomoji, usage, prefs) lives in data.json,
/// not in WebView storage. The frontend owns the schema.
#[tauri::command]
fn load_data(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    read_data_file(&data_file(&app)?)
}

#[tauri::command]
fn save_data(app: tauri::AppHandle, data: serde_json::Value) -> Result<(), String> {
    let path = data_file(&app)?;
    let tmp = path.with_extension("json.tmp");
    let s = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, s).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

/// Asks GitHub releases (see plugins.updater in tauri.conf.json) whether a
/// newer signed build exists.
#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    Ok(update.map(|u| UpdateInfo { version: u.version.clone(), notes: u.body.clone() }))
}

/// Downloads and verifies the update against the bundled public key, then
/// runs the installer. On Windows the installer closes and relaunches the app.
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Err("Already up to date".into());
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}

/// Opens a folder picker; None if the user cancels. Async so the blocking
/// dialog runs off the main thread.
#[tauri::command]
async fn pick_data_folder(window: WebviewWindow) -> Option<String> {
    DIALOG_OPEN.store(true, Ordering::SeqCst);
    let picked = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Choose a folder to keep your kaomoji data in")
        .blocking_pick_folder();
    DIALOG_OPEN.store(false, Ordering::SeqCst);
    picked.and_then(|p| p.into_path().ok()).map(|p| p.display().to_string())
}

/// Switches where data.json lives (None = back to the app data dir) and
/// returns whatever data is already there so the frontend can merge it with
/// what it has, rather than either side overwriting the other.
#[tauri::command]
fn set_data_dir(app: tauri::AppHandle, dir: Option<String>) -> Result<Option<serde_json::Value>, String> {
    let target = match &dir {
        Some(d) => {
            let folder = PathBuf::from(d);
            if !folder.is_dir() {
                return Err("That folder doesn't exist".into());
            }
            let probe = folder.join(".kaomoji-write-test");
            std::fs::write(&probe, b"ok").map_err(|e| format!("Can't write to that folder: {e}"))?;
            let _ = std::fs::remove_file(&probe);
            folder.join(DATA_FILE)
        }
        None => app_data_file(&app, DATA_FILE),
    };
    let existing = read_data_file(&target)?;
    update_config(&app, move |cfg| cfg.data_dir = dir);
    Ok(existing)
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
    let default_dir = app.path().app_data_dir().map(|p| p.display().to_string()).ok();
    serde_json::json!({
        "hotkey": cfg.hotkey,
        "autostart": autostart_enabled,
        "dataDir": cfg.data_dir,
        "defaultDataDir": default_dir,
        "version": app.package_info().version.to_string(),
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
    update_config(&app, move |cfg| cfg.hotkey = hotkey);

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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            pick_data_folder,
            set_data_dir,
            check_update,
            install_update,
            get_settings,
            set_autostart,
            set_hotkey,
            pause_hotkey,
            resume_hotkey,
            show_hud
        ])
        .setup(|app| {
            let handle = app.handle();
            app.manage(ConfigState(Mutex::new(read_config_file(handle))));
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

            if let Err(e) = create_hud(handle) {
                eprintln!("could not create the HUD window: {e}");
            }

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
                            if !window_clone.is_focused().unwrap_or(false)
                                && !DIALOG_OPEN.load(Ordering::SeqCst)
                            {
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
