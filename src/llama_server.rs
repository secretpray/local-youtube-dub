//! llama.cpp's own server as the translation engine: the default on Windows,
//! where llama-cpp-python has no wheels and would need a compiler on every
//! machine, while llama.cpp publishes `llama-server` builds for x64 and ARM64.
//!
//! The host starts one server per session on a free loopback port, waits for
//! `/health`, and talks to its OpenAI-compatible `/v1/chat/completions`. A
//! server that died, hung or answered garbage is dropped (which kills it) and
//! started again for the next phrase, as a Python worker would be.

use crate::local_http::{self, HttpError};
use crate::process_tree::{self, ProcessTree};
use crate::Failure;
use serde_json::{json, Value};
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub struct LlamaServer {
    tree: ProcessTree,
    base: String,
    key: String,
    log: PathBuf,
}

pub struct Launch<'a> {
    pub binary: &'a Path,
    pub model: &'a Path,
    pub threads: usize,
    pub repack: bool,
    pub log: PathBuf,
}

impl LlamaServer {
    pub fn start(launch: Launch, timeout: Duration) -> Result<Self, Failure> {
        let failed = |detail: String| Failure::new("worker_failed", detail);
        let port = free_port().map_err(|error| failed(format!("no free port: {error}")))?;
        let key = session_key().map_err(|error| failed(format!("no random key: {error}")))?;
        let log = File::create(&launch.log).map_err(|error| failed(format!("log: {error}")))?;
        let log_copy = log
            .try_clone()
            .map_err(|error| failed(format!("log: {error}")))?;
        let mut command = Command::new(launch.binary);
        command
            .arg("--model")
            .arg(launch.model)
            .args(["--host", "127.0.0.1", "--port", &port.to_string()])
            .args(["--threads", &launch.threads.to_string()])
            // One phrase at a time, and a context sized for one: the defaults
            // (automatic slots, the model's 256k context, an 8 GB prompt cache
            // in RAM) are sized for a server, not for a laptop playing video.
            .args(["--parallel", "1", "--ctx-size", "2048", "--cache-ram", "0"])
            .args(["--no-webui", "--offline", "--reasoning", "off"])
            // The server allows requests from any web origin, so without a
            // key any page open in the browser could use it, by guessing
            // the port. Passed in the environment, which unlike the command
            // line other users can't read. /health stays open.
            .env("LLAMA_API_KEY", &key)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log_copy));
        if !launch.repack {
            // Weights stay a mapped file the OS can page out, instead of a
            // repacked copy in memory that can't be reclaimed: on a 5 GB Linux
            // machine that copy got the host killed (see translate_worker.py).
            command.arg("--no-repack");
        }
        let tree = process_tree::spawn(&mut command)
            .map_err(|error| failed(format!("{}: {error}", launch.binary.display())))?;
        let mut server = Self {
            tree,
            base: format!("http://127.0.0.1:{port}"),
            key,
            log: launch.log,
        };
        server.wait_until_ready(timeout)?;
        Ok(server)
    }

    /// `/health` answers 503 while the model loads and 200 once it serves.
    fn wait_until_ready(&mut self, timeout: Duration) -> Result<(), Failure> {
        let started = Instant::now();
        let agent = local_http::agent(Duration::from_secs(2));
        loop {
            if let Ok(Some(status)) = self.tree.try_wait() {
                return Err(Failure::new(
                    "worker_failed",
                    format!(
                        "llama-server exited ({}): {}",
                        explain(status),
                        self.log_tail()
                    ),
                ));
            }
            if let Ok(response) = agent.get(format!("{}/health", self.base)).call() {
                if response.status() == 200 {
                    return Ok(());
                }
            }
            if started.elapsed() > timeout {
                return Err(Failure::new(
                    "worker_timeout",
                    format!("llama-server not ready in {} s", timeout.as_secs()),
                ));
            }
            thread::sleep(Duration::from_millis(100));
        }
    }

    pub fn alive(&mut self) -> bool {
        matches!(self.tree.try_wait(), Ok(None))
    }

    pub fn complete(
        &mut self,
        system: &str,
        prompt: &str,
        temperature: f64,
        max_tokens: u32,
        timeout: Duration,
    ) -> Result<String, Failure> {
        let body = json!({
            "messages": [{"role": "system", "content": system},
                {"role": "user", "content": prompt}],
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": false,
        });
        let url = format!("{}/v1/chat/completions", self.base);
        let answer =
            local_http::post_json(&local_http::agent(timeout), &url, &body, Some(&self.key))
                .map_err(|error| match error {
                    HttpError::Timeout => Failure::new(
                        "worker_timeout",
                        format!("no answer in {} s", timeout.as_secs()),
                    ),
                    HttpError::Other(detail) => Failure::new("worker_failed", detail),
                })?;
        answer
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| Failure::new("worker_failed", format!("unexpected answer: {answer}")))
    }

    /// The end of the server's log, for an error that would otherwise only
    /// say "exited".
    fn log_tail(&self) -> String {
        let mut text = String::new();
        if let Ok(mut file) = File::open(&self.log) {
            let length = file.metadata().map(|meta| meta.len()).unwrap_or(0);
            let _ = file.seek(SeekFrom::Start(length.saturating_sub(600)));
            let _ = file.read_to_string(&mut text);
        }
        text.trim().replace('\n', " | ")
    }
}

/// An exit status, with the one cause a user can act on spelled out: a build
/// for newer processors than this one (see scripts/fetch.py).
fn explain(status: ExitStatus) -> String {
    // STATUS_ILLEGAL_INSTRUCTION on Windows, SIGILL elsewhere.
    #[cfg(windows)]
    let illegal = status.code() == Some(0xC000_001D_u32 as i32);
    #[cfg(unix)]
    let illegal = std::os::unix::process::ExitStatusExt::signal(&status) == Some(4);
    if illegal {
        format!("{status}: this processor lacks instructions this llama-server build needs; run setup again")
    } else {
        status.to_string()
    }
}

/// 128 random bits from the operating system, as hex.
fn session_key() -> Result<String, getrandom::Error> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// The port is released before the server binds it. Another program taking
/// it in that instant makes the server exit, which the next phrase retries.
fn free_port() -> io::Result<u16> {
    Ok(TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}
