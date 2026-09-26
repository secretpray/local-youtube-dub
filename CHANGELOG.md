# Changelog

## Unreleased

### Added

- **Windows support**, x64 and ARM64, with nothing compiled on the user's machine: `scripts\setup.ps1` and `scripts\install-host.ps1` (Windows PowerShell 5.1, `-ExecutionPolicy Bypass` for the one run). Verified on Windows 11 ARM64 in Parallels; x64 is built by CI only.
  - Translation runs in **`llama-server`**, llama.cpp's official release build, as a sidecar the host starts on a free loopback port with a per-session API key, and restarts if it dies. New translator backend `llama-server`, usable on macOS and Linux too.
  - Recognition and voices run on **sherpa-onnx**: Whisper small (int8 ONNX) with Silero VAD, and the same Piper voices, converted for sherpa on first use. Audio is decoded with PyAV, so Windows needs no ffmpeg.
  - `scripts/fetch.py` downloads llama-server, Deno, espeak-ng data, voices and models, each checked against a pinned SHA-256. On ARM64 processors without int8 matrix multiply (Apple M1 under Parallels, Snapdragon 8cx), where llama.cpp's official ARM64 build dies with an illegal instruction, it takes a baseline build published by this project's CI instead.
  - The host is registered through the registry for Chrome, Edge, Brave and Chromium, and is built with cargo or downloaded from the release, checked against GitHub's SHA-256.
  - Workers run in Job Objects: a worker's whole process tree dies with it, and with the host, however the host ends.
- **CI** (`.github/workflows/ci.yml`): tests and lints on Linux, macOS, Windows x64 and Windows ARM64; tagged releases publish the host for six targets. `.github/workflows/windows-install.yml`, run by hand, installs everything from nothing on Windows x64 and ARM64 and has the host translate, voice and recognize speech.
- Messages that tell the viewer to run a command name the command of their own system (`make setup`, `scripts\setup.ps1`, `brew install ffmpeg`, `sudo apt install ffmpeg`). New error `translator_missing`.
- `scripts/probe-host.py --transcribe VIDEO_ID [--start S]` recognizes one section through the host.
- **Linux support**, which also covers Intel Macs: translation through llama.cpp (the same Qwen3-4B as GGUF) and recognition through faster-whisper, both on the CPU. Verified on ARM (Ubuntu 26.04 in UTM); x86_64 uses the same packages. `setup.sh` picks the engines and packages by platform (`requirements-apple-silicon.txt`, `requirements-cpu.txt`), and `install-host.sh` (renamed from `install-host-macos.sh`) registers the host with Linux browsers and removes it with `--uninstall`.
- On the CPU, llama.cpp uses two threads fewer than there are cores, leaving room for the browser to decode the video (`DUB_LLAMA_THREADS` overrides).
- Python 3.14 is accepted.
- A snap browser (Ubuntu's Chromium) is detected and reported: its sandbox cannot run the local app, so it is not registered either.
- `make install` builds and configures the host even when no supported browser is installed.

### Changed

- The host talks to Ollama through a built-in HTTP client instead of starting `curl` for every request.
- The two voice workers share their protocol and text preparation (`worker/voice_common.py`).

### Fixed

- **The first phrases of a session could be skipped on slower machines**: their 45 s clock started while the translation model was still loading. The host now answers the status check once the models are loaded.
- **Model downloads could stall forever** in `make setup` (the Hugging Face Xet backend on a Linux VM). Downloads now use plain HTTP.
- **On Linux the host could take the browser down with it** when memory ran out: llama.cpp's weight repacking is turned off, and the translation model no longer loads while speech is being recognized.
- Cancelled speech recognition left its audio clip (about 6 MB) in `cache/` for good. Clips older than an hour are now removed.
- `make test` failed to start its JavaScript tests on Node 22.

## 0.3.0 — 25 September 2026

### Added

- **Ukrainian voice-over.** Piper voice `uk_UA-ukrainian_tts-medium`, speaker `mykyta` by default. The dubbing language is chosen in the panel's settings under "Translate into".
- **Translation from German**, both from subtitles and through speech recognition.
- **Four interface languages:** English, Español, Русский, Українська. The browser's language by default, with a globe menu in the panel header to choose. The extension's description is translated through `_locales`.
- **Error codes.** Every error from the local app carries a code and is shown as a clear message in the interface language; the English detail goes to the journal.
- **One voice per language**, and a migration of `bin/config.json`: the `voice` key is replaced by `voices.ru` and `voices.uk`.
- `make preview`, plus `INTO` and `FROM` for `make e2e`.

### Removed

- The Vosk TTS and macOS system voice (Milena) engines: Piper voices only. `make install` drops their old settings from `bin/config.json`.

### Fixed

- **YouTube subtitles were never used.** The extension silently fell back to speech recognition: YouTube answers a subtitle request without the `pot` token with an empty body. Subtitles are now loaded through the player itself, which has the token. For auto-dubbed videos the original-speech track is chosen, and during an ad the extension waits for it to end.
- **Recognition of videos without subtitles failed with `HTTP Error 403`.** YouTube now requires running its JavaScript to get the audio URL. Deno is installed into `.venv` together with `yt-dlp[default]`.
- **The panel showed yt-dlp's multi-line log.** It now shows a single cause.
- **Long phrases were skipped with "Unable to decode audio data".** Chunked audio was joined after its first part.
- **The Ukrainian voice swallowed capitals, digits and Latin words.** Text is now normalized before voicing.
- **Translation into the wrong language.** If the model answers in Russian instead of Ukrainian (or the other way round), the translation is retried.
- **Cancelling recognition** left yt-dlp and ffmpeg running.
- **Near the top edge the panel opened its sections off-screen**, and could then be neither dragged nor collapsed. Now:
  - the panel is pinned to the nearest window edge and grows away from it;
  - it is never taller than the window: the sections scroll inside;
  - its position is refitted on every size change.

## 0.2.0 — 25 September 2026

### Added

- **Translation without Ollama.** Qwen3-4B runs through MLX inside the local app. Ollama stays optional (`translator: ollama`).
- **New panel.** "Turn on translation", "Pause" and "Stop" buttons, a status line, a voice-over buffer bar and the current phrase. "Settings" and "Diagnostics" collapse.
- **Panel handling.** The panel collapses into a button, can be dragged and remembers its position. The extension's toolbar icon hides and shows it.
- **Icon** with a roaring lion.
- **Default voice:** Piper `ru_RU-dmitri-medium`.
- **Speech recognition for videos without subtitles**, in 3-minute sections, with the next one prepared ahead.
- **Session journal** under "Diagnostics".
- **Installation** with `make setup` and `make install`, and a fixed extension ID.

### Fixed

- Translation stopped after a few phrases: the browser started the app without `ffmpeg` on `PATH`.
- After reinstalling, macOS killed the app on launch.
- Translation could silently stall on a lost answer or a hung worker.
- "Stop" was ignored while subtitles were being looked up.
- YouTube ads threw the voice-over off.
- The downloaded-audio cache grew without limit.

## 0.1.0

First working version: Russian voice-over from subtitles through Ollama and Piper.
