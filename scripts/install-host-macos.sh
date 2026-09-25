#!/bin/sh
# Builds the native host, writes bin/config.json and registers the host with
# Chromium browsers. The extension ID comes from the "key" in manifest.json,
# so it is the same on every machine and never has to be copied by hand.
#
#   sh scripts/install-host-macos.sh [chrome|edge|brave|chromium ...]
#
# Without arguments the host is registered for every browser that is installed.
# Re-run after moving the folder: the registration holds an absolute path.
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
[ -x "$PROJECT_DIR/.venv/bin/python" ] || { echo "Сначала выполните make setup" >&2; exit 2; }

cargo build --release --quiet --manifest-path "$PROJECT_DIR/Cargo.toml"
mkdir -p "$PROJECT_DIR/bin"
# Copy then rename: overwriting a running or signature-cached binary in place
# makes macOS kill it on the next launch (exit 137).
cp "$PROJECT_DIR/target/release/local-youtube-dub-host" "$PROJECT_DIR/bin/.local-youtube-dub-host.new"
mv -f "$PROJECT_DIR/bin/.local-youtube-dub-host.new" "$PROJECT_DIR/bin/local-youtube-dub-host"

python3 - "$PROJECT_DIR" "$@" <<'PY'
import base64
import hashlib
import json
import pathlib
import sys

project = pathlib.Path(sys.argv[1])
support = pathlib.Path.home() / "Library/Application Support"
browsers = {
    "chrome": (support / "Google/Chrome", "/Applications/Google Chrome.app"),
    "edge": (support / "Microsoft Edge", "/Applications/Microsoft Edge.app"),
    "brave": (support / "BraveSoftware/Brave-Browser", "/Applications/Brave Browser.app"),
    "chromium": (support / "Chromium", "/Applications/Chromium.app"),
}
wanted = sys.argv[2:] or [name for name, (_, app) in browsers.items() if pathlib.Path(app).exists()]
unknown = [name for name in wanted if name not in browsers]
if unknown:
    sys.exit(f"Неизвестный браузер: {', '.join(unknown)} (chrome, edge, brave, chromium)")

# Settings a user changed survive a reinstall, except absolute paths into the
# project, which are rewritten relative so the folder can move freely.
config_path = project / "bin/config.json"
config = json.loads(config_path.read_text()) if config_path.is_file() else {}
def relative(value):
    return value[len(str(project)) + 1:] if value.startswith(str(project) + "/") else value

config.pop("model", None)  # replaced by mlx_model / ollama_model
# 0.2 had one Russian voice under "voice"; voices are per target language now.
voices = {"ru": "voices/ru_RU-dmitri-medium.onnx",
          "uk": "voices/uk_UA-ukrainian_tts-medium.onnx"}
if config.get("voice") and config.get("voice_backend", "piper") == "piper":
    voices["ru"] = config.pop("voice")
voices.update(config.get("voices", {}))
config["voices"] = {language: relative(path) for language, path in voices.items()}
config["voice_speakers"] = {"uk": "mykyta", **config.get("voice_speakers", {})}
if "python" in config:
    config["python"] = relative(config["python"])
defaults = {
    "translator": "mlx",
    "mlx_model": "mlx-community/Qwen3-4B-Instruct-2507-4bit",
    "voice_backend": "piper",
    "python": ".venv/bin/python",
}
config = {**defaults, **config}
config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n")

key = json.loads((project / "extension/manifest.json").read_text())["key"]
digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
extension_id = "".join(chr(ord("a") + int(c, 16)) for c in digest)
manifest = {
    "name": "org.local_youtube_dub.host",
    "description": "YouTube Translate: локальный перевод и озвучка",
    "path": str(project / "bin/local-youtube-dub-host"),
    "type": "stdio",
    "allowed_origins": [f"chrome-extension://{extension_id}/"],
}
for name in wanted:
    directory = browsers[name][0] / "NativeMessagingHosts"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "org.local_youtube_dub.host.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(f"Зарегистрировано: {name}")
print(f"ID расширения: {extension_id}")
PY

echo "Готово. Загрузите папку extension как распакованное расширение и перезапустите браузер."
