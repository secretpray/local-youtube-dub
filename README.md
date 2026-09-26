<p align="center"><img src="extension/icons/lion-128.png" width="96" alt=""></p>

<h1 align="center">YouTube Translate</h1>

<p align="center">Russian and Ukrainian voice-over for YouTube videos in English, Spanish and German.<br>Recognition, translation and voice run on your own computer (macOS, Linux or Windows): no cloud, no subscription.</p>

---

The video plays in the regular YouTube player: the original is turned down and the translation is voiced over it. If the video has subtitles, they are used. If not, the speech is recognized from the audio right on your computer.

| | Languages |
|---|---|
| Video | English, Spanish, German (detected automatically) |
| Voice-over | Russian, Ukrainian |
| Interface | English, Español, Русский, Українська (the browser's language, or your choice) |

## Quick start

| | macOS on Apple Silicon | Linux (x86_64 or ARM), Intel Mac | Windows 10 or 11 on x64, Windows 11 on ARM64 |
|---|---|---|---|
| Engines | MLX | llama.cpp and faster-whisper, on the CPU | llama.cpp (`llama-server`) and sherpa-onnx, on the CPU |
| Memory | 8 GB | 8 GB (5 GB is not enough next to a browser playing YouTube) | 8 GB |
| Disk | about 4.5 GB | about 3.5 GB | about 3.5 GB |
| Speed on the test machines | ≈ 0.7 s per phrase (M1 Pro) | ≈ 1.3 s per phrase (4 cores, VM on M1 Pro) | ≈ 2–3 s per phrase (4 cores, ARM64 VM on M1 Pro) |

**macOS**

```sh
brew install rust ffmpeg python@3.13
```

**Linux (Ubuntu, Debian)**

```sh
sudo apt install cargo ffmpeg cmake build-essential python3-venv python3-dev
```

**Then, on both**

```sh
make setup     # environment, models and voices; everything stays inside this folder
make install   # builds the local app and connects it to your browsers
```

On Linux the first `make setup` compiles llama.cpp, which takes a few minutes.

**Windows**

Python for your processor, then two scripts from the project folder in PowerShell. `-ExecutionPolicy Bypass` applies to that one run and changes no system setting.

```powershell
winget install Python.Python.3.13
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
powershell -ExecutionPolicy Bypass -File scripts\install-host.ps1
```

Nothing is compiled: Python packages come as wheels, llama.cpp and Deno as their official release builds, each download checked against a pinned SHA-256. `install-host.ps1` builds the local app with Rust when it is installed (`winget install Rustlang.Rustup`, plus Visual Studio Build Tools with the C++ workload), and otherwise downloads it from the project's release for this version.

Then in Chrome (or Chromium, Edge, Brave):

1. Open `chrome://extensions` and turn on Developer mode.
2. Click "Load unpacked" and select the `extension` folder.
3. Restart the browser.

## Using it

Open a YouTube video. The **YouTube Translate** panel appears in the bottom-right corner.

| To | Do |
|---|---|
| Start translating | "Turn on translation". The video waits while the first phrases are prepared |
| Hear the original | "Pause": the voice stops and the video keeps playing. "Resume" brings the translation back |
| Stop | "Stop" |
| Choose the voice-over language | Settings → "Translate into": Русский or Українська |
| Correct the video language | Settings → "Video language", if auto-detection got it wrong |
| Change the interface language | the globe in the panel header |
| Get the panel out of the way | "—" collapses it into a lion button; "×" stops translating and hides it |
| Bring a hidden panel back | the extension's icon in the browser toolbar |
| Move the panel | drag the header or the collapsed button; double-click the header to send it back to the corner |

Languages can be changed while translation is off. By default the voice-over is Ukrainian if the interface is Ukrainian, and Russian otherwise.

## Troubleshooting

Every message is shown in the interface language, and details are always under Diagnostics → Copy log.

| Message | What to do |
|---|---|
| "The local app is not installed" | run `make install` (Windows: `scripts\install-host.ps1`) and restart the browser |
| "… is not downloaded" / "… is not installed" / "No voice for …" / "yt-dlp needs deno …" | run `make setup` (Windows: `scripts\setup.ps1`) |
| "YouTube refused the download (bot check)" | wait and try again later; videos with subtitles are not affected |
| "The YouTube player showed an error" | reload the page and turn translation on again |
| "No subtitles — recognizing speech…" takes long | the first run on a video downloads its audio; the time depends on the video's length |
| Phrases are skipped | open Diagnostics: it shows the reason for the last skip |
| You moved the project folder | `make install` (Windows: `scripts\install-host.ps1`), then remove the extension in `chrome://extensions` and load it again from the new location |
| Windows: every phrase is skipped, and the journal says the processor lacks instructions llama-server needs | run `scripts\setup.ps1` again: it picks the llama.cpp build for the processor |
| Windows: the first recognition after setup is slow | Windows Defender checks new libraries on first load; `setup.ps1` loads them once for that reason, and a later run is not affected |

## Local app settings

`bin/config.json` is written by `make install` (`install-host.ps1` on Windows). Paths in it are relative to the project folder.

| Key | Default | Purpose |
|---|---|---|
| `translator` | `mlx` on Apple Silicon, `llama-server` on Windows, `llama` elsewhere | built-in translation: MLX, llama.cpp through its Python binding (`llama`) or its own server (`llama-server`); `ollama` to use a running Ollama |
| `mlx_model` | `mlx-community/Qwen3-4B-Instruct-2507-4bit` | translation model for MLX |
| `llama_model` | `unsloth/Qwen3-4B-Instruct-2507-GGUF/Qwen3-4B-Instruct-2507-Q4_K_M.gguf` | translation model for llama.cpp: `org/repo/file` or a local `.gguf` path |
| `llama_server` | `tools/llama/llama-server(.exe)` | the `llama-server` program, for `translator: llama-server`; when set, setup doesn't download one |
| `asr` | `mlx` on Apple Silicon, `sherpa` on Windows, `faster-whisper` elsewhere | speech recognition engine |
| `voice_engine` | `sherpa` on Windows, `piper` elsewhere | what plays the Piper voices: piper-tts or sherpa-onnx |
| `ollama_model`, `ollama_url` | `qwen3:4b-instruct`, `http://127.0.0.1:11434/api/generate` | only with `translator: ollama` |
| `voices.ru`, `voices.uk` | `voices/ru_RU-dmitri-medium.onnx`, `voices/uk_UA-ukrainian_tts-medium.onnx` | Piper voice for each voice-over language |
| `voice_speakers.uk` | `mykyta` | speaker of the Ukrainian model: `mykyta`, `lada` or `tetiana` |

**Another Piper voice.** Run `DUB_VOICE_NAMES="ru_RU-irina-medium" make setup`, then point `voices.ru` at it.

**Translation threads without MLX.** `DUB_LLAMA_THREADS`; by default two fewer than the CPU cores (at least two), leaving room for the browser to decode the video.

**Faster translation on the CPU, at a memory cost.** `DUB_LLAMA_REPACK=1` lets llama.cpp repack the weights into its fastest layout for the processor. On the 4-core ARM64 test VM a phrase took ≈ 1.3–1.8 s instead of 2.1–2.9 s, but loading took 15–20 s longer and the copy stays in memory the system can't reclaim, which is why it is off by default.

**Audio cache size.** Limited by `DUB_AUDIO_CACHE_MB`, 1024 MB by default.

## Limitations

- **Platform.** macOS, Linux and Windows, Chromium-based browsers only. Windows was verified on ARM64; x64 uses the same code and packages, and the CI workflow builds and tests it, but it has not been run on an x64 machine yet.
- **Unsigned programs on Windows.** The local app and the engines are not code-signed. Programs the scripts build or download carry no "downloaded from the internet" mark, so SmartScreen does not stop them; a project folder downloaded as a zip through a browser does carry it, and `setup.ps1` removes it from the programs it installs.
- **Load.** About 1.5 GB of memory while translating (plus the mapped model file on Linux); 8 GB of RAM is the practical minimum.
- **Snap browsers on Linux** (Ubuntu's default Chromium) are not supported: the snap sandbox has its own `/usr`, where the project's Python environment cannot run. The panel says so; use Chrome, Brave or Edge from a `.deb` package.
- **Speed on the CPU.** Without a GPU, a phrase from speech recognition (longer, with context) takes a 4-core machine about as long as the phrase itself, so the video pauses more often between phrases. More cores help directly.
- **Length of Ukrainian speech.** It often runs longer than the original, and then the video pauses briefly between phrases.
- **Depends on YouTube.** The project reads YouTube's internal data; if YouTube changes it, reading subtitles or downloading audio will need an update.

## Documentation

- [Architecture](docs/ARCHITECTURE.md): components, protocol, error codes, voice/video sync, localization, data on disk.
- [Development](docs/DEVELOPMENT.md): commands, tests, debugging, adding a string, a language or an error code.
- [Critical review](docs/REVIEW.md): measurements, what was fixed, open issues.
- [Changelog](CHANGELOG.md).

## Model licenses

Models and voices are downloaded during setup and are not part of the repository: Qwen3 (Apache 2.0), Whisper and faster-whisper (MIT), llama.cpp (MIT), sherpa-onnx (Apache 2.0), onnxruntime (MIT), PyAV (BSD) with the FFmpeg libraries in its wheels (LGPL/GPL), Piper voices (each has its own license, see the voice's model card), Deno (MIT). Check the licenses of the voices you use before distributing a build.
