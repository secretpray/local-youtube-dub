//! A child process together with everything it starts, killed as one.
//!
//! Workers start helpers of their own (yt-dlp starts Deno, and on Windows the
//! venv's python.exe is a launcher that starts the real interpreter), and those
//! hold the worker's pipes open: killing only the direct child would leave the
//! host waiting on a pipe nobody closes, and the model's memory taken.
//!
//! - Unix: the child leads its own process group, killed with `kill -9 -<pgid>`.
//! - Windows: the child runs in its own Job Object with KILL_ON_JOB_CLOSE. The
//!   job's only handle belongs to the host, so the tree also dies when the host
//!   does, however it dies: Chrome ends a host with TerminateProcess, which
//!   children never hear about, and a translation server left behind would
//!   hold gigabytes until the next reboot.

use std::io;
use std::process::{Child, Command, ExitStatus};
use std::sync::Arc;

pub struct ProcessTree {
    child: Child,
    group: Arc<imp::Group>,
    exited: bool,
}

/// Kills a tree from another thread (a watchdog) without owning it.
#[derive(Clone)]
pub struct Killer(Arc<imp::Group>);

impl Killer {
    pub fn kill(&self) {
        self.0.kill();
    }
}

/// Starts `command` as the root of a new tree.
pub fn spawn(command: &mut Command) -> io::Result<ProcessTree> {
    imp::prepare(command);
    let mut child = command.spawn()?;
    match imp::adopt(&child) {
        Ok(group) => Ok(ProcessTree {
            child,
            group: Arc::new(group),
            exited: false,
        }),
        Err(error) => {
            // On Windows the child is still suspended: nothing of it ran.
            let _ = child.kill();
            let _ = child.wait();
            Err(error)
        }
    }
}

/// A short-lived helper (a `--version` probe) that must not flash a console
/// window on Windows, where the host itself has none to lend it.
pub fn quiet(command: &mut Command) -> &mut Command {
    imp::no_window(command);
    command
}

impl ProcessTree {
    pub fn child(&mut self) -> &mut Child {
        &mut self.child
    }

    pub fn killer(&self) -> Killer {
        Killer(self.group.clone())
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        let status = self.child.try_wait()?;
        self.exited |= status.is_some();
        Ok(status)
    }

    /// Kills the whole tree and reaps the child. Safe to repeat.
    pub fn kill(&mut self) {
        self.group.kill();
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.exited = true;
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        // A Unix group whose leader exited by itself and was reaped can have
        // its id reused by an unrelated process: it is left alone. (A Windows
        // job handle can't be reused, and closing it still ends stragglers.)
        if !self.exited {
            self.kill();
        }
    }
}

#[cfg(unix)]
mod imp {
    use std::io;
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command, Stdio};

    pub struct Group(u32);

    pub fn prepare(command: &mut Command) {
        command.process_group(0);
    }

    pub fn no_window(_command: &mut Command) {}

    pub fn adopt(child: &Child) -> io::Result<Group> {
        Ok(Group(child.id()))
    }

    impl Group {
        /// The group may already be gone, which is fine and not worth a line
        /// on stderr.
        pub fn kill(&self) {
            let _ = Command::new("kill")
                .args(["-9", &format!("-{}", self.0)])
                .stderr(Stdio::null())
                .status();
        }
    }
}

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::io;
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command};
    use std::ptr::null;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME,
    };

    pub struct Group(HANDLE);

    // A job handle may be used and closed from any thread.
    unsafe impl Send for Group {}
    unsafe impl Sync for Group {}

    pub fn prepare(command: &mut Command) {
        // Suspended until it is in the job: a process that ran first could
        // start children of its own outside it.
        command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    }

    pub fn no_window(command: &mut Command) {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    pub fn adopt(child: &Child) -> io::Result<Group> {
        // SAFETY: plain Win32 calls on handles owned here; the limit structure
        // is zero-initialised as the API expects and outlives the call.
        unsafe {
            let job = CreateJobObjectW(null(), null());
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let group = Group(job);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if set == 0 || AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) == 0 {
                return Err(io::Error::last_os_error());
            }
            resume(child.id())?;
            Ok(group)
        }
    }

    /// Resumes the threads of a process created suspended. std closes the
    /// main thread's handle right after CreateProcess, so it is found again
    /// by owner process id.
    fn resume(pid: u32) -> io::Result<()> {
        // SAFETY: the snapshot and thread handles are closed on every path;
        // THREADENTRY32 carries its own size as the API requires.
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            let mut entry: THREADENTRY32 = zeroed();
            entry.dwSize = size_of::<THREADENTRY32>() as u32;
            let mut resumed = 0;
            let mut more = Thread32First(snapshot, &mut entry) != 0;
            while more {
                if entry.th32OwnerProcessID == pid {
                    let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                    if !thread.is_null() {
                        if ResumeThread(thread) != u32::MAX {
                            resumed += 1;
                        }
                        CloseHandle(thread);
                    }
                }
                more = Thread32Next(snapshot, &mut entry) != 0;
            }
            CloseHandle(snapshot);
            if resumed == 0 {
                return Err(io::Error::other(format!(
                    "no thread of process {pid} to resume"
                )));
            }
            Ok(())
        }
    }

    impl Group {
        pub fn kill(&self) {
            // SAFETY: the handle stays open until Drop.
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Group {
        fn drop(&mut self) {
            // SAFETY: the last reference to the handle; closing it also kills
            // whatever is left in the job (KILL_ON_JOB_CLOSE).
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
