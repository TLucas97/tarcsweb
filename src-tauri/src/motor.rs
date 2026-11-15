use reqwest::blocking::Client;
use serde_json::Value;
use std::{
    fs,
    net::TcpListener,
    path::PathBuf,
    time::{Duration, Instant},
};

pub struct Motor {
    pub port: u16,
    pub attached: bool,
    pub waiting_wsl: bool,
    pub log: String,
    #[cfg(unix)]
    _tray_lock: Option<fs::File>,
}

impl Motor {
    pub fn select(app_data: &std::path::Path) -> Result<Self, String> {
        let mut rejected = Vec::new();
        let preferred = std::env::var("TARCSWEB_PORT")
            .ok()
            .map(|v| v.parse::<u16>())
            .transpose()
            .map_err(|e| e.to_string())?;
        // Tests replace the production probes with isolated ports, never the owner's live ports.
        let ports = match std::env::var("TARCSWEB_PROBE_PORTS") {
            Ok(value) => value
                .split(',')
                .map(|p| p.trim().parse::<u16>())
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?,
            Err(_) => vec![24817, 24816],
        };
        let isolated = preferred.is_some_and(|p| !ports.contains(&p));
        let wsl_mode = cfg!(windows) && app_data.join("attach-wsl").exists();
        if wsl_mode
            || (!isolated
                && (!cfg!(debug_assertions) || std::env::var_os("TARCSWEB_PROBE_PORTS").is_some()))
        {
            let client = Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(2))
                .build()
                .map_err(|e| e.to_string())?;
            for &port in &ports {
                let origin = format!("http://127.0.0.1:{port}");
                if let Err(reason) = Self::verify_listener(port) {
                    rejected.push(format!("Refused listener on {port}: {reason}"));
                    continue;
                }
                if !Self::identifies(&client, port) {
                    continue;
                }
                let mut motor = Self {
                    port,
                    attached: true,
                    waiting_wsl: false,
                    log: format!("Attached to tarcsweb on {port}"),
                    #[cfg(unix)]
                    _tray_lock: None,
                };
                if cfg!(windows) {
                    fs::create_dir_all(app_data).map_err(|e| e.to_string())?;
                    fs::write(app_data.join("attach-wsl"), []).map_err(|e| e.to_string())?;
                    motor.attach_page(&client, &ports);
                    return Ok(motor);
                }
                let tauri = client
                    .get(format!("{origin}/api/shell"))
                    .send()
                    .ok()
                    .is_some_and(|r| r.status().as_u16() == 401);
                if tauri {
                    motor.log.push_str("; already owned by a desktop app");
                    if motor.attach_page(&client, &ports) {
                        return Ok(motor);
                    }
                    rejected.push(format!("Refused page on {port}: no verified page listener"));
                    continue;
                }
                match motor.take_over(&client) {
                    Ok(()) => {
                        motor.attached = false;
                        motor.log = format!(
                            "Taking over tarcsweb on {port}; previous server and tray stopped"
                        );
                    }
                    Err(error) => motor
                        .log
                        .push_str(&format!("; takeover unavailable: {error}")),
                }
                if motor.attached
                    && (Self::verify_listener(port).is_err() || !motor.attach_page(&client, &ports))
                {
                    rejected.push(format!(
                        "Refused attachment on {port}: server or page identity unavailable"
                    ));
                    continue;
                }
                return Ok(motor);
            }
        }
        // Windows WSL marker: %APPDATA%\dev.tarcsweb.app\attach-wsl (Tauri app_data_dir).
        if wsl_mode {
            return Ok(Self {
                port: ports.first().copied().ok_or("No probe ports")?,
                attached: true,
                waiting_wsl: true,
                log: "tarcsweb is not running in WSL".into(),
                #[cfg(unix)]
                _tray_lock: None,
            });
        }
        let first = preferred.unwrap_or(24816);
        let port = std::iter::once(first)
            .chain(first.saturating_add(1)..=first.saturating_add(20))
            .find(|&p| TcpListener::bind(("127.0.0.1", p)).is_ok())
            .ok_or("No free server port")?;
        Ok(Self {
            port,
            attached: false,
            waiting_wsl: false,
            log: format!(
                "{}Starting owned tarcsweb on {port}",
                if rejected.is_empty() {
                    String::new()
                } else {
                    format!("{}; ", rejected.join("; "))
                }
            ),
            #[cfg(unix)]
            _tray_lock: None,
        })
    }

    #[cfg(target_os = "linux")]
    fn verify_listener(port: u16) -> Result<(), String> {
        use std::os::unix::fs::MetadataExt;
        let uid = unsafe { libc::geteuid() };
        let mut inodes = Vec::new();
        for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
            let rows = fs::read_to_string(table).map_err(|e| e.to_string())?;
            for row in rows.lines().skip(1) {
                let fields: Vec<_> = row.split_whitespace().collect();
                if fields.len() < 10 || fields[3] != "0A" {
                    continue;
                }
                let Some((address, number)) = fields[1].split_once(':') else {
                    continue;
                };
                if u16::from_str_radix(number, 16) != Ok(port)
                    || !matches!(
                        address,
                        "0100007F"
                            | "00000000"
                            | "00000000000000000000000000000000"
                            | "0000000000000000FFFF00000100007F"
                    )
                {
                    continue;
                }
                if fields[7].parse::<u32>() != Ok(uid) {
                    return Err("listener belongs to another uid".into());
                }
                inodes.push(format!("socket:[{}]", fields[9]));
            }
        }
        if inodes.is_empty() {
            return Err("no verifiable listening socket".into());
        }
        let mut found = false;
        for entry in fs::read_dir("/proc").map_err(|e| e.to_string())?.flatten() {
            if entry.file_name().to_string_lossy().parse::<u32>().is_err() {
                continue;
            }
            let path = entry.path();
            let Ok(fds) = fs::read_dir(path.join("fd")) else {
                continue;
            };
            if !fds.flatten().any(|fd| {
                fs::read_link(fd.path())
                    .is_ok_and(|p| inodes.iter().any(|i| p.as_os_str() == i.as_str()))
            }) {
                continue;
            }
            if !fs::metadata(&path).is_ok_and(|m| m.uid() == uid) {
                return Err("process uid mismatch".into());
            }
            let command = fs::read(path.join("cmdline")).map_err(|e| e.to_string())?;
            let args: Vec<_> = command
                .split(|b| *b == 0)
                .filter(|a| !a.is_empty())
                .map(|a| String::from_utf8_lossy(a).into_owned())
                .collect();
            let cwd = fs::read_link(path.join("cwd")).map_err(|e| e.to_string())?;
            if !Self::server_command(&args, &cwd) {
                return Err("process is not a tarcsweb server entry".into());
            }
            found = true;
        }
        if found {
            Ok(())
        } else {
            Err("socket owner could not be proved".into())
        }
    }

    #[cfg(unix)]
    fn server_command(args: &[String], cwd: &std::path::Path) -> bool {
        let Some(executable) = args
            .first()
            .and_then(|a| std::path::Path::new(a).file_name())
            .and_then(|s| s.to_str())
        else {
            return false;
        };
        if !matches!(executable, "node" | "nodejs" | "tarcsweb-node") {
            return false;
        }
        let mut arguments = args.iter().skip(1);
        let entry = loop {
            let Some(argument) = arguments.next() else {
                return false;
            };
            if argument == "--" {
                break arguments.next();
            }
            let option = argument.split('=').next().unwrap_or(argument);
            // Eval, print and package scripts do not identify a server entry.
            if matches!(option, "--eval" | "--print" | "--run" | "-e" | "-p")
                || argument.starts_with("-e") && !argument.starts_with("--")
                || argument.starts_with("-p") && !argument.starts_with("--")
            {
                return false;
            }
            if !argument.starts_with('-') {
                break Some(argument);
            }
            if !argument.contains('=')
                && matches!(
                    option,
                    "--import"
                        | "--require"
                        | "--loader"
                        | "--experimental-loader"
                        | "-r"
                        | "--conditions"
                        | "-C"
                        | "--inspect-port"
                        | "--title"
                        | "--env-file"
                        | "--env-file-if-exists"
                        | "--watch-path"
                )
                && arguments.next().is_none()
            {
                return false;
            }
        };
        let Some(entry) = entry else {
            return false;
        };
        let entry = cwd.join(entry);
        let Ok(entry) = entry.canonicalize() else {
            return false;
        };
        if !entry.ends_with("server/index.ts") && !entry.ends_with("server/boot.ts") {
            return false;
        }
        if executable == "tarcsweb-node" {
            return true;
        }
        entry
            .parent()
            .and_then(|p| p.parent())
            .and_then(|root| fs::read(root.join("package.json")).ok())
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .is_some_and(|package| {
                matches!(package["name"].as_str(), Some("tarcsweb" | "claude-web"))
            })
    }

    #[cfg(target_os = "macos")]
    fn verify_listener(port: u16) -> Result<(), String> {
        use std::process::Command;
        let output = Command::new("lsof")
            .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-Fp"])
            .output()
            .map_err(|e| e.to_string())?;
        let mut found = false;
        for pid in String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|s| s.strip_prefix('p'))
        {
            let uid = Command::new("ps")
                .args(["-p", pid, "-o", "uid="])
                .output()
                .map_err(|e| e.to_string())?;
            if String::from_utf8_lossy(&uid.stdout)
                .trim()
                .parse::<u32>()
                .ok()
                != Some(unsafe { libc::geteuid() })
            {
                return Err("process uid mismatch".into());
            }
            let command = Command::new("ps")
                .args(["-ww", "-p", pid, "-o", "command="])
                .output()
                .map_err(|e| e.to_string())?;
            let args: Vec<_> = String::from_utf8_lossy(&command.stdout)
                .split_whitespace()
                .map(str::to_owned)
                .collect();
            let cwd = Command::new("lsof")
                .args(["-a", "-p", pid, "-d", "cwd", "-Fn"])
                .output()
                .map_err(|e| e.to_string())?;
            let cwd = String::from_utf8_lossy(&cwd.stdout);
            let cwd = cwd
                .lines()
                .find_map(|s| s.strip_prefix('n'))
                .ok_or("process cwd unavailable")?;
            if !Self::server_command(&args, std::path::Path::new(cwd)) {
                return Err("process is not a tarcsweb server entry".into());
            }
            found = true;
        }
        if found {
            Ok(())
        } else {
            Err("socket owner could not be proved by lsof".into())
        }
    }

    #[cfg(windows)]
    fn verify_listener(_: u16) -> Result<(), String> {
        Ok(())
    }

    fn identifies(client: &Client, port: u16) -> bool {
        client
            .get(format!("http://127.0.0.1:{port}/api/identity"))
            .send()
            .ok()
            .filter(|r| r.status().as_u16() == 200)
            .and_then(|r| r.json::<Value>().ok())
            .is_some_and(|v| v["app"] == "tarcsweb")
    }

    fn attach_page(&mut self, client: &Client, ports: &[u16]) -> bool {
        let root = |port| client.get(format!("http://127.0.0.1:{port}/")).send().ok();
        // A tray in dev mode serves the page through Vite, on the other probed port.
        if root(self.port).is_some_and(|r| r.status().as_u16() == 404) {
            if let Some(&port) = ports.iter().find(|&&p| {
                p != self.port
                    && Self::verify_listener(p).is_ok()
                    && Self::identifies(client, p)
                    && root(p).is_some_and(|r| {
                        r.status().is_success()
                            && r.headers()
                                .get(reqwest::header::CONTENT_TYPE)
                                .is_some_and(|v| {
                                    v.to_str().is_ok_and(|v| v.starts_with("text/html"))
                                })
                    })
            }) {
                self.port = port;
                self.log.push_str(&format!("; page served on {port}"));
                return true;
            }
            return false;
        }
        true
    }

    fn take_over(&mut self, client: &Client) -> Result<(), String> {
        let home = PathBuf::from(std::env::var_os("HOME").ok_or("HOME missing")?);
        let legacy = home.join(".cache/claude-web");
        let cache = std::env::var_os("CW_CACHE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                if legacy.exists() {
                    legacy
                } else {
                    std::env::var_os("XDG_CACHE_HOME")
                        .map(PathBuf::from)
                        .unwrap_or_else(|| home.join(".cache"))
                        .join("tarcsweb")
                }
            });
        let hook: Value = serde_json::from_slice(
            &fs::read(cache.join(format!("terminal-hook/{}.json", self.port)))
                .map_err(|e| format!("quit token unavailable: {e}"))?,
        )
        .map_err(|e| e.to_string())?;
        if hook["port"].as_u64() != Some(u64::from(self.port)) {
            return Err("quit token port mismatch".into());
        }
        let token = hook["token"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("quit token missing")?;
        let response = client
            .post(format!("http://127.0.0.1:{}/api/quit", self.port))
            .bearer_auth(token)
            .send()
            .map_err(|e| e.to_string())?;
        if response.status().as_u16() != 202 {
            return Err(format!("quit: HTTP {}", response.status()));
        }
        let start = Instant::now();
        loop {
            if TcpListener::bind(("127.0.0.1", self.port)).is_ok() && self.tray_stopped(&home)? {
                return Ok(());
            }
            if start.elapsed() >= Duration::from_secs(45) {
                return Err("graceful shutdown or tray exit timed out after 45 seconds".into());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    fn tray_stopped(&mut self, home: &std::path::Path) -> Result<bool, String> {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let dir = std::env::var_os("CWEB_TRAY_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".cache/cweb"));
            let file = match fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(dir.join("tray.lock"))
            {
                Ok(file) => file,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(true),
                Err(e) => return Err(format!("tray lock unavailable: {e}")),
            };
            // Hold the launcher's lock so its crash watcher cannot restart a server during takeover.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                let error = std::io::Error::last_os_error();
                return if error.kind() == std::io::ErrorKind::WouldBlock {
                    Ok(false)
                } else {
                    Err(error.to_string())
                };
            }
            self._tray_lock = Some(file);
        }
        #[cfg(not(unix))]
        let _ = home;
        Ok(true)
    }
}
