use std::process::{Child, Command};

pub struct ProcessTree {
    pub child: Child,
    #[cfg(windows)]
    job: isize,
}

impl ProcessTree {
    pub fn shutdown(&mut self) {
        // Browser recordings get 30 seconds in the server; leave five seconds for exit cleanup.
        let start = std::time::Instant::now();
        while start.elapsed() < std::time::Duration::from_secs(35) {
            if self.child.try_wait().ok().flatten().is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        self.kill_tree();
    }

    pub fn spawn(command: &mut Command) -> std::io::Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn()?;
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Foundation::CloseHandle;
            use windows_sys::Win32::System::JobObjects::*;
            // SAFETY: handles and the initialized limits live through these calls.
            let job = unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if job.is_null()
                    || SetInformationJobObject(
                        job,
                        JobObjectExtendedLimitInformation,
                        &limits as *const _ as *const _,
                        std::mem::size_of_val(&limits) as u32,
                    ) == 0
                    || AssignProcessToJobObject(job, child.as_raw_handle()) == 0
                {
                    let error = std::io::Error::last_os_error();
                    if !job.is_null() {
                        CloseHandle(job);
                    }
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(error);
                }
                job as isize
            };
            Ok(Self { child, job })
        }
        #[cfg(not(windows))]
        {
            let _ = &mut child;
            Ok(Self { child })
        }
    }

    pub fn kill_tree(&mut self) {
        #[cfg(unix)]
        // SAFETY: this group was created for the owned child, never the shell's group.
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGKILL);
        }
        #[cfg(windows)]
        // SAFETY: the job handle belongs to this process tree.
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job as _, 1);
        }
        let _ = self.child.wait();
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        self.kill_tree();
        #[cfg(windows)]
        // SAFETY: this is the final use of the owned job handle.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job as _);
        }
    }
}
