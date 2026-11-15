#[cfg(target_os = "linux")]
fn launch_context(window: &tauri::WebviewWindow) -> Result<gtk::gdk::AppLaunchContext, String> {
    use gtk::prelude::*;

    let parent = window.gtk_window().map_err(|e| e.to_string())?;
    let context = parent
        .display()
        .app_launch_context()
        .ok_or("Application launch context unavailable")?;
    context.set_timestamp(gtk::current_event_time());
    Ok(context)
}

#[cfg(target_os = "linux")]
pub fn activation_token(window: &tauri::WebviewWindow, program: &str) -> Result<String, String> {
    use gtk::gio::prelude::*;

    let context = launch_context(window)?;
    let info = gtk::gio::AppInfo::create_from_commandline(
        gtk::glib::shell_quote(program),
        None,
        gtk::gio::AppInfoCreateFlags::NONE,
    )
    .map_err(|e| e.to_string())?;
    context
        .startup_notify_id(&info, &[])
        .map(|token| token.to_string())
        .ok_or("Activation token unavailable".into())
}

#[tauri::command]
pub async fn open_external(window: tauri::WebviewWindow, url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err("Unsupported external URL scheme".into());
    }
    #[cfg(target_os = "linux")]
    {
        let (send, mut receive) = tauri::async_runtime::channel(1);
        let parent = window.clone();
        // GDK must request activation using the window's display and input serial on the UI thread.
        window
            .run_on_main_thread(move || {
                let result = (|| {
                    let context = launch_context(&parent)?;
                    gtk::gio::AppInfo::launch_default_for_uri(&url, Some(&context))
                        .map_err(|e| e.to_string())
                })();
                let _ = send.try_send(result);
            })
            .map_err(|e| e.to_string())?;
        receive.recv().await.ok_or("URL launch interrupted")?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = window;
        tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
    }
}
