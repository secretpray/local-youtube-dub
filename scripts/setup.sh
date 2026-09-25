#!/bin/sh
# One-time setup of everything the host needs, inside this folder only:
# Python environment, translation model, speech recognition model, voice.
# Nothing is installed system-wide except what Homebrew already provides.
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"

if [ "$(uname -s)-$(uname -m)" != "Darwin-arm64" ]; then
  echo "Нужен Mac на Apple Silicon: перевод и распознавание работают через MLX." >&2
  exit 2
fi
for tool in cargo ffmpeg; do
  command -v "$tool" >/dev/null || { echo "Не найден $tool (brew install rust ffmpeg)" >&2; exit 2; }
done
PYTHON=""
for candidate in python3.13 python3.12 python3.11; do
  if command -v "$candidate" >/dev/null; then PYTHON=$candidate; break; fi
done
[ -n "$PYTHON" ] || { echo "Нужен Python 3.11–3.13 (brew install python@3.13)" >&2; exit 2; }

[ -x .venv/bin/python ] || "$PYTHON" -m venv .venv
.venv/bin/python -m pip install --quiet --upgrade pip
.venv/bin/python -m pip install --quiet -r requirements.txt
# YouTube changes often and old yt-dlp releases stop working: always take the latest.
.venv/bin/python -m pip install --quiet --upgrade "yt-dlp[default]"

# One voice per language the video can be dubbed into.
mkdir -p voices cache/huggingface
for VOICE in ${DUB_VOICE_NAMES:-ru_RU-dmitri-medium uk_UA-ukrainian_tts-medium}; do
  [ -f "voices/$VOICE.onnx" ] || .venv/bin/python -m piper.download_voices "$VOICE" --data-dir voices
done

export HF_HOME="$PROJECT_DIR/cache/huggingface"
.venv/bin/python - <<'PY'
from huggingface_hub import snapshot_download
for repo in ("mlx-community/Qwen3-4B-Instruct-2507-4bit", "mlx-community/whisper-small-mlx"):
    print("Модель", repo, "->", snapshot_download(repo))
PY
echo "Готово. Теперь: make install"
