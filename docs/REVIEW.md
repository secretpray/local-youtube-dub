# Critical review

Date: 25 September 2026, version 0.3.0; Linux and Windows sections updated 26 September 2026.

**What was checked:**

- all code in the extension, the host and the Python workers, the install scripts, the tests;
- real YouTube videos: `cMX-u9ltG5Q` (English, no subtitles) and `WADUe-zUE4U` (English, auto-dubbed by YouTube into 20 languages);
- dubbing into Russian and into Ukrainian;
- Linux: Ubuntu 26.04 ARM in a UTM virtual machine, with Playwright's Chromium and the snap Chromium;
- Windows: Windows 11 Pro ARM64 (build 26200) in a Parallels virtual machine on the same M1 Pro, 4 cores and 6 GB, with Edge and Playwright's Chromium.

## Summary

The project does what it promises: it dubs English, Spanish and German videos into Russian or Ukrainian, entirely on the user's own computer (macOS, Linux or Windows), with a four-language interface.

The architecture took these extensions without rework: a new dubbing language is a voice and two entries in lists, a new interface language is a dictionary.

Maintainability took a step forward: errors carry codes, and tests check that every code has a message in every language. The mistake of showing the viewer a raw yt-dlp log can no longer slip through unnoticed.

Main risks:

- dependence on YouTube internals, now including the JavaScript challenge YouTube requires before it serves audio, and the player API the subtitles are loaded through;
- memory: 8 GB of RAM in practice;
- speed on the CPU (Linux, Windows): a 4-core machine keeps up only barely;
- Windows x64 has not been run on a real machine, and the project's own Windows builds (the host, llama-server for older ARM processors) exist only once CI has run;
- no tests for how `content.js` applies decisions to the video.

## Measurements

M1 Pro, 16 GB. The host was started with a bare `PATH`, as the browser starts it.

| What | Value | How measured |
|---|---|---|
| Status check | 0.4 s | `scripts/probe-host.py --bare-env` |
| First phrase of a session | 5.4–5.8 s (loading the translation model) | same, `--into ru` and `--into uk` |
| Each following phrase | ≈ 0.7 s | same |
| Recognizing a 180 s section | 6.7 s with the audio already downloaded | `transcribe` request |
| Downloading audio and recognizing a new section | 17.9 s (8.5-minute video) | `WADUe-zUE4U`, window 3:00–6:00 |
| Host memory with models loaded | ≈ 1.5 GB RSS | `ps` during a session |
| Ukrainian speech vs. the phrase in the video | up to 1.2× longer (13.5 s of voice for 11 s) | e2e session journal |

Not measured: translation quality on a reference set, Whisper's memory during recognition, audio downloads for multi-hour videos.

## Fixed in this cycle

| # | Severity | Problem | Fix | Verified |
|---|---|---|---|---|
| 1 | high | Recognition failed with `HTTP Error 403`: yt-dlp needs a JavaScript runtime to get YouTube's audio URL | Deno in `.venv` from PyPI, `yt-dlp[default]`, `.venv/bin` first on the host's `PATH` | `WADUe-zUE4U`: download and recognition with a bare `PATH` |
| 2 | high | Long phrases were skipped with "Unable to decode audio data": chunked audio was joined after the first part, because `.some()` skips the holes of `new Array(n)` | `collectChunk` counts the parts received; same for large transcripts | test, and an e2e run in Ukrainian: 0 skipped phrases instead of 4 |
| 3 | high | The Ukrainian voice is trained on letters and silently dropped capitals, digits and Latin words ("Rails", "20") | text normalization in `piper_worker.py`: lower-case Cyrillic, numbers spelled out | voice-over with nothing dropped |
| 4 | medium | The panel showed yt-dlp's multi-line English log | error codes in the host and Python, messages in the interface language, a one-line cause | code tests, error previews |
| 5 | medium | The model could answer in Russian instead of Ukrainian | check for the other language's letters, one retry with a strict instruction | `wrong_language` test |
| 6 | low | Cancelling recognition left yt-dlp and ffmpeg running | recognition runs in its own process group, cancelling kills the whole group | code |
| 7 | high | YouTube subtitles were never loaded: without the `pot` token YouTube returns an empty answer | loading through the player, choosing the original-speech track, waiting for ads to end | regular Chrome, `WADUe-zUE4U`: source "YouTube subtitles" |

## Open issues

Ordered by severity.

### 1. Dependence on YouTube internals (high)

The project reads data YouTube does not publish as an API:

- `captionTracks` and `json3`;
- the player API used to load subtitles (`setOption("captions", …)`) and the shape of its requests;
- the player classes `ad-showing` and `ytp-error`;
- the transcript markup;
- whatever yt-dlp parses, now including the JavaScript challenge YouTube requires before serving audio.

This cycle showed what that looks like in practice: a download that worked yesterday answered `403` today, and subtitles silently stopped loading because of a new token requirement.

**Done:**
- `make setup` upgrades `yt-dlp[default]` every time;
- failure causes have distinct codes: `js_runtime_missing`, `youtube_blocked`, `download_failed`;
- if subtitles can't be loaded, the extension falls back to speech recognition: slower, but still working.

**Recommendation:**
- sample YouTube responses in `tests/fixtures/`;
- a short weekly check in a regular browser on a video with subtitles and one without. e2e can't cover the subtitle path: in an automated browser the player requests subtitles for another video.

### 2. Ukrainian voice-over is longer than the original (medium)

The `ukrainian_tts` voice speaks slower, and a Ukrainian translation is longer than the English original. On long phrases the voice runs up to 1.2× longer than its slot in the video. Speed-up is capped at 1.39× to stay intelligible, so the video pauses at phrase boundaries more often.

**Recommendation:**
- give the model a word budget derived from the phrase's duration ("at most N words");
- for Ukrainian, try `length_scale` down to 0.65 and listen for intelligibility.

### 3. Translation quality is not measured (medium)

Qwen3-4B is mostly right, but it produces:

- Russianisms in Ukrainian ("честно" instead of "чесно");
- agreement errors in Russian;
- overly literal phrasing.

The letter check only catches an answer entirely in the wrong language, not single words.

**Recommendation:** a reference set of 10 videos × 20 phrases, rated 1–5 by hand for each language pair. Compare `Qwen3-8B` at 4 bits (about 4.5 GB) on the same set.

### 4. `content.js`: flag-based state without tests (medium)

About 630 lines. Decisions live in `scheduler.js` and are tested; applying them to the video is only checked by hand. The chunk-joining bug (fixed item 2) was exactly that: pure logic inside untested code. It has been moved into `collectChunk` with a test, but the rest of the session is built the same way.

**Recommendation:** extract a session class with adapters for the video and the audio, and run scenarios against a fake `<video>`.

### 5. Recognition: cold start and section boundaries (medium)

- **Whole download.** The audio is downloaded in full before the first section.
- **Model per section.** Whisper is loaded again for every section.
- **Split sentences.** Sentences at the 180 s section boundaries are cut.

**Recommendation:**
- `--download-sections` for the first section;
- a persistent Whisper worker;
- 5 s overlap between sections.

### 6. The host's log is lost (low)

The browser doesn't show the stderr of the host or its workers. Error codes made the messages clear, but the root cause of a model failing to load is only visible from a terminal.

**Recommendation:** write `cache/host.log` with a size limit.

### 7. Other technical debt (low)

- **Timeouts in two places.** The extension waits 45 s for a phrase, the host 40 s for a worker; changing one it is easy to forget the other.
- **"Preparation speed"** in Diagnostics includes time spent queued, so it reads low.
- **Setting name.** The video language is stored under `language`, which is ambiguous next to `into` and `uiLocale`. It can be renamed together with a migration of stored settings.
- **Old names.** The `local-youtube-dub-host` binary and the `org.local_youtube_dub.host` host name predate the current product name.
- **CI written, not yet run.** `.github/workflows/ci.yml` has not had its first run; the runner labels for Windows on ARM and the Visual Studio 2026 image are taken from GitHub's and llama.cpp's current use.
- **The extension's private key** exists in a single copy.

### 8. Platform and resources

macOS, Linux and Windows are supported. Apple Silicon needs about 4.5 GB on disk, Linux and Windows about 3.5 GB. About 1.5 GB of memory per session, and in practice 8 GB of RAM: on a 5 GB Linux VM a browser playing YouTube and the 4B model thrashed, and the first phrases missed their 40 s deadline.

Measured on Linux (Ubuntu 26.04 ARM VM, 4 cores, M1 Pro host): setup 5 min 44 s including the llama.cpp build; ≈ 9 s model load, then ≈ 1.3 s per phrase; downloading audio and recognizing a 180 s section 39.5 s.

Browser run on the same VM with 8 GB and sound: the whole session works (speech recognition, translation, voice, no skips), at about 11 s of preparation per 10 s phrase, so the video pauses more often than on a Mac. Snap Chromium was checked and cannot run the host from its sandbox; it is reported to the viewer and no longer registered.

**Open on Linux:** CPU speed. Options: a smaller model on the CPU (Qwen3-1.7B, faster and weaker), shorter context for CPU backends, or batching phrases.

### 9. Windows

Measured on Windows 11 Pro ARM64 in Parallels on the M1 Pro: 4 cores, 6 GB, with the host started the way the browser starts it (`probe-host.py`), llama.cpp b11193 built for armv8.2 (see below).

| What | Value | How measured |
|---|---|---|
| `setup.ps1` from a clean checkout | 5 min 24 s, 3.1 GB downloaded | second run after a certificate fix, below |
| Status check, models loaded | 3.9–11.4 s, depending on the disk cache | `probe-host.py`; the answer now waits for the models |
| Each phrase, 2 threads (default on 4 cores) | ≈ 2.9 s; ≈ 4–5 s with Edge playing the video | same; prompt 14 tokens/s, generation 11 tokens/s |
| Each phrase, 4 threads | ≈ 2.1 s | `DUB_LLAMA_THREADS=4` |
| Each phrase with `DUB_LLAMA_REPACK=1` | ≈ 1.8 s (2 threads), ≈ 1.3 s (4 threads), but 15–20 s longer to load | same |
| Recognizing a 180 s section, audio downloaded | 57–60 s (124 s the first time after setup, before the warm-up was added to it) | `probe-host.py --transcribe` |
| Memory during a session next to Edge playing YouTube | llama-server up to 2.7 GB working set (mostly the mapped model), voices 0.3 GB, Edge 1.2 GB; free memory fell to 0.15 GB of 6 GB | CIM sampling every 0.5 s |
| Browser session, Edge (native ARM64) | recognition 60 s, models loaded in 71 s, then four phrases in a row with no skips, until YouTube stopped the automated player | `e2e/run.mjs` with `E2E_CHROME` |

Per phrase this is about twice the Linux VM on the same Mac (1.3 s), with the same model, threads and settings. Not established why; the candidates, unmeasured: the build here had no OpenMP (Visual Studio 2022's Clang is too old for llama.cpp's, while CI's build keeps it), the Parallels VM against UTM, and Clang against GCC. On a Snapdragon X, the processor most Windows on ARM machines have, the official build with int8 matrix multiply and 8–10 threads applies instead; that could not be measured here.

**Found and fixed while porting**, each verified in the VM:

| Problem | Fix |
|---|---|
| llama.cpp's official ARM64 build died at load with `0xC000001D` (illegal instruction): it assumes armv8.7 (int8 matrix multiply, bf16), which Apple M1 and Snapdragon 8cx lack | `fetch.py` asks Windows for the features and takes an armv8.2 build of the same release from this project's CI on such processors; the host names the cause if it happens anyway |
| Speech recognition hung for good when started by the host, never outside it | the child inherited the host's stdin, on which the host's main thread sits in a synchronous read; Windows serialises operations on that handle, so Python's start-up check of its stdin waited for the browser. Children get an empty stdin |
| The first recognition after setup took 2 minutes | Windows Defender scanned PyAV's FFmpeg libraries on first import (118 s, then 0.2 s). `setup.ps1` loads every engine once |
| `setup.ps1` failed on huggingface.co with "unable to get local issuer certificate" while GitHub worked | Python reads only root certificates already in the Windows store; `truststore` checks certificates through Windows, which fetches missing roots |
| `setup.ps1` stopped at the first native program writing to stderr, even a pip notice | Windows PowerShell 5.1 turns such lines into terminating errors under `Stop`; native commands are judged by exit code |
| Cyrillic output failed with `UnicodeEncodeError` | children get `PYTHONUTF8=1`; `probe-host.py` sets UTF-8 on its own stdout |
| `llama-server` accepted requests from any web origin without a key | a random key per start, passed in its environment |
| The first phrases of a session missed their 45 s deadline while the model was still loading (on Linux too) | the host answers `status` once the models are loaded; the Edge session above skipped nothing |

Verified besides: killing the host with `TerminateProcess`, as Chrome does, took `llama-server`, the voices and a running recognition with it (Job Objects); the registration works in Edge; the voices sound the same in sherpa-onnx as in piper-tts (their output recognized back by Whisper gives the same words).

**Open on Windows:**

- **x64 was not run.** Same code, packages and pinned builds, compiled and tested only by CI, which has not run yet.
- **The project's own builds don't exist yet.** Until the first tagged release and the `llama-arm64` run, `install-host.ps1` needs Rust, and a processor without int8 matrix multiply needs llama-server built by hand ([DEVELOPMENT.md](DEVELOPMENT.md#llama-server-for-older-arm-processors)).
- **Chrome was not tried with the extension.** Google Chrome no longer loads an unpacked extension from the command line, so it takes the manual steps from the README; Edge, the same Chromium, was run end to end. Nobody listened to the sound on Windows: the checks are the voice's output recognized back, and the session journal.
- **Unsigned programs.** Neither the host nor the downloaded engines are code-signed (code signing is out of scope). Files the scripts create carry no mark of the web, so SmartScreen doesn't stop them.
- **Recognition of an unsupported language** decodes the whole section before saying so (60 s on the VM); the language could be decided from the first stretches of speech.

## What works well

- **Three independent language axes.** Video language, dubbing language and interface language don't depend on each other. Adding a language is half an hour's work, with a checklist in [DEVELOPMENT.md](DEVELOPMENT.md).
- **Errors are data, not text.** The host and Python return codes, and the panel turns them into the interface language. A test won't let a code ship without a message.
- **Languages named in themselves.** In menus and settings each language is written in itself, so people find theirs even in an interface they can't read.
- **Failure isolation.** A phrase is skipped, not the session. A hung worker is restarted, and cancelling kills the whole process group.
- **Portability.** Relative paths, a fixed extension ID, Deno inside `.venv`, installation in two commands.
