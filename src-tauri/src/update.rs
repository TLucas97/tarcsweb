use crate::shell::Shell;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

pub const SOURCE_DIR: Option<&str> = option_env!("TARCSWEB_SOURCE_DIR");

#[derive(Default)]
pub struct Updates {
    busy: AtomicBool,
    status: Mutex<Value>,
    release: Mutex<Option<Update>>,
}

impl Updates {
    #[cfg(target_os = "linux")]
    fn build_command(program: &str) -> Result<std::process::Command, String> {
        let mut command = std::process::Command::new(program);
        Shell::clean_appimage_env(&mut command)?;
        let current = command.get_envs().find(|(key, _)| *key == "PATH")
            .map(|(_, value)| value.map(std::ffi::OsStr::to_os_string))
            .unwrap_or_else(|| std::env::var_os("PATH"))
            .unwrap_or_default();
        let paths = option_env!("TARCSWEB_BUILD_PATH").into_iter()
            .flat_map(std::env::split_paths)
            .chain(std::env::split_paths(&current));
        command.env("PATH", std::env::join_paths(paths).map_err(|e| e.to_string())?);
        Ok(command)
    }

    fn claim(&self) -> Result<(), String> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| "An update is already running".into())
    }

    fn report(&self, app: &tauri::AppHandle, status: Value) {
        if let Ok(mut current) = self.status.lock() {
            *current = status.clone();
        }
        let _ = app.emit_to("main", "desktop-update", status);
    }

    fn finish(&self, app: &tauri::AppHandle, result: &Result<(), String>) {
        if let Err(error) = result {
            self.report(app, json!({ "phase": "failed", "message": error }));
        }
        self.busy.store(false, Ordering::Release);
    }

    #[cfg(target_os = "linux")]
    fn rebuild(&self, app: &tauri::AppHandle) -> Result<(), String> {
        use std::{
            fs::{self, File, OpenOptions},
            io::{BufRead, BufReader},
            os::unix::{fs::PermissionsExt, process::CommandExt},
            path::PathBuf,
            process::{Command, Stdio},
            time::Duration,
        };
        let source = SOURCE_DIR.filter(|dir| std::path::Path::new(dir).is_dir())
            .ok_or("The source checkout is unavailable")?;
        let image = PathBuf::from(std::env::var_os("APPIMAGE")
            .filter(|path| !path.is_empty()).ok_or("Rebuilding requires an AppImage")?);
        let log_path = app.path().app_log_dir().map_err(|e| e.to_string())?.join("rebuild.log");
        let result = (|| -> Result<(), String> {
            let file = File::create(&log_path).map_err(|e| e.to_string())?;
            let mut probe = Self::build_command("patchelf")?;
            if !probe.arg("--version").stdout(Stdio::null()).stderr(Stdio::null())
                .status().is_ok_and(|s| s.success()) {
                return Err("Install patchelf first using your system package manager (Arch: sudo pacman -S patchelf)".into());
            }
            let mut rustc = Self::build_command("rustc")?;
            let output = rustc.arg("-vV").output().map_err(|e| format!("Could not run rustc: {e}"))?;
            let version = String::from_utf8_lossy(&output.stdout);
            let target = version.lines().find_map(|line| line.strip_prefix("host: "))
                .filter(|_| output.status.success()).ok_or("Could not determine the Rust host target")?;
            let mut command = Self::build_command("node")?;
            command.current_dir(source).args(["scripts/tauri/build.mjs", target, "--bundles", "appimage"])
                .env("NO_STRIP", "true").stdin(Stdio::null())
                .stdout(file.try_clone().map_err(|e| e.to_string())?).stderr(file);
            let mut tree = crate::process::ProcessTree::spawn(&mut command)
                .map_err(|e| format!("Could not start rebuild: {e}"))?;
            let mut reader = BufReader::new(File::open(&log_path).map_err(|e| e.to_string())?);
            let mut line = String::new();
            loop {
                let mut last = None;
                while reader.read_line(&mut line).map_err(|e| e.to_string())? != 0 {
                    last = Some(line.trim().chars().take(1000).collect::<String>());
                    line.clear();
                }
                if let Some(last) = last {
                    self.report(app, json!({"phase":"building", "message":last, "logPath":log_path}));
                }
                if let Some(status) = tree.child.try_wait().map_err(|e| e.to_string())? {
                    if !status.success() {
                        return Err(format!("Rebuild exited with {status}"));
                    }
                    break;
                }
                std::thread::sleep(Duration::from_millis(400));
            }
            let output = PathBuf::from(source).join("src-tauri/target").join(target)
                .join("release/bundle/appimage");
            let images = fs::read_dir(output).map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
                .into_iter().map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|e| e == "AppImage")).collect::<Vec<_>>();
            if images.len() != 1 {
                return Err("Expected exactly one rebuilt AppImage".into());
            }
            let temporary = image.with_file_name(format!(".tarcsweb-update-{}", std::process::id()));
            let replacement = (|| -> Result<(), String> {
                let mut destination = OpenOptions::new().write(true).create_new(true)
                    .open(&temporary).map_err(|e| e.to_string())?;
                let mut source = File::open(&images[0]).map_err(|e| e.to_string())?;
                std::io::copy(&mut source, &mut destination).map_err(|e| e.to_string())?;
                destination.set_permissions(fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
                destination.sync_all().map_err(|e| e.to_string())?;
                fs::rename(&temporary, &image).map_err(|e| e.to_string())
            })();
            if replacement.is_err() {
                let _ = fs::remove_file(&temporary);
            }
            replacement?;
            self.report(app, json!({ "phase": "restarting", "logPath": log_path }));
            let mut relaunch = Command::new(&image);
            Shell::clean_appimage_env(&mut relaunch)?;
            let shell = app.state::<Shell>();
            shell.stop();
            // Replace this process so the new instance cannot race the old instance's lock.
            let error = relaunch.exec();
            shell.resume(app.clone());
            Err(format!("AppImage replaced, but restart failed: {error}"))
        })();
        result.map_err(|error| {
            use std::io::Write;
            if let Ok(mut log) = OpenOptions::new().append(true).open(&log_path) {
                let _ = writeln!(log, "{error}");
            }
            format!("{error}. Log: {}", log_path.display())
        })
    }
}

#[tauri::command]
pub async fn desktop_info(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = SOURCE_DIR.map(std::path::Path::new);
        let mut commit = None;
        let mut dirty = false;
        if let Some(dir) = source.filter(|p| p.is_dir()) {
            let git = |args: &[&str]| {
                let mut command = std::process::Command::new("git");
                #[cfg(target_os = "linux")]
                Shell::clean_appimage_env(&mut command)?;
                let output = command.current_dir(dir).args(args).output().map_err(|e| e.to_string())?;
                if !output.status.success() {
                    return Err("Could not read checkout commit".to_string());
                }
                Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
            };
            commit = git(&["rev-parse", "--short", "HEAD"]).ok();
            dirty = git(&["status", "--porcelain"]).is_ok_and(|s| !s.is_empty());
        }
        Ok(json!({ "version": app.package_info().version.to_string(),
            "kind": if SOURCE_DIR.is_some() { "source" } else { "release" },
            "sourceDir": SOURCE_DIR, "commit": commit, "dirty": dirty,
            "canRebuild": cfg!(target_os = "linux") && source.is_some_and(|p| p.is_dir())
                && std::env::var_os("APPIMAGE").is_some_and(|p| !p.is_empty()) }))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn update_status(updates: tauri::State<Updates>) -> Result<Value, String> {
    updates.status.lock().map(|s| s.clone()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rebuild(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        Err("Source rebuild is supported only on Linux AppImage".into())
    }
    #[cfg(target_os = "linux")]
    tauri::async_runtime::spawn_blocking(move || {
        let updates = app.state::<Updates>();
        updates.claim()?;
        updates.report(&app, json!({ "phase": "building" }));
        let result = updates.rebuild(&app);
        updates.finish(&app, &result);
        result
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn check_update(app: tauri::AppHandle) -> Result<(), String> {
    if SOURCE_DIR.is_some() {
        return Err("Source builds cannot use release updates".into());
    }
    let updates = app.state::<Updates>();
    updates.claim()?;
    updates.report(&app, json!({ "phase": "checking" }));
    let result = async {
        let handle = app.clone();
        let update = app.updater_builder().on_before_exit(move || {
            handle.state::<Shell>().stop();
            handle.cleanup_before_exit();
        }).build().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
        let status = match &update {
            Some(update) => json!({ "phase": "available", "version": update.version }),
            None => json!({ "phase": "latest" }),
        };
        *updates.release.lock().map_err(|e| e.to_string())? = update;
        updates.report(&app, status);
        Ok(())
    }.await;
    updates.finish(&app, &result);
    result
}

#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    if SOURCE_DIR.is_some() {
        return Err("Source builds cannot use release updates".into());
    }
    let updates = app.state::<Updates>();
    updates.claim()?;
    let result = async {
        let update = updates.release.lock().map_err(|e| e.to_string())?.take().ok_or("Check for updates first")?;
        updates.report(&app, json!({ "phase": "downloading", "progress": 0 }));
        let mut downloaded = 0u64;
        let bytes = update.download(|chunk, total| {
            downloaded += chunk as u64;
            updates.report(&app, json!({ "phase": "downloading",
                "progress": total.filter(|n| *n > 0).map(|n| (downloaded.saturating_mul(100) / n).min(100)) }));
        }, || {}).await.map_err(|e| e.to_string())?;
        updates.report(&app, json!({ "phase": "installing" }));
        update.install(bytes).map_err(|e| e.to_string())?;
        updates.report(&app, json!({ "phase": "restarting" }));
        Ok(())
    }.await;
    updates.finish(&app, &result);
    result
}

#[tauri::command]
pub async fn prepare_restart(app: tauri::AppHandle) -> Result<(), String> {
    if SOURCE_DIR.is_some() {
        return Err("Source builds cannot use release updates".into());
    }
    tauri::async_runtime::spawn_blocking(move || app.state::<Shell>().stop())
        .await.map_err(|e| e.to_string())
}
