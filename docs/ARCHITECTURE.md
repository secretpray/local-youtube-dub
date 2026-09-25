# Architecture

How YouTube Translate is built and why it is built that way. Building, running and testing the project are covered in [DEVELOPMENT.md](DEVELOPMENT.md).

## Components

```mermaid
flowchart LR
  subgraph Browser["Browser (YouTube tab)"]
    Panel["panel.js + i18n.js<br/>panel and interface language"] --- Content["content.js<br/>dubbing session"]
    Content --- Subs["subtitles.js<br/>scheduler.js"]
    Content -- "Port dub-session" --> BG["background.js<br/>service worker"]
  end
  BG -- "Native Messaging<br/>stdin/stdout" --> Host["local-youtube-dub-host<br/>(Rust)"]
  Host --> TW["translate_worker.py<br/>Qwen3-4B: MLX or llama.cpp"]
  Host --> VW["piper_worker.py<br/>one voice per language"]
  Host --> ASR["transcribe_video.py<br/>yt-dlp + deno + Whisper"]
  Host -. "translator: ollama" .-> Ollama["Ollama<br/>(optional)"]
```

| Component | Responsible for | Not responsible for |
|---|---|---|
| `extension/i18n.js` | interface text in four languages, picking the language from the browser | what to show |
| `extension/panel.js` | markup, styles, settings, position, rendering messages in the interface language | dubbing logic |
| `extension/content.js` | the session: phrases, the request queue, keeping the voice in sync with the video | text: it passes message keys |
| `extension/subtitles.js` | reading YouTube subtitles, grouping lines into phrases | playback |
| `extension/scheduler.js` | pure decisions: which phrase to prepare and play, when to pause the video, joining chunked answers | side effects |
| `extension/background.js` | bridge between the tab and the local app, the toolbar icon, requests to the YouTube player | message contents |
| `extension/page-hook.js` | keeps the player's subtitle responses, in the page's own world | everything else |
| `src/main.rs` | the protocol, translation and voice queues, environment checks, on-demand recognition, error codes | the models themselves |
| `worker/*.py` | one model per process, loaded for the whole session | the browser protocol |

Python is there because MLX, llama.cpp's binding, faster-whisper, Piper and yt-dlp are Python libraries. Rust owns the protocol, the queues and isolation: a hung or crashed worker is restarted and the session carries on.

## Platforms

The same models run on every platform; only the engines differ.

| | Apple Silicon | Linux, Intel Mac |
|---|---|---|
| Translation | MLX, `mlx-community/Qwen3-4B-Instruct-2507-4bit` | llama.cpp, `unsloth/Qwen3-4B-Instruct-2507-GGUF` (Q4_K_M) |
| Recognition | MLX Whisper small | faster-whisper small, int8 on the CPU |
| Python packages | `requirements-apple-silicon.txt` | `requirements-cpu.txt` |
| Browser registration | `~/Library/Application Support/<browser>/NativeMessagingHosts` | `~/.config/<browser>/NativeMessagingHosts`; snap browsers are not supported (see below) |

**Snap browsers.** A snap browser starts the host inside its sandbox, where `/usr` is the snap's own and the project's Python environment (a venv pointing at the system Python) cannot run. The host recognizes this from `SNAP_NAME` and answers `sandboxed_browser`, and `install-host.sh` no longer registers snap Chromium.

**Threads.** The browser decodes the video on the same CPU, so llama.cpp uses two threads fewer than there are cores (at least two; `DUB_LLAMA_THREADS` overrides). On 4 cores with 2 kept busy, 2 threads prepared a phrase in about 3.5 s and 4 threads in about 5.5 s.

The host picks the engines at build time (`cfg!(target_os, target_arch)`), and `translator` and `asr` in `bin/config.json` override them. `setup.sh` installs the matching packages and models.

**Memory on Linux.** On ARM, llama.cpp repacks the weights into a CPU-friendly copy by default: 2.8 GB of anonymous memory the kernel cannot reclaim. On a 5 GB machine that got the host OOM-killed, and since the host runs in the browser's systemd scope, systemd stopped the browser too. `translate_worker.py` therefore turns repacking off (`use_extra_bufts = false`), leaving about 0.4 GB anonymous plus the mapped model file, which is reclaimable page cache. Before recognizing speech the extension also asks the host not to warm the translation model up, so Whisper and the translation model never load at the same time.

## Languages

| | Values | Decided by |
|---|---|---|
| Video language (`language`) | `auto`, `en`, `es`, `de` | subtitles: the track's code; recognition: Whisper on the first section |
| Dubbing language (`into`) | `ru`, `uk` | panel setting; follows the interface language by default |
| Interface language (`uiLocale`) | `en`, `es`, `ru`, `uk` | the browser's language, or the globe menu |

The three are independent: a German video can be dubbed into Ukrainian with a Spanish interface.

**Translation prompt.** It is written in English, with the source and target languages passed as parameters. If the answer contains letters of the other target language (`ы э ъ ё` in Ukrainian, `і ї є ґ` in Russian) or Chinese characters, the translation is retried once with a strict instruction. If the retry fails too, the phrase is skipped: a voice for one language must not read text in another.

**Voices.** Each dubbing language has its own Piper voice and its own host process (`voices.ru`, `voices.uk`). The Ukrainian `ukrainian_tts` model is trained on letters rather than espeak phonemes. It silently drops capital letters, digits and Latin script, so `piper_worker.py` first turns the text into lower-case Cyrillic and spells numbers out (`num2words`).

## One phrase end to end

```mermaid
sequenceDiagram
  participant C as content.js
  participant H as host
  participant T as translate_worker
  participant V as piper_worker (into)
  C->>H: translate {id, source, language, into, context, targetDuration}
  H->>T: {system, prompt}
  T-->>H: {text}
  H->>V: {text, targetDuration}
  V-->>H: {wav, duration}
  H-->>C: {id, ok, result: {translated, wavBase64, duration}}
  C->>C: decodeAudioData, waits for the phrase to start in the video
```

- **Pipeline.** Translation and voicing run on two separate host threads. While phrase N is being voiced, phrase N+1 is already being translated.
- **Two requests in flight.** The extension keeps at most two phrases in flight. That keeps the pipeline busy, and a seek doesn't leave stale phrases piled up in the queue.
- **Context.** Every phrase is sent with two neighbouring lines before and after it. Only the current one is translated.
- **Speech rate.** `targetDuration` is how long the phrase lasts in the video. Piper speeds speech up to fit it (`length_scale` no lower than 0.72, i.e. at most 1.39× faster) without changing the pitch.

## Native Messaging protocol

Each message is JSON preceded by a 4-byte little-endian length. The browser may send up to 1 MB per message; the host sends at most 950,000 bytes.

| Request | Fields | Answer |
|---|---|---|
| `status` | `into` | environment check for that dubbing language; on success the host starts loading the models |
| `translate` | `id`, `source`, `language`, `into`, `contextBefore`, `contextAfter`, `targetDuration` | `{translated, wavBase64, duration}` |
| `transcribe` | `id`, `videoId`, `startSeconds`, `windowSeconds`, `language` | `{language, segments[], windowStart, windowEnd}` |

An answer larger than 950,000 bytes is split into parts:

- audio as `result.wavBase64`, in pieces of 500,000 base64 characters;
- other results as `resultJsonBase64`.

Each part carries `chunkIndex` and `chunkCount`. The extension joins them with `DubScheduler.collectChunk`, which counts the parts received instead of looking for gaps. A sparse array used to hide the gaps, and long phrases were decoded truncated.

### Errors

An error looks like `{id, ok: false, code, params, error}`:

- **`code`** selects the message in `i18n.js` (`error.<code>`);
- **`params`** fill in the message;
- **`error`** is an English detail for the journal. It is also shown when this version of the extension doesn't know the code.

An error without an `id` means the connection is gone, and stops the session. An error with an `id` concerns one phrase, which is skipped.

| Code | Raised by | Effect |
|---|---|---|
| `host_missing`, `host_exited`, `connection_lost` | `background.js`: Chrome can't find the host, the host crashed, the port closed | session stopped |
| `python_missing`, `translation_model_missing`, `voice_missing`, `config_invalid`, `ollama_unreachable`, `ollama_model_missing` | the `status` check | session doesn't start |
| `translation_failed`, `voice_failed`, `voice_empty`, `worker_failed`, `worker_timeout` | a single phrase | phrase skipped |
| `ffmpeg_missing`, `js_runtime_missing`, `youtube_blocked`, `download_failed`, `language_unsupported`, `recognition_failed`, `cancelled` | recognition of a section | first section: session doesn't start; later sections: one retry after 10 s, then the section is skipped |
| `bad_request`, `internal` | an invalid request or an internal failure | depends on the request |

The test `every message key and error code used by the code has a text` collects every code in `main.rs`, `transcribe_video.py` and `background.js` and checks that each one has a message.

The host and the Python workers speak JSON lines. A worker first reports `{"ready": true}` or `{"error": ...}`, then answers every request line with one line.

## The session in the extension

```mermaid
stateDiagram-v2
  [*] --> Searching: Turn on translation
  Searching --> Recognizing: no subtitles
  Searching --> Preparing: subtitles found
  Recognizing --> Preparing: section recognized
  Preparing --> Playing: 4 phrases or 20 s of speech ready
  Playing --> WaitingPhrase: next phrase not ready
  WaitingPhrase --> Playing: phrase ready or skipped
  Playing --> Finishing: voice longer than the phrase
  Finishing --> Playing: voice finished
  Playing --> WaitingSection: section not recognized yet
  WaitingSection --> Playing
  Playing --> Paused: Pause
  Paused --> Playing: Resume
  Playing --> [*]: Stop / error
```

Every 80 ms `tick` asks the scheduler (`scheduler.js`) what to do at the current point of the video. The scheduler is made of pure functions, each with tests.

**Sync rules:**

- **Ducking.** While the voice speaks, the original is turned down to the level set in the panel. If the next phrase starts within 1.5 s, the volume stays down; otherwise it would jump on every sentence.
- **Long voice.** The video first slows to 0.9× (pitch preserved). If that's not enough, it pauses at the phrase boundary.
- **Phrase not ready.** The video waits for it. After 45 s without an answer the phrase is skipped.
- **Seeking.** The phrase being spoken is cut off, and the queue is rebuilt from the new position.
- **Ads.** An ad plays in the same `<video>` from 0:00, so the extension steps aside while it runs.
- **Translation paused.** The voice stops, the original plays at full volume, and phrases keep being prepared.
- **Stop and races.** A start-attempt counter cancels a `start()` that resumes after an `await` once Stop has been pressed. Audio decoded after a stop is discarded.
- **Manual volume and speed.** Changes made in the YouTube player are remembered. The extension tells its own changes apart by the value it expects.

## Panel position

The panel is pinned to the window edge it is closer to: by its bottom edge in the lower half, by its top edge in the upper half. An opened section grows away from that edge and never pushes the header out of the window.

The panel is never taller than the window; anything beyond that scrolls inside the sections. A `ResizeObserver` refits the panel into the window on every size change. The position is stored as `{right, top}` or `{right, bottom}`.

## Localization

- **Keys, not text.** `content.js` never builds text. It passes the panel messages of the form `{key, params, fallback}`, and params can be messages themselves: for example, the reason inside a skipped-phrase warning.
- **Re-rendering.** The panel keeps what is on screen as keys: the status, the warning, the metrics. Switching the language from the globe menu re-renders everything at once, without restarting the session.
- **Language names.** Wherever a language is offered as a choice, it is named in that language: English, Español, Deutsch, Русский, Українська. People can find their own language even in an interface they can't read.
- **Manifest.** The extension's description and toolbar tooltip are translated through Chrome's standard `_locales`. Those follow the browser's language rather than the panel's choice, because Chrome shows them outside the page.

## Where the text comes from

1. **A YouTube subtitle track.** The list of tracks comes from the player's data (`captionTracks`), the text in `json3` format with exact start times and durations.
   - **Choosing a track.** Manual subtitles win over automatic ones, and among automatic ones the track of the original audio wins. A video YouTube dubs itself has a recognized track for every dub, and only the original's matches what the speaker says.
   - **Loading through the player.** YouTube only answers a subtitle request that carries the `pot` proof-of-origin token. The player adds it and the extension cannot: a direct request for `baseUrl` returns `200` with an empty body. So `page-hook.js` keeps the player's subtitle responses from the very start of the page load. If the track isn't there yet, the background page asks the player to load it through the player's API (`setOption("captions", "track", …)`), takes the text, and puts the player's subtitle choice back as it was. The direct request remains as a fallback.
   - **Ads.** While an ad plays the player belongs to it and requests the ad's subtitles, so the extension waits for the ad to end.
   - **The page's main world.** The player's data and API are only reachable there, so they are accessed through `chrome.scripting` with `world: "MAIN"`.
2. **The transcript panel on the page.** Used if no track could be loaded.
3. **Speech recognition.** Used when there are no suitable subtitles at all: no English, Spanish or German track, or no track could be loaded.
   - the host downloads the audio track (`yt-dlp`);
   - cuts a 180 s section (`ffmpeg`);
   - recognizes it with Whisper small: MLX Whisper on Apple Silicon, faster-whisper elsewhere.

   To get the audio URL, yt-dlp has to run YouTube's JavaScript, and for that it needs Deno. Deno is installed into `.venv` with the Python packages, and the host puts `.venv/bin` first on `PATH`. Without Deno YouTube answers `403 Forbidden`.

Lines without letters ("♪", "…") and labels such as `[Music]`, `[Musik]`, `[Оплески]` are never voiced.

## Data on disk

Everything lives inside the project folder:

| Path | What | Size | Cleanup |
|---|---|---|---|
| `.venv/` | Python environment with Deno | ~1.6 GB | `make setup` recreates it |
| `cache/huggingface/` | translation and recognition models | ~2.6 GB | manual |
| `voices/` | Piper voices | 60–80 MB per voice | manual |
| `cache/<id>.m4a`, `.webm` | downloaded audio of a video | ~1 MB per minute | oldest removed beyond `DUB_AUDIO_CACHE_MB` (1024) |
| `cache/<id>.asr-<start>-<window>-<lang>.json` | transcript of a section | a few KB | kept |
| `bin/config.json` | host settings | — | `make install` fills in defaults and migrates old keys |

The browser (`chrome.storage.local`) keeps only the panel's settings: languages, volumes, whether text is shown, position, whether the panel is collapsed.

## Trust boundaries

- **Who can talk to the host.** Only the extension with the fixed ID, as listed in `allowed_origins` of the Native Messaging manifest. The ID is derived from the public key in `manifest.json`; the private key is kept outside the repository.
- **Which pages can talk to the extension.** The background page only accepts ports from `https://www.youtube.com/` tabs. The extension has no `externally_connectable`.
- **Input validation.** The host checks everything it receives: a video ID is exactly 11 characters of `[A-Za-z0-9_-]`, phrase and context lengths are capped, languages must be in `SOURCES` and `TARGETS`.
- **The Ollama URL** may only point at `127.0.0.1` or `localhost`.
- **Network.** The translation model is loaded with `HF_HUB_OFFLINE=1`. Only `yt-dlp` (YouTube) and `make setup` (models) go online.

## Reliability

- **Hung worker.** A watchdog on every Python worker call: 120 s to load a model, 40 s to answer. A hung worker is killed together with its process group, the phrase gets `worker_timeout`, and the next phrase starts the worker again. Cancelling recognition also kills the group, yt-dlp and ffmpeg included.
- **Lost answer.** A 45 s timer in the extension: a phrase without an answer is skipped and its slot in the queue is freed.
- **Environment check.** `status` checks Python, the translation model and the voice for the chosen language, and reports whether `ffmpeg` and Deno are present.
- **PATH.** The browser starts the host with a bare `PATH`. The host puts `.venv/bin` first and adds `/opt/homebrew/bin` and `/usr/local/bin`.
