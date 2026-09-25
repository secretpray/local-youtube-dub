# Critical review

Date: 25 September 2026, version 0.3.0; Linux section updated 26 September 2026.

**What was checked:**

- all code in the extension, the host and the Python workers, the install scripts, the tests;
- real YouTube videos: `cMX-u9ltG5Q` (English, no subtitles) and `WADUe-zUE4U` (English, auto-dubbed by YouTube into 20 languages);
- dubbing into Russian and into Ukrainian;
- Linux: Ubuntu 26.04 ARM in a UTM virtual machine, with Playwright's Chromium and the snap Chromium.

## Summary

The project does what it promises: it dubs English, Spanish and German videos into Russian or Ukrainian, entirely on the user's own computer (macOS or Linux), with a four-language interface.

The architecture took these extensions without rework: a new dubbing language is a voice and two entries in lists, a new interface language is a dictionary.

Maintainability took a step forward: errors carry codes, and tests check that every code has a message in every language. The mistake of showing the viewer a raw yt-dlp log can no longer slip through unnoticed.

Main risks:

- dependence on YouTube internals, now including the JavaScript challenge YouTube requires before it serves audio, and the player API the subtitles are loaded through;
- memory: 8 GB of RAM in practice, and Windows is not supported yet;
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
- **No CI.**
- **The extension's private key** exists in a single copy.

### 8. Platform and resources

macOS and Linux are supported; Windows is not yet. Apple Silicon needs about 4.5 GB on disk, Linux about 3.5 GB. About 1.5 GB of memory per session, and in practice 8 GB of RAM: on a 5 GB Linux VM a browser playing YouTube and the 4B model thrashed, and the first phrases missed their 40 s deadline.

Measured on Linux (Ubuntu 26.04 ARM VM, 4 cores, M1 Pro host): setup 5 min 44 s including the llama.cpp build; ≈ 9 s model load, then ≈ 1.3 s per phrase; downloading audio and recognizing a 180 s section 39.5 s.

Browser run on the same VM with 8 GB and sound: the whole session works (speech recognition, translation, voice, no skips), at about 11 s of preparation per 10 s phrase, so the video pauses more often than on a Mac. Snap Chromium was checked and cannot run the host from its sandbox; it is reported to the viewer and no longer registered.

**Open on Linux:** CPU speed. Options: a smaller model on the CPU (Qwen3-1.7B, faster and weaker), shorter context for CPU backends, or batching phrases.

## What works well

- **Three independent language axes.** Video language, dubbing language and interface language don't depend on each other. Adding a language is half an hour's work, with a checklist in [DEVELOPMENT.md](DEVELOPMENT.md).
- **Errors are data, not text.** The host and Python return codes, and the panel turns them into the interface language. A test won't let a code ship without a message.
- **Languages named in themselves.** In menus and settings each language is written in itself, so people find theirs even in an interface they can't read.
- **Failure isolation.** A phrase is skipped, not the session. A hung worker is restarted, and cancelling kills the whole process group.
- **Portability.** Relative paths, a fixed extension ID, Deno inside `.venv`, installation in two commands.
