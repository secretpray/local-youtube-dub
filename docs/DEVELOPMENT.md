# Development

## Environment

You need macOS (Homebrew) or Linux, with:

- Rust (`cargo`), `ffmpeg`, Python 3.11–3.14;
- on Linux and Intel Macs also `cmake` and a C/C++ toolchain, since llama-cpp-python compiles on install;
- Node.js ≥ 18 and npm, for the tests;
- `librsvg`, only to rebuild the icons.

On Ubuntu: `sudo apt install cargo ffmpeg cmake build-essential python3-venv python3-dev nodejs npm`.

Deno doesn't need a separate install: it comes into `.venv` from PyPI.

```sh
make setup      # .venv, models, ru and uk voices
make install    # build the host, write bin/config.json, register with the browsers
```

`make setup` is safe to repeat: it only installs what is missing, and it upgrades yt-dlp every time. Run `make install` after every change to `src/main.rs` and after moving the folder.

## Commands

| Command | What it does |
|---|---|
| `make test` | extension tests (`node --test tests/*.test.js`) and Rust tests (`cargo test`) |
| `make e2e VIDEO=… START=… PHRASES=… INTO=uk FROM=de` | a run on real YouTube (see below) |
| `make preview` | the panel in every state and interface language, as PNGs in `.e2e/` |
| `make icons` | rebuilds the PNG icons from `extension/icons/lion.svg` |
| `make uninstall` | removes the host registration from every browser |
| `make clean` | deletes `target/` and `bin/`; models and cache stay |

## Making changes

- **Extension** (`extension/`). Press ↻ on the extension in `chrome://extensions` and reload the YouTube tab. There is no build step.
- **Host** (`src/main.rs`). Run `make install`. The browser starts a new host process for every session.
- **Python workers** (`worker/`). Changes take effect from the next session.

A new scheduler decision is written as a pure function in `scheduler.js`, together with a test. `content.js` only applies that decision to the video.

### An interface string

1. Add the key to **all four** dictionaries in `extension/i18n.js`. `{name}` placeholders must match across languages.
2. Use the key, not the text, in code:
   - `setStatus("status.x", tone, params)` in `content.js`;
   - `data-i18n="…"` (and `data-i18n-title`, `data-i18n-aria`) in the panel markup.

The tests check that the dictionaries match and that every key used exists.

### An error code

1. In the host: `Failure::new("code", "English detail").with("param", value)`. In `transcribe_video.py`: `DubError("code", detail, param=value)`. A recognition code must also be added to the list of known codes in the host's `transcribe_video()`.
2. Add `error.code` to every dictionary.
3. Add a row to the error table in [ARCHITECTURE.md](ARCHITECTURE.md#errors).

A test catches any code without a message.

### An interface language

1. Add the code to `LOCALES` and a dictionary to `MESSAGES` (`i18n.js`).
2. Add the language's own name to `ENDONYMS`.
3. Add `extension/_locales/<code>/messages.json`.

### A video or dubbing language

**Video language.**

1. Add the code to `SOURCES` (`main.rs`, `panel.js`), to `LANGUAGES` (`transcribe_video.py`) and to the track filter (`pickTrack` in `subtitles.js`).
2. Add its name to `source_name`.

**Dubbing language.**

1. Add the code to `TARGETS` (`main.rs`, `panel.js`).
2. Add a default voice to `voice_spec`, to `setup.sh` and to the migration in `install-host.sh`.
3. Add its name to `target_name` and, if needed, letters for the `wrong_language` check.
4. Try it with `scripts/probe-host.py --into <code>`.

## Tests

- **`tests/extension.test.js`** covers:
  - subtitle parsing, phrase grouping, track choice, loading subtitles through the player;
  - the scheduler, recognition windows, joining chunked answers, the no-speech filter;
  - dictionaries, keys and error codes.
- **Tests in `src/main.rs`** cover:
  - splitting large answers, cleaning the model's answer;
  - detecting the answer's language, error codes, input validation, rejecting empty audio.
- **e2e** (`e2e/run.mjs`):
  1. starts Chrome for Testing with its own profile in `.e2e/profile`;
  2. registers the host for that profile only;
  3. sets `--into` and `--from` in the extension's settings;
  4. turns translation on through the service worker and prints the panel state every second;
  5. prints the session journal at the end.

  `E2E_CHROME` sets the browser path; by default it is Playwright's own Chromium for the OS (`make e2e` installs it). On a Linux desktop running Wayland, export `WAYLAND_DISPLAY` and `XDG_RUNTIME_DIR` to see the window. YouTube stops playback in an automated browser after about a minute; that is not an extension bug. In that browser the player also requests subtitles for the wrong video, so the subtitle path can only be checked in a regular Chrome.

## Testing on Linux

A UTM virtual machine with Ubuntu works well: copy the tracked files over (`git ls-files | rsync --files-from=- . vm:project/`), then run `make setup`, `make install`, `make test` and `scripts/probe-host.py --bare-env` inside it. Give the VM at least 8 GB of memory for the browser run: with 5 GB a browser playing YouTube and the 4B model thrash.

## Debugging

- **Session journal.** Diagnostics → Copy log. It holds the video URL, the metrics and the last 60 events. Skip reasons are written as a code plus an English detail, e.g. `skip 3:51: reason.decode Unable to decode audio data`, and the subtitle source as e.g. `subtitles: caption-track en via player`.
- **Host without a browser.** `.venv/bin/python scripts/probe-host.py [--from en|es|de] [--into ru|uk] [--bare-env]` talks to the host the way the browser does and prints how long each answer took. `--bare-env` starts the host with a bare `PATH`, as the browser does.
- **Python worker errors** go to the host's stderr, which the browser doesn't show. Run a worker on its own, e.g. `.venv/bin/python worker/piper_worker.py voices/uk_UA-ukrainian_tts-medium.onnx mykyta`, and send it a JSON line.
- **Exit code 137** from the host means macOS killed a binary that was overwritten in place. `make install` copies it and renames it into place; don't `cp` over `bin/local-youtube-dub-host`.

## Extension key

The ID `gaogomdebhnfgajgcpahcmdjfmelkhij` is derived from the public key in the `key` field of `extension/manifest.json`. The private key `.e2e/extension-key.pem` is not in the repository. It is only needed to pack a `.crx` or to publish, so keep a backup elsewhere: without it the ID changes on publishing.

## Releasing

1. Bump `version` in `extension/manifest.json` and `Cargo.toml`, and record the changes in [CHANGELOG.md](../CHANGELOG.md).
2. Run `make test`, `make preview` and short `make e2e` runs with `INTO=ru` and `INTO=uk`.
3. Check by hand in your own browser:
   - a video with subtitles and one without;
   - seeking, pause, stop, dragging;
   - switching the interface language.

## Conventions

- **Language.** All documentation and code comments are in English. Interface text for viewers lives only in `i18n.js`, in every supported language.
- **Comments.** They explain why, not what. Next to a non-obvious fix, a comment says what broke without it.
- **No native `<select>`.** The panel has none: in a dark theme they are drawn by the system. Choices are buttons and a custom menu.
