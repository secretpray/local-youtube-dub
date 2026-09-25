# Changelog

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
