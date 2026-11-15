#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod clipboard;
mod external;
mod media;
mod motor;
mod process;
mod shell;
mod update;

use shell::Shell;
use std::{fs, sync::atomic::Ordering};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Manager, WebviewUrl, WebviewWindowBuilder,
};

fn main() {
    #[cfg(target_os = "linux")]
    if (std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE").is_ok_and(|s| s == "wayland"))
        && (std::path::Path::new("/proc/driver/nvidia/version").exists()
            || std::path::Path::new("/sys/module/nvidia").exists())
        && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
        && std::env::var("TARCSWEB_WEBKIT_DMABUF").as_deref() != Ok("1")
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let app = app.clone();
            std::thread::spawn(move || {
                if let Some(shell) = app.try_state::<Shell>() {
                    let _ = shell.open(&app, None, None, true);
                }
            });
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            clipboard::read_clipboard_image,
            external::open_external,
            shell::shell_info,
            update::desktop_info,
            update::update_status,
            update::rebuild,
            update::check_update,
            update::install_update,
            update::prepare_restart,
            shell::notify_session,
            shell::apply_open_mode,
            shell::startup_status,
            shell::retry_startup,
            shell::quit
        ])
        .setup(|app| {
            app.manage(update::Updates::default());
            if update::SOURCE_DIR.is_none() {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            let motor = motor::Motor::select(&app.path().app_data_dir()?)?;
            let auto_media = !(cfg!(windows) && motor.attached);
            let mut bytes = [0u8; 32];
            getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
            let log_dir = app.path().app_log_dir()?;
            fs::create_dir_all(&log_dir)?;
            let notification_icon = if cfg!(target_os = "linux") {
                let cache = app.path().app_cache_dir()?;
                fs::create_dir_all(&cache)?;
                let path = cache.join("notification-icon.png");
                fs::write(&path, include_bytes!("../icons/128x128.png"))?;
                Some(path)
            } else {
                None
            };
            let shell = Shell::new(
                motor,
                bytes.iter().map(|b| format!("{b:02x}")).collect(),
                log_dir.join("server.log"),
                notification_icon,
            );
            let origin = shell.origin();
            app.manage(shell);
            let navigation_app = app.handle().clone();
            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("index.html".into()),
            )
            .title("tarcsweb")
            .inner_size(1200.0, 820.0)
            .disable_drag_drop_handler()
            .devtools(cfg!(debug_assertions))
            .on_navigation(move |url| {
                url.origin().ascii_serialization() == navigation_app.state::<Shell>().origin()
                            || url.scheme() == "tauri"
                            || url.host_str() == Some("tauri.localhost")
                            // WebKitGTK also filters sandboxed srcdoc frame navigations here.
                            || (cfg!(target_os = "linux") && url.as_str() == "about:srcdoc")
            })
            .build()?;
            if auto_media {
                media::install(&window, origin)?;
            }
            let open = MenuItem::with_id(app, "open", "Open tarcsweb", true, None::<&str>)?;
            let desktop =
                MenuItem::with_id(app, "desktop", "Open in desktop window", true, None::<&str>)?;
            let chrome = MenuItem::with_id(app, "chrome", "Open in Chrome", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("CmdOrCtrl+Q"))?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&open, &desktop, &chrome, &separator, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .tooltip("tarcsweb")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    let app = app.clone();
                    match event.id.as_ref() {
                        "quit" => Shell::quit(app),
                        id => {
                            let mode = match id {
                                "desktop" => Some("desktop"),
                                "chrome" => Some("chrome-app"),
                                _ => None,
                            };
                            std::thread::spawn(move || {
                                let _ = app.state::<Shell>().open(&app, mode, None, true);
                            });
                        }
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            if Shell::tray_available() {
                match tray.build(app) {
                    Ok(_) => app.state::<Shell>().tray.store(true, Ordering::Release),
                    Err(error) => app
                        .state::<Shell>()
                        .log(&format!("Tray unavailable: {error}")),
                }
            } else {
                app.state::<Shell>()
                    .log("Tray unavailable: no appindicator library");
            }
            Shell::start(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.state::<Shell>().tray.load(Ordering::Acquire) {
                    let _ = window.hide();
                } else {
                    Shell::quit(window.app_handle().clone());
                }
            }
        });
    match builder.build(tauri::generate_context!()) {
        Ok(app) => app.run(|app, event| match event {
            tauri::RunEvent::ExitRequested { api, .. }
                if !app.state::<Shell>().exited.load(Ordering::Acquire) =>
            {
                api.prevent_exit();
                Shell::quit(app.clone());
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                let _ = app.state::<Shell>().show(app, None);
            }
            _ => {}
        }),
        Err(error) => eprintln!("Could not launch tarcsweb: {error}"),
    }
}
