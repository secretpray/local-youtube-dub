//! Native Messaging host: translates phrases from English, Spanish or German
//! into Russian or Ukrainian, voices them, and transcribes videos that have no
//! subtitles.
//!
//! Every model runs in a long-lived Python worker next to this binary
//! (`worker/*.py`), so it is loaded once per browser session. Paths in
//! `bin/config.json` are relative to the project folder, which makes the
//! folder itself portable: move it, run `make install`, done.
//!
//! Errors carry a `code` the extension turns into a message in the viewer's
//! language, and an English `error` detail for the session journal.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

const MAX_INCOMING: usize = 2 * 1024 * 1024;
const MAX_OUTGOING: usize = 950_000;
const DEFAULT_MLX_MODEL: &str = "mlx-community/Qwen3-4B-Instruct-2507-4bit";
const DEFAULT_OLLAMA_MODEL: &str = "qwen3:4b-instruct";
/// Languages a video may be in, and languages it can be dubbed into.
const SOURCES: [&str; 4] = ["auto", "en", "es", "de"];
const TARGETS: [&str; 2] = ["ru", "uk"];
/// Loading a model from a cold disk cache takes seconds; a phrase takes well
/// under one. Past these a worker is treated as hung and killed.
const WORKER_START_TIMEOUT: Duration = Duration::from_secs(120);
const WORKER_CALL_TIMEOUT: Duration = Duration::from_secs(40);

fn main() {
    extend_path();
    env::set_var("HF_HOME", project_dir().join("cache").join("huggingface"));
    // Native Messaging reserves stdout for length-prefixed JSON messages.
    let mut input = io::stdin().lock();
    let (output_tx, output_rx) = mpsc::channel::<Value>();
    let writer = thread::spawn(move || {
        let mut output = io::stdout().lock();
        for response in output_rx {
            if send_response(&mut output, &response).is_err() {
                break;
            }
        }
    });

    let (synth_tx, synth_rx) = mpsc::channel::<Job<SynthesisJob>>();
    let output_for_synth = output_tx.clone();
    let synthesizer = thread::spawn(move || {
        // One voice per target language, each started on first use.
        let mut voices: HashMap<String, LineWorker> = HashMap::new();
        for job in synth_rx {
            let job = match job {
                // Warm-up only loads the voice, so the first phrase does not
                // pay for model start-up.
                Job::Warm(target) => {
                    if let Entry::Vacant(slot) = voices.entry(target) {
                        if let Ok(voice) = start_voice(slot.key()) {
                            slot.insert(voice);
                        }
                    }
                    continue;
                }
                Job::Work(job) => job,
            };
            let response = match synthesize(&mut voices, &job) {
                Ok((wav, duration)) => json!({
                    "id": job.id, "ok": true,
                    "result": {"translated": job.translated,
                        "wavBase64": STANDARD.encode(wav), "duration": duration}
                }),
                Err(failure) => failure.response(job.id),
            };
            if output_for_synth.send(response).is_err() {
                break;
            }
        }
    });

    let (translate_tx, translate_rx) = mpsc::channel::<Job<TranslationJob>>();
    let output_for_translate = output_tx.clone();
    let synth_for_translate = synth_tx.clone();
    let translator = thread::spawn(move || {
        let mut llm = Translator::default();
        for job in translate_rx {
            let job = match job {
                Job::Warm(_) => {
                    llm.warm();
                    continue;
                }
                Job::Work(job) => job,
            };
            match llm.translate(&job) {
                Ok(translated) => {
                    let next = SynthesisJob {
                        id: job.id,
                        translated,
                        into: job.into,
                        duration: job.duration,
                    };
                    if synth_for_translate.send(Job::Work(next)).is_err() {
                        break;
                    }
                }
                Err(failure) => {
                    if output_for_translate
                        .send(failure.response(job.id))
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    });

    let mut transcription_cancels = Vec::new();
    loop {
        let mut size = [0_u8; 4];
        match input.read_exact(&mut size) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(error) => {
                eprintln!("cannot read native message: {error}");
                break;
            }
        }
        let length = u32::from_le_bytes(size) as usize;
        if length == 0 || length > MAX_INCOMING {
            eprintln!("invalid native message length: {length}");
            break;
        }
        let mut bytes = vec![0_u8; length];
        if input.read_exact(&mut bytes).is_err() {
            break;
        }
        let request: Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("invalid JSON: {error}");
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let response = match request.get("type").and_then(Value::as_str) {
            Some("status") => {
                let target = target_of(&request);
                match preflight(&target) {
                    Ok(result) => {
                        let _ = translate_tx.send(Job::Warm(target.clone()));
                        let _ = synth_tx.send(Job::Warm(target));
                        Some(json!({"id": id, "ok": true, "result": result}))
                    }
                    Err(failure) => Some(failure.response(id)),
                }
            }
            Some("translate") => match TranslationJob::parse(id.clone(), &request) {
                Ok(job) => {
                    if translate_tx.send(Job::Work(job)).is_err() {
                        break;
                    }
                    None
                }
                Err(failure) => Some(failure.response(id)),
            },
            Some("transcribe") => match TranscriptionJob::parse(&request) {
                Ok(job) => {
                    let output = output_tx.clone();
                    let (cancel_tx, cancel_rx) = mpsc::channel();
                    transcription_cancels.push(cancel_tx);
                    thread::spawn(move || {
                        let response = match transcribe_video(&job, cancel_rx) {
                            Ok(result) => json!({"id": id, "ok": true, "result": result}),
                            Err(failure) => failure.response(id),
                        };
                        let _ = output.send(response);
                    });
                    None
                }
                Err(failure) => Some(failure.response(id)),
            },
            _ => Some(Failure::new("bad_request", "unknown request type").response(id)),
        };
        if let Some(response) = response {
            if output_tx.send(response).is_err() {
                break;
            }
        }
    }
    for cancel in transcription_cancels {
        let _ = cancel.send(());
    }
    drop(translate_tx);
    let _ = translator.join();
    drop(synth_tx);
    let _ = synthesizer.join();
    drop(output_tx);
    let _ = writer.join();
}

enum Job<T> {
    /// Load models for this target language ahead of the first phrase.
    Warm(String),
    Work(T),
}

/// An error the extension can explain in the viewer's language: `code` picks
/// the message, `params` fill it in, `detail` is the raw cause for the journal.
#[derive(Debug)]
struct Failure {
    code: &'static str,
    params: Value,
    detail: String,
}

impl Failure {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            params: json!({}),
            detail: detail.into(),
        }
    }

    fn with(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.params[key] = value.into();
        self
    }

    /// Keeps a timeout a timeout; anything else a worker reported becomes
    /// `code`, the stage it happened in.
    fn during(self, code: &'static str) -> Self {
        if self.code == "worker_timeout" {
            self
        } else {
            Self { code, ..self }
        }
    }

    fn response(&self, id: Value) -> Value {
        json!({"id": id, "ok": false, "code": self.code, "params": self.params,
            "error": self.detail})
    }
}

/// The browser starts the host with the bare system PATH, which on macOS does
/// not include Homebrew: ffmpeg would be found from a terminal and missing
/// under Chrome. The project's own environment comes first, because that is
/// where yt-dlp finds deno, its JavaScript runtime for YouTube.
fn extend_path() {
    let current = env::var("PATH").unwrap_or_default();
    let mut parts: Vec<String> = Vec::new();
    if let Some(bin) = python().parent() {
        parts.push(bin.to_string_lossy().into_owned());
    }
    parts.extend(current.split(':').filter(|part| !part.is_empty()).map(str::to_owned));
    for extra in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
        if !parts.iter().any(|part| part == extra) {
            parts.push(extra.to_owned());
        }
    }
    parts.dedup();
    env::set_var("PATH", parts.join(":"));
}

/// The project folder: the binary lives in `<project>/bin/`.
fn project_dir() -> PathBuf {
    env::current_exe()
        .ok()
        .and_then(|path| path.parent()?.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn config() -> Value {
    fs::read(project_dir().join("bin").join("config.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or(Value::Null)
}

/// A setting from the environment, then `bin/config.json`, then the default.
fn setting(variable: &str, key: &str, default: &str) -> String {
    if let Ok(value) = env::var(variable) {
        return value;
    }
    config()
        .pointer(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| default.to_owned())
}

/// A path setting; relative paths are taken from the project folder.
fn path_setting(variable: &str, key: &str, default: &str) -> PathBuf {
    let path = PathBuf::from(setting(variable, key, default));
    if path.is_absolute() {
        path
    } else {
        project_dir().join(path)
    }
}

fn python() -> PathBuf {
    path_setting("DUB_PYTHON", "/python", ".venv/bin/python")
}

fn target_of(request: &Value) -> String {
    request
        .get("into")
        .and_then(Value::as_str)
        .filter(|target| TARGETS.contains(target))
        .unwrap_or("ru")
        .to_owned()
}

#[derive(Debug)]
struct TranslationJob {
    id: Value,
    source: String,
    language: String,
    into: String,
    before: String,
    after: String,
    duration: f64,
}

impl TranslationJob {
    fn parse(id: Value, request: &Value) -> Result<Self, Failure> {
        let source = request
            .get("source")
            .and_then(Value::as_str)
            .ok_or_else(|| Failure::new("bad_request", "missing phrase text"))?;
        let language = request
            .get("language")
            .and_then(Value::as_str)
            .unwrap_or("auto");
        let into = request.get("into").and_then(Value::as_str).unwrap_or("ru");
        if source.trim().is_empty() || source.len() > 1800 {
            return Err(Failure::new("bad_request", "phrase length out of range"));
        }
        if !SOURCES.contains(&language) {
            return Err(Failure::new("language_unsupported", format!("source {language}"))
                .with("language", language));
        }
        if !TARGETS.contains(&into) {
            return Err(Failure::new("bad_request", format!("target {into}")));
        }
        let before = request
            .get("contextBefore")
            .and_then(Value::as_str)
            .unwrap_or("");
        let after = request
            .get("contextAfter")
            .and_then(Value::as_str)
            .unwrap_or("");
        if before.len() > 600 || after.len() > 600 {
            return Err(Failure::new("bad_request", "context too long"));
        }
        let duration = request
            .get("targetDuration")
            .and_then(Value::as_f64)
            .unwrap_or(8.0)
            .clamp(1.0, 30.0);
        Ok(Self {
            id,
            source: source.to_owned(),
            language: language.to_owned(),
            into: into.to_owned(),
            before: before.to_owned(),
            after: after.to_owned(),
            duration,
        })
    }
}

struct SynthesisJob {
    id: Value,
    translated: String,
    into: String,
    duration: f64,
}

struct TranscriptionJob {
    video_id: String,
    start: u64,
    window: u64,
    language: String,
}

impl TranscriptionJob {
    fn parse(request: &Value) -> Result<Self, Failure> {
        let video_id = request.get("videoId").and_then(Value::as_str).unwrap_or("");
        if video_id.len() != 11
            || !video_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        {
            return Err(Failure::new("bad_request", "invalid video id"));
        }
        Ok(Self {
            video_id: video_id.to_owned(),
            start: request
                .get("startSeconds")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .min(86_400),
            window: request
                .get("windowSeconds")
                .and_then(Value::as_u64)
                .unwrap_or(180)
                .clamp(30, 300),
            language: request
                .get("language")
                .and_then(Value::as_str)
                .filter(|language| *language != "auto" && SOURCES.contains(language))
                .unwrap_or("auto")
                .to_owned(),
        })
    }
}

fn send_response(output: &mut impl Write, response: &Value) -> io::Result<()> {
    let encoded = serde_json::to_vec(response)?;
    if encoded.len() <= MAX_OUTGOING {
        return write_frame(output, &encoded);
    }
    if let Some(wav) = response
        .pointer("/result/wavBase64")
        .and_then(Value::as_str)
    {
        // 500 000 is a multiple of 4, so every part is valid base64 on its own.
        let chunks: Vec<&[u8]> = wav.as_bytes().chunks(500_000).collect();
        for (index, part) in chunks.iter().enumerate() {
            let chunk = json!({
                "id": response["id"],
                "ok": true,
                "chunkIndex": index,
                "chunkCount": chunks.len(),
                "result": {
                    "translated": response["result"]["translated"],
                    "duration": response["result"]["duration"],
                    "wavBase64": String::from_utf8_lossy(part),
                }
            });
            let encoded = serde_json::to_vec(&chunk)?;
            if encoded.len() > MAX_OUTGOING {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "chunk too large",
                ));
            }
            write_frame(output, &encoded)?;
        }
        return Ok(());
    }
    if response["ok"] == true && response.get("result").is_some() {
        let result = serde_json::to_vec(&response["result"])?;
        let encoded = STANDARD.encode(result);
        let chunks: Vec<&[u8]> = encoded.as_bytes().chunks(500_000).collect();
        for (index, part) in chunks.iter().enumerate() {
            let chunk = json!({
                "id": response["id"], "ok": true,
                "chunkIndex": index, "chunkCount": chunks.len(),
                "resultJsonBase64": String::from_utf8_lossy(part)
            });
            write_frame(output, &serde_json::to_vec(&chunk)?)?;
        }
        return Ok(());
    }
    let error = Failure::new("internal", "response too large").response(response["id"].clone());
    write_frame(output, &serde_json::to_vec(&error)?)
}

fn write_frame(output: &mut impl Write, encoded: &[u8]) -> io::Result<()> {
    output.write_all(&(encoded.len() as u32).to_le_bytes())?;
    output.write_all(encoded)?;
    output.flush()
}

/// A long-lived Python worker speaking JSON lines. It announces itself with
/// `{"ready": true}` (or `{"error": ...}`) once its model is loaded.
struct LineWorker {
    process: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl LineWorker {
    fn start(script: &str, args: &[String]) -> Result<Self, Failure> {
        let path = project_dir().join("worker").join(script);
        if !path.is_file() {
            return Err(Failure::new("worker_failed", format!("{} not found", path.display())));
        }
        let mut process = Command::new(python())
            .arg(&path)
            .args(args)
            // Own process group, so the watchdog can kill the worker together
            // with anything it started that still holds the pipe open.
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| Failure::new("worker_failed", format!("{script}: {error}")))?;
        let input = process.stdin.take().expect("piped stdin");
        let output = BufReader::new(process.stdout.take().expect("piped stdout"));
        let mut worker = Self {
            process,
            input,
            output,
        };
        let handshake = worker
            .read_within(WORKER_START_TIMEOUT)
            .map_err(|failure| failure.during("worker_failed"))?;
        if handshake.get("ready").and_then(Value::as_bool) != Some(true) {
            return Err(Failure::new("worker_failed", format!("{script} did not start")));
        }
        Ok(worker)
    }

    fn call(&mut self, request: &Value) -> Result<Value, Failure> {
        self.input
            .write_all(request.to_string().as_bytes())
            .and_then(|_| self.input.write_all(b"\n"))
            .and_then(|_| self.input.flush())
            .map_err(|error| Failure::new("worker_failed", format!("write: {error}")))?;
        self.read_within(WORKER_CALL_TIMEOUT)
    }

    /// Reads one answer, killing the worker if none comes in time. A hung
    /// worker would otherwise block its queue for the rest of the session;
    /// killed, it answers with EOF and is restarted on the next phrase.
    fn read_within(&mut self, limit: Duration) -> Result<Value, Failure> {
        let pid = self.process.id();
        let fired = Arc::new(AtomicBool::new(false));
        let fired_in_watchdog = fired.clone();
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let watchdog = thread::spawn(move || {
            if done_rx.recv_timeout(limit) == Err(mpsc::RecvTimeoutError::Timeout) {
                fired_in_watchdog.store(true, Ordering::SeqCst);
                kill_group(pid);
            }
        });
        let result = self.read();
        let _ = done_tx.send(());
        let _ = watchdog.join();
        if fired.load(Ordering::SeqCst) {
            return Err(Failure::new(
                "worker_timeout",
                format!("no answer in {} s", limit.as_secs()),
            ));
        }
        result
    }

    fn read(&mut self) -> Result<Value, Failure> {
        let mut line = String::new();
        self.output
            .read_line(&mut line)
            .map_err(|error| Failure::new("worker_failed", format!("read: {error}")))?;
        let response: Value = serde_json::from_str(&line)
            .map_err(|_| Failure::new("worker_failed", "worker exited without an answer"))?;
        match response.get("error").and_then(Value::as_str) {
            Some(error) => Err(Failure::new("worker_failed", error)),
            None => Ok(response),
        }
    }
}

impl Drop for LineWorker {
    fn drop(&mut self) {
        kill_group(self.process.id());
        let _ = self.process.kill();
        let _ = self.process.wait();
    }
}

/// Kills a worker's whole process group. The group may already be gone,
/// which is fine and not worth a line on stderr.
fn kill_group(pid: u32) {
    let _ = Command::new("kill")
        .args(["-9", &format!("-{pid}")])
        .stderr(Stdio::null())
        .status();
}

/// Where a target language's voice lives. Russian may use another engine
/// (`voice_backend`); Ukrainian is Piper only.
struct VoiceSpec {
    backend: String,
    path: PathBuf,
    speaker: String,
}

fn voice_spec(target: &str) -> VoiceSpec {
    let (default_path, default_speaker) = match target {
        "uk" => ("voices/uk_UA-ukrainian_tts-medium.onnx", "mykyta"),
        _ => ("voices/ru_RU-dmitri-medium.onnx", ""),
    };
    let backend = if target == "ru" {
        setting("DUB_VOICE_BACKEND", "/voice_backend", "piper")
    } else {
        "piper".to_owned()
    };
    let variable = format!("DUB_VOICE_{}", target.to_uppercase());
    VoiceSpec {
        backend,
        path: path_setting(&variable, &format!("/voices/{target}"), default_path),
        speaker: setting("", &format!("/voice_speakers/{target}"), default_speaker),
    }
}

fn start_voice(target: &str) -> Result<LineWorker, Failure> {
    let spec = voice_spec(target);
    let path = spec.path.to_string_lossy().into_owned();
    match spec.backend.as_str() {
        "piper" => LineWorker::start("piper_worker.py", &[path, spec.speaker]),
        "vosk" => LineWorker::start(
            "vosk_worker.py",
            &[path, setting("DUB_VOICE_SPEAKER", "/voice_speaker", "male_0")],
        ),
        "macos-say" => LineWorker::start("system_voice_worker.py", &[]),
        other => Err(Failure::new("voice_missing", format!("unknown voice backend {other}"))
            .with("target", target)),
    }
}

fn synthesize(
    voices: &mut HashMap<String, LineWorker>,
    job: &SynthesisJob,
) -> Result<(Vec<u8>, f64), Failure> {
    if !voices.contains_key(&job.into) {
        let voice = start_voice(&job.into).map_err(|failure| failure.during("voice_failed"))?;
        voices.insert(job.into.clone(), voice);
    }
    let result = voices
        .get_mut(&job.into)
        .expect("voice just started")
        .call(&json!({"text": job.translated, "targetDuration": job.duration}))
        .map_err(|failure| failure.during("voice_failed"))
        .and_then(|response| decode_wav(&response));
    if result.is_err() {
        // A worker that answered with garbage is restarted on the next phrase.
        voices.remove(&job.into);
    }
    result
}

fn decode_wav(response: &Value) -> Result<(Vec<u8>, f64), Failure> {
    let encoded = response
        .get("wav")
        .and_then(Value::as_str)
        .ok_or_else(|| Failure::new("voice_failed", "no audio in answer"))?;
    let wav = STANDARD
        .decode(encoded)
        .map_err(|error| Failure::new("voice_failed", format!("bad base64: {error}")))?;
    let duration = response
        .get("duration")
        .and_then(Value::as_f64)
        .ok_or_else(|| Failure::new("voice_failed", "no duration in answer"))?;
    // A header with no samples is valid WAV to Python and undecodable to the
    // browser ("Unable to decode audio data"): reject it here, per phrase.
    if !wav.starts_with(b"RIFF") || wav.len() <= 44 || duration < 0.05 {
        return Err(Failure::new("voice_empty", "empty audio"));
    }
    Ok((wav, duration))
}

fn source_name(language: &str) -> &'static str {
    match language {
        "en" => "English",
        "es" => "Spanish",
        "de" => "German",
        _ => "the original",
    }
}

fn target_name(target: &str) -> &'static str {
    match target {
        "uk" => "Ukrainian",
        _ => "Russian",
    }
}

/// Letters only one of the two target languages has. Small models slip into
/// Russian when asked for Ukrainian (and less often the other way round);
/// such an answer is retried rather than voiced by the wrong-language voice.
fn wrong_language(text: &str, target: &str) -> bool {
    let foreign: &[char] = match target {
        "uk" => &['ы', 'э', 'ъ', 'ё', 'Ы', 'Э', 'Ъ', 'Ё'],
        _ => &['і', 'ї', 'є', 'ґ', 'І', 'Ї', 'Є', 'Ґ'],
    };
    text.chars().any(|character| is_han(character) || foreign.contains(&character))
}

#[derive(Default)]
struct Translator {
    mlx: Option<LineWorker>,
}

impl Translator {
    fn backend() -> String {
        setting("DUB_TRANSLATOR", "/translator", "mlx")
    }

    fn warm(&mut self) {
        if Self::backend() == "mlx" && self.mlx.is_none() {
            self.mlx = start_mlx().ok();
        }
    }

    fn complete(&mut self, system: &str, prompt: &str, temperature: f64) -> Result<String, Failure> {
        if Self::backend() == "ollama" {
            return ollama_complete(system, prompt, temperature);
        }
        if self.mlx.is_none() {
            self.mlx = Some(start_mlx()?);
        }
        let request = json!({"system": system, "prompt": prompt,
            "temperature": temperature, "maxTokens": 240});
        let result = self.mlx.as_mut().expect("worker just started").call(&request);
        if result.is_err() {
            self.mlx = None;
        }
        Ok(result?
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned())
    }

    fn translate(&mut self, job: &TranslationJob) -> Result<String, Failure> {
        let from = source_name(&job.language);
        let into = target_name(&job.into);
        let system = format!(
            "You translate {from} speech into {into} for a video voice-over. Keep the meaning, \
             names and numbers. Use natural, concise spoken {into}. Translate only the current \
             line and output nothing but its translation."
        );
        let prompt = format!(
            "Context before: {}\nCurrent line: {}\nContext after: {}\n\nTranslation of the current line:",
            job.before, job.source, job.after
        );
        let failed = |failure: Failure| failure.during("translation_failed");
        let mut text = clean_translation(&self.complete(&system, &prompt, 0.1).map_err(failed)?);
        if wrong_language(&text, &job.into) {
            let system = format!(
                "Translate into {into} only. Answer in {into} with no other language, \
                 no Chinese characters and no explanations."
            );
            text = clean_translation(
                &self
                    .complete(&system, &format!("Translate: {}", job.source), 0.0)
                    .map_err(failed)?,
            );
        }
        if text.is_empty() || wrong_language(&text, &job.into) {
            return Err(Failure::new("translation_failed", format!("unusable answer: {text}")));
        }
        Ok(text)
    }
}

fn start_mlx() -> Result<LineWorker, Failure> {
    LineWorker::start(
        "translate_worker.py",
        &[setting("DUB_MLX_MODEL", "/mlx_model", DEFAULT_MLX_MODEL)],
    )
}

fn ollama_endpoint() -> Result<String, Failure> {
    let endpoint = setting(
        "DUB_OLLAMA_URL",
        "/ollama_url",
        "http://127.0.0.1:11434/api/generate",
    );
    if (!endpoint.starts_with("http://127.0.0.1:") && !endpoint.starts_with("http://localhost:"))
        || !endpoint.ends_with("/api/generate")
    {
        return Err(Failure::new(
            "config_invalid",
            "ollama_url must point at a local /api/generate",
        ));
    }
    Ok(endpoint)
}

fn ollama_complete(system: &str, prompt: &str, temperature: f64) -> Result<String, Failure> {
    let body = json!({
        "model": setting("DUB_OLLAMA_MODEL", "/ollama_model", DEFAULT_OLLAMA_MODEL),
        "system": system,
        "prompt": prompt,
        "stream": false,
        "think": false,
        "options": {"temperature": temperature, "num_predict": 240}
    });
    let process = Command::new("curl")
        .args([
            "--silent",
            "--show-error",
            "--fail",
            "--max-time",
            "90",
            "--header",
            "Content-Type: application/json",
            "--data-binary",
            "@-",
            &ollama_endpoint()?,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| Failure::new("ollama_unreachable", format!("curl: {error}")))?;
    let response = finish_with_input(process, body.to_string().as_bytes())
        .map_err(|detail| Failure::new("ollama_unreachable", detail))?;
    let parsed: Value = serde_json::from_slice(&response)
        .map_err(|error| Failure::new("translation_failed", format!("ollama answer: {error}")))?;
    Ok(parsed
        .get("response")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned())
}

fn is_han(character: char) -> bool {
    ('\u{3400}'..='\u{9fff}').contains(&character)
}

fn clean_translation(raw: &str) -> String {
    let mut text = raw
        .rsplit_once("</think>")
        .map(|(_, answer)| answer)
        .unwrap_or(raw)
        .to_owned();
    while let Some(start) = text.find("<think>") {
        if let Some(relative_end) = text[start..].find("</think>") {
            text.replace_range(start..start + relative_end + "</think>".len(), "");
        } else {
            text.truncate(start);
            break;
        }
    }
    let mut trimmed = text.trim();
    for label in ["Translation:", "Перевод:", "Переклад:"] {
        trimmed = trimmed.strip_prefix(label).unwrap_or(trimmed).trim();
    }
    trimmed
        .trim_matches(['«', '»', '"', '“', '”'])
        .trim()
        .to_owned()
}

/// Checks everything a session needs before the first phrase is sent, so a
/// missing piece is one clear message instead of every phrase failing.
fn preflight(target: &str) -> Result<Value, Failure> {
    let python = python();
    if !python.is_file() {
        return Err(Failure::new("python_missing", python.display().to_string()));
    }
    let translator = Translator::backend();
    match translator.as_str() {
        "mlx" => {
            let model = setting("DUB_MLX_MODEL", "/mlx_model", DEFAULT_MLX_MODEL);
            let cached = project_dir()
                .join("cache/huggingface/hub")
                .join(format!("models--{}", model.replace('/', "--")));
            if !cached.is_dir() && !Path::new(&model).is_dir() {
                return Err(Failure::new("translation_model_missing", model.clone())
                    .with("model", model));
            }
        }
        "ollama" => ollama_preflight()?,
        other => {
            return Err(Failure::new("config_invalid", format!("unknown translator {other}")))
        }
    }
    let voice = voice_spec(target);
    let present = match voice.backend.as_str() {
        "piper" => {
            voice.path.is_file()
                && PathBuf::from(format!("{}.json", voice.path.display())).is_file()
        }
        "vosk" => voice.path.join("model.onnx").is_file(),
        "macos-say" => true,
        _ => false,
    };
    if !present {
        return Err(Failure::new("voice_missing", voice.path.display().to_string())
            .with("target", target));
    }
    let found = |program: &str| Command::new(program).arg("--version").output().is_ok();
    Ok(json!({
        "translator": translator,
        "voice": voice.path.file_name().map(|name| name.to_string_lossy().into_owned()),
        "recognition": {"ffmpeg": found("ffmpeg"), "jsRuntime": found("deno")},
    }))
}

fn ollama_preflight() -> Result<(), Failure> {
    let tags = ollama_endpoint()?.replace("/api/generate", "/api/tags");
    let process = Command::new("curl")
        .args(["--silent", "--show-error", "--fail", "--max-time", "5", &tags])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| Failure::new("ollama_unreachable", format!("curl: {error}")))?;
    let response = finish_with_input(process, b"")
        .map_err(|detail| Failure::new("ollama_unreachable", detail))?;
    let parsed: Value = serde_json::from_slice(&response)
        .map_err(|_| Failure::new("ollama_unreachable", "bad model list"))?;
    let model = setting("DUB_OLLAMA_MODEL", "/ollama_model", DEFAULT_OLLAMA_MODEL);
    let found = parsed
        .get("models")
        .and_then(Value::as_array)
        .is_some_and(|models| {
            models
                .iter()
                .any(|item| item.get("name").and_then(Value::as_str) == Some(&model))
        });
    if !found {
        return Err(Failure::new("ollama_model_missing", model.clone()).with("model", model));
    }
    Ok(())
}

fn transcribe_video(job: &TranscriptionJob, cancel: mpsc::Receiver<()>) -> Result<Value, Failure> {
    let failed = |detail: String| Failure::new("recognition_failed", detail);
    let script = project_dir().join("worker/transcribe_video.py");
    let cache = project_dir().join("cache");
    fs::create_dir_all(&cache).map_err(|error| failed(format!("cache: {error}")))?;
    // The answer goes through files, not pipes: a transcript can be larger
    // than a pipe buffer, and the process is polled for cancellation.
    let tag = format!("{}-{}-{}", job.video_id, job.start, std::process::id());
    let stdout_path = cache.join(format!("{tag}.host.json"));
    let stderr_path = cache.join(format!("{tag}.host.log"));
    let stdout = fs::File::create(&stdout_path).map_err(|error| failed(error.to_string()))?;
    let stderr = fs::File::create(&stderr_path).map_err(|error| failed(error.to_string()))?;
    let cleanup = || {
        let _ = fs::remove_file(&stdout_path);
        let _ = fs::remove_file(&stderr_path);
    };
    let mut child = Command::new(python())
        .arg(script)
        .arg(&job.video_id)
        .arg(job.start.to_string())
        .arg(job.window.to_string())
        .arg(&job.language)
        .process_group(0)
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|error| failed(format!("spawn: {error}")))?;
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| failed(error.to_string()))?
        {
            break status;
        }
        match cancel.recv_timeout(Duration::from_millis(200)) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                // yt-dlp and ffmpeg run as children of the script: stop them too.
                kill_group(child.id());
                let _ = child.wait();
                cleanup();
                return Err(Failure::new("cancelled", "transcription cancelled"));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    };
    let stdout = fs::read(&stdout_path).map_err(|error| failed(error.to_string()))?;
    let stderr = fs::read_to_string(&stderr_path).unwrap_or_default();
    cleanup();
    if !status.success() {
        return Err(failed(stderr.trim().to_owned()));
    }
    let parsed: Value =
        serde_json::from_slice(&stdout).map_err(|error| failed(format!("answer: {error}")))?;
    if let Some(error) = parsed.get("error").and_then(Value::as_str) {
        // The script names the cause it recognised (download blocked, no
        // ffmpeg, unsupported language...); anything else stays generic.
        let code = match parsed.get("code").and_then(Value::as_str) {
            Some("ffmpeg_missing") => "ffmpeg_missing",
            Some("js_runtime_missing") => "js_runtime_missing",
            Some("youtube_blocked") => "youtube_blocked",
            Some("download_failed") => "download_failed",
            Some("language_unsupported") => "language_unsupported",
            _ => "recognition_failed",
        };
        let mut failure = Failure::new(code, error);
        failure.params = parsed.get("params").cloned().unwrap_or_else(|| json!({}));
        return Err(failure);
    }
    if !parsed.get("segments").is_some_and(Value::is_array) {
        return Err(failed("no segments".into()));
    }
    Ok(parsed)
}

fn finish_with_input(mut process: Child, input: &[u8]) -> Result<Vec<u8>, String> {
    if let Some(mut stdin) = process.stdin.take() {
        stdin
            .write_all(input)
            .map_err(|error| format!("write: {error}"))?;
    }
    let output = process
        .wait_with_output()
        .map_err(|error| format!("wait: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    Ok(output.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_thinking_labels_and_outer_quotes() {
        assert_eq!(
            clean_translation("<think>reasoning</think> Перевод: «Привет, мир»"),
            "Привет, мир"
        );
        assert_eq!(clean_translation("<think>unfinished"), "");
        assert_eq!(clean_translation("Translation: Переклад: «Привіт»"), "Привіт");
        assert_eq!(
            clean_translation("рассуждение</think> Готовый перевод"),
            "Готовый перевод"
        );
    }

    #[test]
    fn detects_answers_in_the_wrong_language() {
        assert!(wrong_language("в那个 период", "ru"));
        assert!(!wrong_language("в тот период", "ru"));
        assert!(wrong_language("Это не украинский", "uk"));
        assert!(!wrong_language("Це українська мова", "uk"));
        assert!(wrong_language("Це українська", "ru"));
    }

    #[test]
    fn validates_requests() {
        let request = json!({"source": "hello", "language": "fr"});
        assert_eq!(
            TranslationJob::parse(json!(1), &request).unwrap_err().code,
            "language_unsupported"
        );
        let german = json!({"source": "Hallo", "language": "de", "into": "uk"});
        let job = TranslationJob::parse(json!(2), &german).unwrap();
        assert_eq!((job.language.as_str(), job.into.as_str()), ("de", "uk"));
        let wrong_target = json!({"source": "Hallo", "into": "pl"});
        assert!(TranslationJob::parse(json!(3), &wrong_target).is_err());
        assert!(TranscriptionJob::parse(&json!({"videoId": "../../etc"})).is_err());
        let job = TranscriptionJob::parse(&json!({"videoId": "cMX-u9ltG5Q",
            "windowSeconds": 5000, "language": "fr"}))
        .unwrap();
        assert_eq!((job.window, job.language.as_str()), (300, "auto"));
        assert_eq!(target_of(&json!({"into": "uk"})), "uk");
        assert_eq!(target_of(&json!({"into": "xx"})), "ru");
    }

    #[test]
    fn failures_keep_timeouts_and_carry_codes() {
        let timeout = Failure::new("worker_timeout", "slow").during("voice_failed");
        assert_eq!(timeout.code, "worker_timeout");
        let crashed = Failure::new("worker_failed", "boom").during("voice_failed");
        assert_eq!(crashed.code, "voice_failed");
        let response = Failure::new("voice_missing", "path")
            .with("target", "uk")
            .response(json!(5));
        assert_eq!(response["code"], "voice_missing");
        assert_eq!(response["params"]["target"], "uk");
        assert_eq!(response["ok"], false);
    }

    #[test]
    fn rejects_empty_wav() {
        let header_only = STANDARD.encode(b"RIFF\0\0\0\0WAVEfmt ");
        let failure = decode_wav(&json!({"wav": header_only, "duration": 0.0})).unwrap_err();
        assert_eq!(failure.code, "voice_empty");
        let mut wav = b"RIFF".to_vec();
        wav.resize(4000, 0);
        let ok = json!({"wav": STANDARD.encode(&wav), "duration": 0.1});
        assert_eq!(decode_wav(&ok).unwrap().1, 0.1);
    }

    #[test]
    fn splits_large_wav_response_into_native_frames() {
        let wav = "A".repeat(1_200_000);
        let response = json!({"id": 7, "ok": true,
            "result": {"translated": "Привет", "duration": 10.0, "wavBase64": wav}});
        let mut bytes = Vec::new();
        send_response(&mut bytes, &response).unwrap();
        let mut cursor = 0;
        let mut parts = Vec::new();
        while cursor < bytes.len() {
            let size = u32::from_le_bytes(bytes[cursor..cursor + 4].try_into().unwrap()) as usize;
            cursor += 4;
            assert!(size <= MAX_OUTGOING);
            let frame: Value = serde_json::from_slice(&bytes[cursor..cursor + size]).unwrap();
            parts.push(frame["result"]["wavBase64"].as_str().unwrap().to_owned());
            cursor += size;
        }
        assert_eq!(parts.concat(), wav);
        assert_eq!(parts.len(), 3);
    }

    #[test]
    fn splits_large_transcript_into_native_frames() {
        let result = json!({"language": "en", "segments": [
            {"start": 0.0, "end": 8.0, "text": "hello ".repeat(200_000)}
        ]});
        let response = json!({"id": "transcription", "ok": true, "result": result});
        let mut bytes = Vec::new();
        send_response(&mut bytes, &response).unwrap();
        let mut cursor = 0;
        let mut chunks = Vec::new();
        while cursor < bytes.len() {
            let size = u32::from_le_bytes(bytes[cursor..cursor + 4].try_into().unwrap()) as usize;
            cursor += 4;
            assert!(size <= MAX_OUTGOING);
            let frame: Value = serde_json::from_slice(&bytes[cursor..cursor + size]).unwrap();
            chunks.push(frame["resultJsonBase64"].as_str().unwrap().to_owned());
            cursor += size;
        }
        let decoded = STANDARD.decode(chunks.concat()).unwrap();
        let recovered: Value = serde_json::from_slice(&decoded).unwrap();
        assert_eq!(recovered, result);
        assert!(chunks.len() > 1);
    }
}
