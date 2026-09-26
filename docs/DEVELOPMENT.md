# Development

## Environment

You need macOS (Homebrew), Linux or Windows (see [Windows](#windows) below). On macOS and Linux:

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

### Windows

There is no `make`; the two scripts do what `make setup` and `make install` do. For development, Rust and a C++ linker are needed to build the host:

```powershell
winget install Python.Python.3.13 Git.Git OpenJS.NodeJS.LTS Rustlang.Rustup
winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
powershell -ExecutionPolicy Bypass -File scripts\install-host.ps1
```

On ARM64, take care that Python is the ARM64 build (`py -0p` lists `-arm64`): an x64 Python runs emulated, several times slower, with x64 wheels. `setup.ps1` refuses one that doesn't match the processor.

The tests are the same commands without `make`: `node --test tests/extension.test.js` and `cargo test`. `install-host.ps1` replaces a host that a browser is running by renaming it, which Windows allows where overwriting is refused.

Both scripts stay ASCII and run on Windows PowerShell 5.1, the one every Windows has. Two of its habits shape them: it reads a script without a byte order mark in the ANSI code page, and under `$ErrorActionPreference = 'Stop'` it turns any line a native program writes to stderr into a terminating error, even with `2>$null`. So native commands run through `Invoke-Checked`, which judges them by exit code.

## Commands

| Command | What it does |
|---|---|
| `make test` | extension tests (`node --test tests/*.test.js`) and Rust tests (`cargo test`) |
| `make e2e VIDEO=… START=… PHRASES=… INTO=uk FROM=de` | a run on real YouTube (see below) |
| `make preview` | the panel in every state and interface language, as PNGs in `.e2e/` |
| `make icons` | rebuilds the PNG icons from `extension/icons/lion.svg` |
| `make uninstall` | removes the host registration from every browser (Windows: `install-host.ps1 -Uninstall`) |
| `make clean` | deletes `target/` and `bin/`; models and cache stay |

## Making changes

- **Extension** (`extension/`). Press ↻ on the extension in `chrome://extensions` and reload the YouTube tab. There is no build step.
- **Host** (`src/*.rs`). Run `make install` (Windows: `install-host.ps1`). The browser starts a new host process for every session.
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
2. Add a default voice to `voice_spec`, to `setup.sh`, to `VOICES` in `fetch.py` (with its checksums) and to the defaults in `install-host.sh` and `install-host.ps1`.
3. Add its name to `target_name` and, if needed, letters for the `wrong_language` check.
4. Try it with `scripts/probe-host.py --into <code>`.

## Tests

- **`tests/extension.test.js`** covers:
  - subtitle parsing, phrase grouping, track choice, loading subtitles through the player;
  - the scheduler, recognition windows, joining chunked answers, the no-speech filter;
  - dictionaries, keys and error codes.
- **CI** (`.github/workflows/ci.yml`) runs the tests, clippy, a Python syntax check and, on Windows, a PowerShell 5.1 parse of the scripts, on Linux, macOS, Windows x64 and Windows ARM64.
- **Tests in `src/main.rs`** cover:
  - splitting large answers, cleaning the model's answer;
  - detecting the answer's language, error codes, input validation, rejecting empty audio.
- **e2e** (`e2e/run.mjs`):
  1. starts Chrome for Testing with its own profile in `.e2e/profile`;
  2. registers the host for that profile only;
  3. sets `--into` and `--from` in the extension's settings;
  4. turns translation on through the service worker and prints the panel state every second;
  5. prints the session journal at the end.

  `E2E_CHROME` sets the browser path; by default it is Playwright's own Chromium for the OS (`make e2e` installs it). On a Linux desktop running Wayland, export `WAYLAND_DISPLAY` and `XDG_RUNTIME_DIR` to see the window.

  On Windows the host is registered through the registry instead, under the key of the browser being run, and the previous registration is put back when the run ends (not when the process is killed; then run `install-host.ps1` again). Playwright has no ARM64 Chromium for Windows: its x64 one runs emulated, and YouTube's player failed in it. The installed Edge is native and still accepts `--load-extension`: `set E2E_CHROME=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` and `E2E_PROFILE` to a folder of its own. Google Chrome ignores `--load-extension` since version 137. YouTube stops playback in an automated browser after about a minute; that is not an extension bug. In that browser the player also requests subtitles for the wrong video, so the subtitle path can only be checked in a regular Chrome.

## Testing on Linux

A UTM virtual machine with Ubuntu works well: copy the tracked files over (`git ls-files | rsync --files-from=- . vm:project/`), then run `make setup`, `make install`, `make test` and `scripts/probe-host.py --bare-env` inside it. Give the VM at least 8 GB of memory for the browser run: with 5 GB a browser playing YouTube and the 4B model thrash.

## Testing on Windows

A Parallels VM with Windows 11 ARM64 on a Mac was the test machine. Commands run in it with `prlctl exec "Windows 11" --current-user cmd /c "…"`; without `--current-user` they run as SYSTEM, with the wrong `HKCU`. Parallels shares the Mac's home folder as `Z:\`. Copy the sources to a folder on the VM's own disk rather than working on the share, leaving out what setup recreates:

```bat
robocopy "Z:\path\to\project" C:\Users\me\local-youtube-dub /E /XD .venv target cache voices bin tools .e2e .git node_modules
```

`prlctl exec` refuses long command lines; for anything longer than a line, copy a script over and run it with `powershell -File`.

Give the VM 8 GB of memory, as the README asks of any machine. With 6 GB the session in Edge worked, but free memory fell to 0.15 GB and loading the model took over a minute.

### llama-server for older ARM processors

If the processor can't run llama.cpp's official ARM64 build (see [Windows in ARCHITECTURE.md](ARCHITECTURE.md#windows)) and the project's own build is not published for the pinned llama.cpp release yet, build it the same way. With Visual Studio Build Tools including the C++ Clang compiler and CMake (`Microsoft.VisualStudio.Component.VC.Llvm.Clang`, `Microsoft.VisualStudio.Component.VC.CMake.Project`), in the llama.cpp checkout of the release named `LLAMA_BUILD` in `scripts/fetch.py`:

```bat
powershell -Command "(Get-Content cmake\arm64-windows-llvm.cmake) -replace '-march=armv8.7-a', '-march=armv8.2-a+dotprod+fp16' | Set-Content cmake\arm64-windows-baseline.cmake"
"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" arm64
cmake -S . -B build -G Ninja -D CMAKE_BUILD_TYPE=Release -D CMAKE_TOOLCHAIN_FILE=cmake/arm64-windows-baseline.cmake -D GGML_NATIVE=OFF -D GGML_BACKEND_DL=ON -D GGML_OPENMP=OFF -D LLAMA_OPENSSL=OFF -D LLAMA_USE_PREBUILT_UI=OFF -D LLAMA_BUILD_TESTS=OFF -D LLAMA_BUILD_EXAMPLES=OFF
cmake --build build --target llama-server
```

Copy `build\bin\*` into a folder of the project other than `tools\llama` (setup replaces that one), say `tools\llama-local\`, and set `"llama_server": "tools/llama-local/llama-server.exe"` in `bin/config.json`; setup then leaves llama-server alone. `GGML_OPENMP=OFF` is needed with the Clang of Visual Studio 2022: llama.cpp's OpenMP needs Clang 20. The CI build uses Visual Studio 2026 and keeps OpenMP on, as llama.cpp's own release does. To publish that build, run the workflow by hand with `llama_build` set.

## Debugging

- **Session journal.** Diagnostics → Copy log. It holds the video URL, the metrics and the last 60 events. Skip reasons are written as a code plus an English detail, e.g. `skip 3:51: reason.decode Unable to decode audio data`, and the subtitle source as e.g. `subtitles: caption-track en via player`.
- **Host without a browser.** `.venv/bin/python scripts/probe-host.py [--from en|es|de] [--into ru|uk] [--bare-env]` talks to the host the way the browser does and prints how long each answer took. `--bare-env` starts the host with a bare `PATH`, as the browser does.
- **Python worker errors** go to the host's stderr, which the browser doesn't show. Run a worker on its own, e.g. `.venv/bin/python worker/piper_worker.py voices/uk_UA-ukrainian_tts-medium.onnx mykyta`, and send it a JSON line.
- **Exit code 137** from the host means macOS killed a binary that was overwritten in place. `make install` copies it and renames it into place; don't `cp` over `bin/local-youtube-dub-host`.
- **llama-server** writes `cache/llama-server.log`, overwritten on each start; a failure to start carries its last lines. `DUB_LLAMA_SERVER` and `DUB_TRANSLATOR=llama-server` run it on macOS or Linux too, with the server from the llama.cpp release for that system.
- **Recognition of one section** without a browser: `scripts/probe-host.py --transcribe VIDEO_ID --start 600`.

## Extension key

The ID `gaogomdebhnfgajgcpahcmdjfmelkhij` is derived from the public key in the `key` field of `extension/manifest.json`. The private key `.e2e/extension-key.pem` is not in the repository. It is only needed to pack a `.crx` or to publish, so keep a backup elsewhere: without it the ID changes on publishing.

## Releasing

1. Bump `version` in `extension/manifest.json` and `Cargo.toml`, and record the changes in [CHANGELOG.md](../CHANGELOG.md).
2. Run `make test`, `make preview` and short `make e2e` runs with `INTO=ru` and `INTO=uk`.
3. Push the tag `v<version>`: CI publishes the host for Windows, macOS and Linux on that release, which `install-host.ps1` downloads when Rust is not installed. After moving `LLAMA_BUILD` in `fetch.py` to a newer llama.cpp release, run the workflow by hand with `llama_build` set to it, so older ARM processors have a build too.
4. Check by hand in your own browser:
   - a video with subtitles and one without;
   - seeking, pause, stop, dragging;
   - switching the interface language.

## Conventions

- **Language.** All documentation and code comments are in English. Interface text for viewers lives only in `i18n.js`, in every supported language.
- **Comments.** They explain why, not what. Next to a non-obvious fix, a comment says what broke without it.
- **No native `<select>`.** The panel has none: in a dark theme they are drawn by the system. Choices are buttons and a custom menu.
- **Commands in messages.** A message that tells the viewer to run something uses `{setup}`, `{install}` or `{ffmpeg}`, which `i18n.js` spells for the viewer's system.
