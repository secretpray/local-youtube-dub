#!/bin/sh
# One-time setup of everything the host needs, inside this folder only:
# Python environment, translation model, speech recognition model, voices.
# System tools (Python, Rust, ffmpeg, a C toolchain on Linux) come from the
# system package manager; nothing else is installed system-wide.
#
# Apple Silicon uses MLX; Linux and Intel Macs use llama.cpp and faster-whisper
# with the same models.
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLATFORM=apple-silicon; HINT="brew install rust ffmpeg python@3.13" ;;
  Darwin-*) PLATFORM=cpu; HINT="brew install rust ffmpeg cmake python@3.13" ;;
  Linux-*) PLATFORM=cpu
    HINT="sudo apt install cargo ffmpeg cmake build-essential python3-venv python3-dev" ;;
  *) echo "Unsupported system: $(uname -s) $(uname -m)" >&2; exit 2 ;;
esac

REQUIRED="cargo ffmpeg"
[ "$PLATFORM" = cpu ] && REQUIRED="$REQUIRED cmake cc"
for tool in $REQUIRED; do
  command -v "$tool" >/dev/null || { echo "$tool not found ($HINT)" >&2; exit 2; }
done
PYTHON=""
for candidate in python3.14 python3.13 python3.12 python3.11; do
  if command -v "$candidate" >/dev/null; then PYTHON=$candidate; break; fi
done
[ -n "$PYTHON" ] || { echo "Python 3.11–3.14 is required ($HINT)" >&2; exit 2; }

[ -x .venv/bin/python ] || "$PYTHON" -m venv .venv
.venv/bin/python -m pip install --quiet --upgrade pip
# llama-cpp-python has no prebuilt wheels and compiles here, which takes a
# few minutes the first time.
[ "$PLATFORM" = cpu ] && echo "Installing Python packages; llama.cpp compiles on first install (several minutes)…"
.venv/bin/python -m pip install --quiet -r "requirements-$PLATFORM.txt"
# YouTube changes often and old yt-dlp releases stop working: always take the latest.
.venv/bin/python -m pip install --quiet --upgrade "yt-dlp[default]"

# One voice per language the video can be dubbed into.
mkdir -p voices cache/huggingface
for VOICE in ${DUB_VOICE_NAMES:-ru_RU-dmitri-medium uk_UA-ukrainian_tts-medium}; do
  [ -f "voices/$VOICE.onnx" ] || .venv/bin/python -m piper.download_voices "$VOICE" --data-dir voices
done

export HF_HOME="$PROJECT_DIR/cache/huggingface"
# Plain HTTP downloads: the Xet transfer backend stalled indefinitely on a
# Linux VM (no progress, no error), while HTTP from the same machine worked.
export HF_HUB_DISABLE_XET=1
.venv/bin/python - "$PLATFORM" <<'PY'
import sys
from huggingface_hub import hf_hub_download, snapshot_download

if sys.argv[1] == "apple-silicon":
    for repo in ("mlx-community/Qwen3-4B-Instruct-2507-4bit", "mlx-community/whisper-small-mlx"):
        print("Model", repo, "->", snapshot_download(repo))
else:
    print("Model ->", hf_hub_download("unsloth/Qwen3-4B-Instruct-2507-GGUF",
                                      "Qwen3-4B-Instruct-2507-Q4_K_M.gguf"))
    print("Model ->", snapshot_download("Systran/faster-whisper-small"))
PY
echo "Done. Next: make install"
