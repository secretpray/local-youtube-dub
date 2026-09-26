#!/bin/sh
# Builds the native host, writes bin/config.json and registers the host with
# Chromium browsers on macOS or Linux. The extension ID comes from the "key"
# in manifest.json, so it is the same on every machine and never has to be
# copied by hand.
#
#   sh scripts/install-host.sh [BROWSER ...]     register (default: every installed browser)
#   sh scripts/install-host.sh --uninstall       remove the registration everywhere
#
# Browsers: chrome, chromium, brave, edge. Snap Chromium is not supported (its
# sandbox cannot run the project's Python environment); --uninstall still
# removes a registration an older version wrote for it.
# Re-run after moving the folder: the registration holds an absolute path.
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if [ "${1:-}" != --uninstall ]; then
  [ -x "$PROJECT_DIR/.venv/bin/python" ] || { echo "Run make setup first" >&2; exit 2; }
  cargo build --release --quiet --manifest-path "$PROJECT_DIR/Cargo.toml"
  mkdir -p "$PROJECT_DIR/bin"
  # Copy then rename: overwriting a running or signature-cached binary in place
  # makes macOS kill it on the next launch (exit 137).
  cp "$PROJECT_DIR/target/release/local-youtube-dub-host" "$PROJECT_DIR/bin/.local-youtube-dub-host.new"
  mv -f "$PROJECT_DIR/bin/.local-youtube-dub-host.new" "$PROJECT_DIR/bin/local-youtube-dub-host"
fi

python3 - "$PROJECT_DIR" "$@" <<'PY'
import base64
import hashlib
import json
import pathlib
import platform
import shutil
import sys

project = pathlib.Path(sys.argv[1])
args = sys.argv[2:]
home = pathlib.Path.home()
HOST = "org.local_youtube_dub.host"

# Where each browser reads native messaging manifests, and how to tell it is
# installed. Snap Chromium keeps its profile, and so the manifest, inside the
# snap's own directory.
if platform.system() == "Darwin":
    support = home / "Library/Application Support"
    browsers = {
        "chrome": (support / "Google/Chrome", pathlib.Path("/Applications/Google Chrome.app").exists()),
        "chromium": (support / "Chromium", pathlib.Path("/Applications/Chromium.app").exists()),
        "brave": (support / "BraveSoftware/Brave-Browser",
                  pathlib.Path("/Applications/Brave Browser.app").exists()),
        "edge": (support / "Microsoft Edge", pathlib.Path("/Applications/Microsoft Edge.app").exists()),
    }
else:
    config_home = home / ".config"
    has = lambda *names: any(shutil.which(name) for name in names)
    browsers = {
        "chrome": (config_home / "google-chrome", has("google-chrome", "google-chrome-stable")),
        "chromium": (config_home / "chromium",
                     has("chromium-browser") or (shutil.which("chromium") or "").startswith("/usr")),
        "brave": (config_home / "BraveSoftware/Brave-Browser", has("brave-browser", "brave")),
        "edge": (config_home / "microsoft-edge", has("microsoft-edge", "microsoft-edge-stable")),
    }

    # Snap Chromium would start the host inside its sandbox, where the
    # project's Python environment cannot run; it is not registered.
    if pathlib.Path("/snap/bin/chromium").exists() and not browsers["chromium"][1]:
        print("Note: snap Chromium can't run the local app from its sandbox; "
              "use Chrome, Brave or Edge from a .deb package.")
    browsers["chromium-snap"] = (home / "snap/chromium/common/chromium", False)

if args == ["--uninstall"]:
    for name, (profile, _) in browsers.items():
        manifest = profile / "NativeMessagingHosts" / f"{HOST}.json"
        if manifest.exists():
            manifest.unlink()
            print(f"Unregistered: {name}")
    sys.exit(0)

supported = [name for name in browsers if name != "chromium-snap"]
wanted = args or [name for name, (_, installed) in browsers.items() if installed]
unknown = [name for name in wanted if name not in supported]
if unknown:
    sys.exit(f"Unknown browser: {', '.join(unknown)} ({', '.join(supported)})")
if not wanted:
    # The host is built and configured anyway: a browser installed later only
    # needs this script run again, and the e2e check registers its own.
    print(f"No supported browser found; nothing registered ({', '.join(supported)})")

# Settings a user changed survive a reinstall, except absolute paths into the
# project, which are rewritten relative so the folder can move freely.
config_path = project / "bin/config.json"
config = json.loads(config_path.read_text()) if config_path.is_file() else {}
def relative(value):
    return value[len(str(project)) + 1:] if value.startswith(str(project) + "/") else value

config.pop("model", None)  # replaced by mlx_model / llama_model / ollama_model
# 0.2 had one Russian voice under "voice"; voices are per target language now.
voices = {"ru": "voices/ru_RU-dmitri-medium.onnx",
          "uk": "voices/uk_UA-ukrainian_tts-medium.onnx"}
if config.get("voice"):
    voices["ru"] = config.pop("voice")
# Only Piper voices remain; older engine settings are dropped.
for retired in ("voice_backend", "voice_speaker"):
    config.pop(retired, None)
# The host picks MLX or llama.cpp by platform. An "mlx" carried over from a
# Mac into a folder moved to Linux would never load, so it is dropped here.
apple_silicon = platform.system() == "Darwin" and platform.machine() == "arm64"
if config.get("translator") == "mlx" and not apple_silicon:
    config.pop("translator")
# A folder moved here from Windows carries its Python path and its engines,
# which requirements-*.txt don't install on macOS or Linux.
if config.get("python") == ".venv/Scripts/python.exe":
    config.pop("python")
for key in ("asr", "voice_engine"):
    if config.get(key) == "sherpa":
        config.pop(key)
voices.update(config.get("voices", {}))
config["voices"] = {language: relative(path) for language, path in voices.items()}
config["voice_speakers"] = {"uk": "mykyta", **config.get("voice_speakers", {})}
config["python"] = relative(config.get("python", ".venv/bin/python"))
config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n")

key = json.loads((project / "extension/manifest.json").read_text())["key"]
digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
extension_id = "".join(chr(ord("a") + int(c, 16)) for c in digest)
manifest = {
    "name": HOST,
    "description": "YouTube Translate: local translation and voice-over",
    "path": str(project / "bin/local-youtube-dub-host"),
    "type": "stdio",
    "allowed_origins": [f"chrome-extension://{extension_id}/"],
}
for name in wanted:
    directory = browsers[name][0] / "NativeMessagingHosts"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{HOST}.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(f"Registered: {name}")
print(f"Extension ID: {extension_id}")
PY

[ "${1:-}" = --uninstall ] || echo "Done. Load the extension folder as an unpacked extension and restart the browser."
