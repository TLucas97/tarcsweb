#[cfg(target_os = "linux")]
pub struct ClipboardImage;

#[cfg(target_os = "linux")]
impl ClipboardImage {
    pub fn read_png(done: impl FnOnce(Result<Vec<u8>, String>) + 'static) {
        // Match the largest attachment limit; attach.ts still owns image resizing.
        const MAX_BYTES: usize = 20_000_000;
        gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD).request_image(move |_, image| {
            let result = image.map_or_else(
                || Ok(Vec::new()),
                |image| {
                    let png = image
                        .save_to_bufferv("png", &[])
                        .map_err(|e| e.to_string())?;
                    if png.len() > MAX_BYTES {
                        return Err("Clipboard image exceeds 20 MB".into());
                    }
                    Ok(png)
                },
            );
            done(result);
        });
    }
}

#[tauri::command]
pub async fn read_clipboard_image(app: tauri::AppHandle) -> Result<tauri::ipc::Response, String> {
    #[cfg(target_os = "linux")]
    {
        let (send, mut receive) = tauri::async_runtime::channel(1);
        app.run_on_main_thread(move || {
            ClipboardImage::read_png(move |result| {
                let _ = send.try_send(result);
            });
        })
        .map_err(|e| e.to_string())?;
        receive
            .recv()
            .await
            .ok_or("Clipboard read interrupted")?
            .map(tauri::ipc::Response::new)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        Ok(tauri::ipc::Response::new(Vec::<u8>::new()))
    }
}
