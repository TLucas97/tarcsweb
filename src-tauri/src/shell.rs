use crate::process::ProcessTree;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU16, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
#[cfg(any(target_os = "linux", windows))]
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

pub struct Shell {
    motor: Mutex<crate::motor::Motor>,
    port: AtomicU16,
    token: String,
    child: Mutex<Option<ProcessTree>>,
    logs: Mutex<VecDeque<String>>,
    log_path: PathBuf,
    notification_icon: Option<PathBuf>,
    #[cfg(target_os = "linux")]
    notifications: Mutex<std::collections::HashMap<String, (u32, String)>>,
    error: Mutex<Option<String>>,
    starting: AtomicBool,
    // Set when our own child logs that it listens on the port, so the token never goes to another process.
    listening: AtomicBool,
    ready: AtomicBool,
    pub tray: AtomicBool,
    quitting: AtomicBool,
    pub exited: AtomicBool,
}

impl Shell {
    pub fn tray_available() -> bool {
        #[cfg(target_os = "linux")]
        {
            [c"libayatana-appindicator3.so.1", c"libappindicator3.so.1"]
                .iter()
                .any(|name| {
                    // SAFETY: probe the same libraries as tray-icon, then release the probe handle.
                    unsafe {
                        let handle = libc::dlopen(name.as_ptr(), libc::RTLD_LAZY);
                        if handle.is_null() {
                            false
                        } else {
                            libc::dlclose(handle);
                            true
                        }
                    }
                })
        }
        #[cfg(not(target_os = "linux"))]
        {
            true
        }
    }

    pub fn new(
        motor: crate::motor::Motor,
        token: String,
        log_path: PathBuf,
        notification_icon: Option<PathBuf>,
    ) -> Self {
        Self {
            port: AtomicU16::new(motor.port),
            motor: Mutex::new(motor),
            token,
            log_path,
            notification_icon,
            #[cfg(target_os = "linux")]
            notifications: Mutex::new(std::collections::HashMap::new()),
            child: Mutex::new(None),
            logs: Mutex::new(VecDeque::new()),
            error: Mutex::new(None),
            starting: AtomicBool::new(false),
            listening: AtomicBool::new(false),
            ready: AtomicBool::new(false),
            tray: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
            exited: AtomicBool::new(false),
        }
    }

    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port.load(Ordering::Acquire))
    }

    pub fn log(&self, line: &str) {
        if let Ok(mut logs) = self.logs.lock() {
            logs.push_back(line.chars().take(4096).collect());
            if logs.len() > 60 {
                logs.pop_front();
            }
        }
        if fs::metadata(&self.log_path).is_ok_and(|m| m.len() > 2 * 1024 * 1024) {
            let _ = fs::rename(&self.log_path, self.log_path.with_extension("previous.log"));
        }
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log_path)
        {
            let _ = writeln!(file, "{line}");
        }
    }

    pub(crate) fn request(&self, path: &str, body: Option<Value>) -> Result<Value, String> {
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .map_err(|e| e.to_string())?;
        let url = format!("{}{path}", self.origin());
        let request = if let Some(body) = body {
            client.post(url).json(&body)
        } else {
            client.get(url)
        };
        let response = request
            .bearer_auth(&self.token)
            .send()
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("{path}: HTTP {}", response.status()));
        }
        if path == "/api/quit" {
            return Ok(Value::Null);
        }
        response.json().map_err(|e| e.to_string())
    }

    pub fn show(&self, app: &tauri::AppHandle, path: Option<&str>) -> Result<(), String> {
        self.show_window(app, path, true)
    }

    #[cfg(any(target_os = "linux", windows))]
    fn open_notification(&self, app: &tauri::AppHandle, session_id: &str) {
        if let Err(error) = self.show(app, None).and_then(|()| {
            app.emit_to("main", "open-session", session_id)
                .map_err(|e| e.to_string())
        }) {
            self.log(&format!("Could not open notification session: {error}"));
        }
    }

    #[cfg(target_os = "linux")]
    fn notify_session(
        &self,
        app: &tauri::AppHandle,
        title: &str,
        body: &str,
        tag: String,
        session_id: String,
    ) -> Result<(), String> {
        let mut notices = self.notifications.lock().map_err(|e| e.to_string())?;
        let previous = notices.get(&tag).map(|(id, _)| *id);
        let mut notification = notify_rust::Notification::new();
        notification
            .appname("tarcsweb")
            .summary(title)
            .body(body)
            .action("default", "Open session");
        if let Some(icon) = &self.notification_icon {
            notification.icon(&icon.to_string_lossy());
        }
        if let Some(id) = previous {
            notification.id(id);
        }
        let handle = notification.show().map_err(|e| e.to_string())?;
        let id = handle.id();
        notices.insert(tag.clone(), (id, session_id));
        drop(notices);
        let app = app.clone();
        std::thread::spawn(move || {
            handle.wait_for_action(|action| {
                let shell = app.state::<Shell>();
                // Multiple listeners for a replaced ID must open only its latest session once.
                let session = shell.notifications.lock().ok().and_then(|mut notices| {
                    if notices.get(&tag).is_some_and(|(current, _)| *current == id) {
                        notices.remove(&tag).map(|(_, session)| session)
                    } else {
                        None
                    }
                });
                if let Some(session) = session.filter(|_| action == "default") {
                    shell.open_notification(&app, &session);
                }
            });
        });
        Ok(())
    }

    fn show_window(
        &self,
        app: &tauri::AppHandle,
        path: Option<&str>,
        focus: bool,
    ) -> Result<(), String> {
        let window = app
            .get_webview_window("main")
            .ok_or("desktop window missing")?;
        if self.ready.load(Ordering::Acquire) {
            if let Some(path) = path {
                if !path.starts_with('/') || path.starts_with("//") {
                    return Err("invalid local path".into());
                }
                let url = tauri::Url::parse(&format!("{}{path}", self.origin()))
                    .map_err(|e| e.to_string())?;
                if url.origin().ascii_serialization() != self.origin() {
                    return Err("invalid local origin".into());
                }
                window.navigate(url).map_err(|e| e.to_string())?;
            } else if window
                .url()
                .map_err(|e| e.to_string())?
                .origin()
                .ascii_serialization()
                != self.origin()
            {
                window
                    .navigate(tauri::Url::parse(&self.origin()).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            }
        }
        window.show().map_err(|e| e.to_string())?;
        if focus {
            let _ = window.unminimize();
            window.set_focus().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    #[cfg(windows)]
    fn notify_session(
        &self,
        app: &tauri::AppHandle,
        title: &str,
        body: &str,
        tag: String,
        session_id: String,
    ) -> Result<(), String> {
        use std::hash::{Hash, Hasher};
        use windows::{
            core::{h, IInspectable, HSTRING},
            Data::Xml::Dom::XmlDocument,
            Foundation::TypedEventHandler,
            UI::Notifications::{ToastNotification, ToastNotificationManager},
        };
        let exe = tauri::utils::platform::current_exe().map_err(|e| e.to_string())?;
        let directory = exe.parent().ok_or("executable directory missing")?;
        // Match the plugin's identity for unpackaged development executables.
        let development =
            directory.ends_with("target/debug") || directory.ends_with("target/release");
        let app_id = if development {
            HSTRING::from(
                "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe",
            )
        } else {
            HSTRING::from(app.config().identifier.as_str())
        };
        // Windows limits tag length, while session and agent tags can be longer.
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        tag.hash(&mut hash);
        let tag = HSTRING::from(format!("{:016x}", hash.finish()));
        let handle = app.clone();
        let result = (|| -> windows::core::Result<()> {
            let xml = XmlDocument::new()?;
            xml.LoadXml(h!("<toast><visual><binding template=\"ToastGeneric\"><text/><text/></binding></visual></toast>"))?;
            let text = xml.GetElementsByTagName(h!("text"))?;
            text.Item(0)?.SetInnerText(&HSTRING::from(title))?;
            text.Item(1)?.SetInnerText(&HSTRING::from(body))?;
            let toast = ToastNotification::CreateToastNotification(&xml)?;
            toast.SetTag(&tag)?;
            toast.SetGroup(h!("tarcsweb"))?;
            toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(
                move |_, _| {
                    let app = handle.clone();
                    let session_id = session_id.clone();
                    std::thread::spawn(move || {
                        app.state::<Shell>().open_notification(&app, &session_id)
                    });
                    Ok(())
                },
            ))?;
            ToastNotificationManager::CreateToastNotifierWithId(&app_id)?.Show(&toast)
        })();
        result.map_err(|e| e.to_string())
    }

    pub fn open(
        &self,
        app: &tauri::AppHandle,
        mode: Option<&str>,
        path: Option<&str>,
        notify_error: bool,
    ) -> Result<(), String> {
        if !self.ready.load(Ordering::Acquire) {
            return self.show(app, None);
        }
        if self.motor.lock().map_err(|e| e.to_string())?.attached {
            return self.show(app, path);
        }
        let info = self.request("/api/shell", None)?;
        let mode = mode
            .or_else(|| info["openMode"].as_str())
            .unwrap_or("desktop");
        if mode == "desktop" {
            return self.show(app, path);
        }
        let mut body = json!({ "mode": mode });
        if let Some(path) = path {
            body["path"] = json!(path);
        }
        let error = match self.request("/api/shell/open", Some(body)) {
            Ok(value) => value["error"].as_str().map(str::to_owned),
            Err(error) => Some(error),
        };
        if let Some(error) = error {
            self.show(app, None)?;
            if notify_error {
                let _ = app
                    .notification()
                    .builder()
                    .title("tarcsweb")
                    .body(format!(
                        "Could not open Chrome: {error}. Opened the desktop window."
                    ))
                    .show();
            }
            return Err(error);
        }
        if self.tray.load(Ordering::Acquire) {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
        } else {
            // Without a tray, keep a visible way to quit the app.
            self.show_window(app, None, !cfg!(target_os = "linux"))?;
        }
        Ok(())
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn clean_appimage_env(command: &mut Command) -> Result<(), String> {
        let (Some(appimage), Some(appdir)) =
            (std::env::var_os("APPIMAGE"), std::env::var_os("APPDIR"))
        else {
            return Ok(());
        };
        if appimage.is_empty() || appdir.is_empty() {
            return Ok(());
        }
        let appdir = PathBuf::from(appdir);
        let gtk_plugin = std::env::var_os("GTK_DATA_PREFIX")
            .is_some_and(|prefix| PathBuf::from(prefix) == appdir);
        let plugin_theme = std::env::var_os("APPIMAGE_GTK_THEME").filter(|theme| !theme.is_empty());

        // Keep bundled libraries in WebKitGTK, but keep them out of the server's children.
        for (key, value) in std::env::vars_os() {
            if key == "APPIMAGE" {
                continue;
            }
            let remove = matches!(
                key.to_str(),
                Some(
                    "APPDIR"
                        | "OWD"
                        | "ARGV0"
                        | "PYTHONDONTWRITEBYTECODE"
                        | "GST_REGISTRY_REUSE_PLUGIN_SCANNER"
                )
            ) || (key == "GTK_THEME"
                && gtk_plugin
                && match &plugin_theme {
                    Some(theme) => value == *theme,
                    None => value == "Adwaita:dark" || value == "Adwaita:light",
                });
            if remove {
                command.env_remove(key);
                continue;
            }

            let mut paths: Vec<_> = std::env::split_paths(&value).collect();
            let count = paths.len();
            paths.retain(|path| !path.starts_with(&appdir));
            if paths.len() == count {
                continue;
            }
            if paths.iter().all(|path| path.as_os_str().is_empty()) {
                command.env_remove(key);
            } else {
                let filtered = std::env::join_paths(paths)
                    .map_err(|e| format!("Could not clean AppImage environment: {e}"))?;
                command.env(key, filtered);
            }
        }
        Ok(())
    }

    fn spawn_server(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let dev = cfg!(debug_assertions);
        let dir = if dev {
            std::env::var_os("TARCSWEB_APP_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .parent()
                        .expect("manifest has a parent")
                        .to_path_buf()
                })
        } else {
            app.path()
                .resource_dir()
                .map_err(|e| e.to_string())?
                .join("app")
        };
        let node = if dev {
            std::env::var_os("TARCSWEB_NODE").unwrap_or_else(|| "node".into())
        } else {
            std::env::current_exe()
                .map_err(|e| e.to_string())?
                // Its own name: a .deb puts sidecars in /usr/bin, where "node" belongs to the system.
                .with_file_name(if cfg!(windows) {
                    "tarcsweb-node.exe"
                } else {
                    "tarcsweb-node"
                })
                .into_os_string()
        };
        let mut command = Command::new(node);
        #[cfg(target_os = "linux")]
        Self::clean_appimage_env(&mut command)?;
        command
            .arg(dir.join("server/boot.ts"))
            .current_dir(&dir)
            .env("CW_SHELL", "tauri")
            .env("CW_LIVE", "1")
            .env("CW_SHELL_TOKEN", &self.token)
            .env("CW_PARENT_PID", std::process::id().to_string())
            .env("CW_PORT", self.port.load(Ordering::Acquire).to_string())
            .env(
                "CW_ORIGINS",
                format!(
                    "{},http://localhost:{}",
                    self.origin(),
                    self.port.load(Ordering::Acquire)
                ),
            )
            .env("CW_DIST", dir.join("dist"))
            .env("CW_APP_VERSION", app.package_info().version.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "linux")]
        command.env("CW_ACTIVATION_PIPE", "1").stdin(Stdio::piped());
        // Lets a Chrome window the server opens offer the same source rebuild as this window.
        if let Some(source) = crate::update::rebuild_source() {
            command.env("CW_REBUILD_SOURCE", source);
        }
        // The SDK finds claude in its platform package under resources, so CW_CLAUDE_BIN stays unset.
        #[cfg(windows)]
        if !dev {
            {
                let config = PathBuf::from(std::env::var_os("APPDATA").ok_or("APPDATA missing")?)
                    .join("tarcsweb");
                let cache =
                    PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA missing")?)
                        .join("tarcsweb");
                fs::create_dir_all(&config).map_err(|e| e.to_string())?;
                fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
                command
                    .env("CW_CONFIG", config.join("config.json"))
                    .env("CW_CACHE", cache);
            }
        }
        let mut owned = self.child.lock().map_err(|e| e.to_string())?;
        if self.quitting.load(Ordering::Acquire) {
            return Err("Application is quitting".into());
        }
        let mut tree =
            ProcessTree::spawn(&mut command).map_err(|e| format!("Could not start Node: {e}"))?;
        if let Some(stdout) = tree.child.stdout.take() {
            Self::read_pipe(app.clone(), stdout, true);
        }
        if let Some(stderr) = tree.child.stderr.take() {
            Self::read_pipe(app.clone(), stderr, false);
        }
        *owned = Some(tree);
        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn reply_activation(app: &tauri::AppHandle, id: String, program: String) {
        let handle = app.clone();
        let result = app.run_on_main_thread(move || {
            let shell = handle.state::<Shell>();
            let token = handle
                .get_webview_window("main")
                .ok_or("desktop window missing".to_owned())
                .and_then(|window| crate::external::activation_token(&window, &program));
            if let Err(error) = &token {
                shell.log(&format!("Could not request desktop activation: {error}"));
            }
            let reply = json!({ "type": "activation-token", "id": id, "token": token.ok() });
            if let Ok(mut child) = shell.child.lock() {
                if let Some(input) = child.as_mut().and_then(|tree| tree.child.stdin.as_mut()) {
                    if let Err(error) = writeln!(input, "{reply}") {
                        shell.log(&format!("Could not send desktop activation: {error}"));
                    }
                }
            };
        });
        if let Err(error) = result {
            app.state::<Shell>()
                .log(&format!("Could not schedule desktop activation: {error}"));
        }
    }

    fn read_pipe(app: tauri::AppHandle, pipe: impl Read + Send + 'static, commands: bool) {
        std::thread::spawn(move || {
            for line in BufReader::new(pipe).lines() {
                let Ok(line) = line else { break };
                let shell = app.state::<Shell>();
                if let Some(command) = commands
                    .then(|| line.strip_prefix("@@tarcsweb-shell "))
                    .flatten()
                {
                    if let Ok(value) = serde_json::from_str::<Value>(command) {
                        match value["cmd"].as_str() {
                            #[cfg(target_os = "linux")]
                            Some("activation-token") => {
                                if let (Some(id), Some(program)) =
                                    (value["id"].as_str(), value["program"].as_str())
                                {
                                    Self::reply_activation(&app, id.to_owned(), program.to_owned());
                                }
                            }
                            Some("show") => {
                                let _ = shell.show(&app, value["path"].as_str());
                            }
                            // From a Chrome window's Settings; status flows back through report().
                            Some("rebuild") => {
                                tauri::async_runtime::spawn(crate::update::rebuild(app.clone()));
                            }
                            Some("hide") if shell.tray.load(Ordering::Acquire) => {
                                if let Some(window) = app.get_webview_window("main") {
                                    let _ = window.hide();
                                }
                            }
                            _ => {}
                        }
                    }
                } else {
                    // The private repo logs "claude-web server on", the public one "tarcsweb server on".
                    let ready = format!(" server on {} ", shell.origin());
                    if commands
                        && ["claude-web", "tarcsweb"]
                            .iter()
                            .any(|name| line.starts_with(&format!("{name}{ready}")))
                    {
                        shell.listening.store(true, Ordering::Release);
                    }
                    shell.log(&line);
                }
            }
        });
    }

    pub fn start(app: tauri::AppHandle) {
        if app.state::<Shell>().starting.swap(true, Ordering::AcqRel) {
            return;
        }
        std::thread::spawn(move || {
            let shell = app.state::<Shell>();
            let result: Result<(), String> = (|| {
                if shell.quitting.load(Ordering::Acquire) {
                    return Err("Application is quitting".into());
                }
                *shell.error.lock().map_err(|e| e.to_string())? = None;
                if let Some(mut child) = shell.child.lock().map_err(|e| e.to_string())?.take() {
                    child.kill_tree();
                }
                shell.listening.store(false, Ordering::Release);
                let attached = {
                    let mut motor = shell.motor.lock().map_err(|e| e.to_string())?;
                    if motor.waiting_wsl {
                        *motor = crate::motor::Motor::select(
                            &app.path().app_data_dir().map_err(|e| e.to_string())?,
                        )?;
                        shell.port.store(motor.port, Ordering::Release);
                    }
                    shell.log(&motor.log);
                    if motor.waiting_wsl {
                        return Err("tarcsweb is not running in WSL".into());
                    }
                    motor.attached
                };
                let mut capability: Value =
                    serde_json::from_str(include_str!("../capabilities/app.json"))
                        .map_err(|e| e.to_string())?;
                capability["remote"]["urls"] = json!([format!("{}/*", shell.origin())]);
                app.add_capability(capability.to_string())
                    .map_err(|e| e.to_string())?;
                if attached {
                    shell.ready.store(true, Ordering::Release);
                    return shell.show(&app, None);
                }
                shell.spawn_server(&app)?;
                let start = Instant::now();
                loop {
                    if shell.quitting.load(Ordering::Acquire) {
                        return Err("Application is quitting".into());
                    }
                    if shell.listening.load(Ordering::Acquire) {
                        if let Ok(info) = shell.request("/api/shell", None) {
                            if info["app"] == "tarcsweb" {
                                break;
                            }
                        }
                    }
                    if let Some(child) = shell.child.lock().map_err(|e| e.to_string())?.as_mut() {
                        if let Some(status) = child.child.try_wait().map_err(|e| e.to_string())? {
                            return Err(format!("Node exited: {status}"));
                        }
                    }
                    if start.elapsed() >= Duration::from_secs(90) {
                        return Err("Server did not become ready within 90 seconds".into());
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
                shell.ready.store(true, Ordering::Release);
                // Any failure here still leaves the app on screen instead of the splash.
                shell.open(&app, None, None, true).or_else(|error| {
                    shell.log(&error);
                    shell.show(&app, None)
                })
            })();
            if let Err(error) = result {
                shell.log(&error);
                if let Ok(mut state) = shell.error.lock() {
                    *state = Some(error);
                }
                let _ = shell.show(&app, None);
            }
            shell.starting.store(false, Ordering::Release);
            while shell.ready.load(Ordering::Acquire) && !shell.quitting.load(Ordering::Acquire) {
                let stopped = shell.child.lock().is_ok_and(|mut owned| {
                    owned
                        .as_mut()
                        .is_some_and(|tree| tree.child.try_wait().ok().flatten().is_some())
                });
                if stopped {
                    Self::quit(app.clone());
                    break;
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        });
    }

    pub fn quit(app: tauri::AppHandle) {
        if app.state::<Shell>().quitting.swap(true, Ordering::AcqRel) {
            return;
        }
        std::thread::spawn(move || {
            let shell = app.state::<Shell>();
            shell.stop();
            app.exit(0);
        });
    }

    pub(crate) fn stop(&self) {
        self.quitting.store(true, Ordering::Release);
        if self.motor.lock().is_ok_and(|motor| !motor.attached) {
            let _ = self.request("/api/quit", Some(json!({})));
        }
        if let Ok(mut owned) = self.child.lock() {
            if let Some(mut tree) = owned.take() {
                tree.shutdown();
            }
        }
        self.exited.store(true, Ordering::Release);
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn resume(&self, app: tauri::AppHandle) {
        self.quitting.store(false, Ordering::Release);
        self.exited.store(false, Ordering::Release);
        self.ready.store(false, Ordering::Release);
        Self::start(app);
    }
}

#[tauri::command]
pub async fn notify_session(
    app: tauri::AppHandle,
    title: String,
    body: String,
    tag: String,
    session_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shell = app.state::<Shell>();
        #[cfg(any(target_os = "linux", windows))]
        return shell.notify_session(&app, &title, &body, tag, session_id);
        #[cfg(not(any(target_os = "linux", windows)))]
        {
            let _ = (shell, tag, session_id);
            app.notification()
                .builder()
                .title(title)
                .body(body)
                .show()
                .map_err(|e| e.to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn shell_info(app: tauri::AppHandle, shell: tauri::State<Shell>) -> Value {
    json!({"version": app.package_info().version.to_string(), "os": if cfg!(target_os = "macos") { "mac" } else { std::env::consts::OS }, "devtools": cfg!(debug_assertions), "tray": shell.tray.load(Ordering::Acquire), "notificationIcon": shell.notification_icon})
}

#[tauri::command]
pub async fn apply_open_mode(app: tauri::AppHandle, path: Option<String>) -> Value {
    let result = tauri::async_runtime::spawn_blocking(move || {
        app.state::<Shell>()
            .open(&app, None, path.as_deref(), false)
    })
    .await;
    let error = match result {
        Ok(Ok(())) => None,
        Ok(Err(e)) => Some(e),
        Err(e) => Some(e.to_string()),
    };
    json!({ "error": error })
}

#[derive(Serialize)]
pub struct StartupStatus {
    error: Option<String>,
    logs: Vec<String>,
}

#[tauri::command]
pub fn startup_status(shell: tauri::State<Shell>) -> StartupStatus {
    StartupStatus {
        error: shell.error.lock().ok().and_then(|s| s.clone()),
        logs: shell
            .logs
            .lock()
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default(),
    }
}

#[tauri::command]
pub fn retry_startup(app: tauri::AppHandle) {
    Shell::start(app);
}

#[tauri::command]
pub fn quit(app: tauri::AppHandle) {
    Shell::quit(app);
}
