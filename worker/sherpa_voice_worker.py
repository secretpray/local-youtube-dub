"""Keep one Piper voice loaded through sherpa-onnx for a browser session.

    sherpa_voice_worker.py VOICE.onnx [SPEAKER]

The Windows voice engine: piper-tts has no wheels for Windows on ARM, while
sherpa-onnx runs the very same Piper voices on onnxruntime, with espeak-ng
built in, on every architecture. The protocol is in voice_common.py.

sherpa-onnx needs two things a Piper voice does not ship: metadata inside the
ONNX file and a tokens.txt. Both are derived from the voice's .onnx.json on
first use, into cache/sherpa-voices/, so bin/config.json names the same voice
files on every platform and any Piper voice works here too.
"""

import json
import os
from pathlib import Path
import sys
import unicodedata

from voice_common import letters_only, serve, wav_bytes

PROJECT = Path(__file__).resolve().parent.parent
CONVERTED = PROJECT / "cache" / "sherpa-voices"
# espeak-ng's dictionaries, from sherpa-onnx's release (setup.ps1).
ESPEAK_DATA = PROJECT / "voices" / "espeak-ng-data"
# Part of the conversion stamp: bump it when convert() changes its output.
FORMAT = 1


def convert(voice, config):
    """A sherpa-onnx copy of a Piper voice; redone only when the voice changes."""
    target = CONVERTED / voice.stem
    source = voice.stat()
    stamp = f"{FORMAT} {source.st_size} {source.st_mtime_ns}"
    if (target / "source").is_file() and (target / "source").read_text() == stamp:
        return target
    import onnx

    ids = {symbol: value[0] if isinstance(value, list) else value
           for symbol, value in config["phoneme_id_map"].items()}
    espeak = config.get("espeak", {}).get("voice", "")
    rate = config["audio"]["sample_rate"]
    metadata = {
        "model_type": "vits",
        "comment": "piper",
        "version": 1,
        "language": config.get("language", {}).get("name_english") or espeak,
        "voice": espeak,
        "n_speakers": config.get("num_speakers", 1),
        # A handful of Piper voices declare 22500, a typo for 22050.
        "sample_rate": 22050 if rate == 22500 else rate,
        "has_g2pw": 0,
    }
    phonemes = config.get("phoneme_type", "espeak")
    if phonemes == "text":
        # A voice trained on letters. sherpa's character frontend encodes text
        # exactly as Piper does, BOS, PAD after every symbol, EOS; handed to
        # espeak instead, it would read phonemes the voice has never seen.
        metadata.update({"has_espeak": 0, "frontend": "characters", "add_blank": 1,
                         "use_eos_bos": 1, "bos_id": ids["^"], "eos_id": ids["$"],
                         "blank_id": ids["_"], "pad_id": ids["_"]})
    elif phonemes == "espeak":
        metadata["has_espeak"] = 1
    else:
        raise ValueError(f"phoneme type {phonemes} is not supported")

    model = onnx.load(str(voice))
    del model.metadata_props[:]
    for key, value in metadata.items():
        entry = model.metadata_props.add()
        entry.key, entry.value = key, str(value)
    target.mkdir(parents=True, exist_ok=True)
    # Written aside and renamed, so a session starting meanwhile never loads
    # half a model; the stamp goes last, so an interrupted copy is redone.
    partial = target / f"model.{os.getpid()}.part"
    onnx.save(model, str(partial))
    os.replace(partial, target / "model.onnx")
    # One symbol per line; the space line is " 3", which sherpa reads back.
    tokens = "".join(f"{symbol} {value}\n" for symbol, value in ids.items() if symbol != "\n")
    (target / "tokens.txt").write_text(tokens, encoding="utf-8")
    (target / "source").write_text(stamp)
    return target


def load():
    import numpy as np
    import sherpa_onnx

    voice = Path(sys.argv[1])
    config = json.loads(Path(f"{voice}.json").read_text(encoding="utf-8"))
    text_voice = config.get("phoneme_type") == "text"
    if not text_voice and not (ESPEAK_DATA / "phontab").is_file():
        # sherpa-onnx exits the process on a missing data dir; say why first.
        raise FileNotFoundError(f"{ESPEAK_DATA} is missing")
    copy = convert(voice, config)
    inference = config.get("inference", {})
    tts = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                model=str(copy / "model.onnx"), tokens=str(copy / "tokens.txt"),
                data_dir="" if text_voice else str(ESPEAK_DATA),
                noise_scale=inference.get("noise_scale", 0.667),
                noise_scale_w=inference.get("noise_w", 0.8),
                # Piper's worker always passes 1.0 as the natural pace.
                length_scale=1.0),
            num_threads=int(os.environ.get("DUB_VOICE_THREADS") or 2),
            provider="cpu")))
    speakers = config.get("speaker_id_map") or {}
    requested = sys.argv[2] if len(sys.argv) > 2 else ""
    speaker = speakers.get(requested, 0)
    language = config.get("espeak", {}).get("voice", "uk").split("-")[0]

    def render(text, length_scale):
        if text_voice:
            # Piper splits a letter voice's text into NFD code points: "й" is
            # "и" plus a combining breve in its symbol table.
            text = unicodedata.normalize("NFD", letters_only(text, language))
        audio = tts.generate(text, sid=speaker, speed=1.0 / length_scale)
        samples = np.asarray(audio.samples, dtype=np.float32)
        # Peak-normalised like Piper's output, so both engines sound equally loud.
        peak = float(np.max(np.abs(samples))) if samples.size else 0.0
        if peak > 1e-8:
            samples = samples / peak
        pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
        return wav_bytes(pcm, audio.sample_rate)
    return render


if __name__ == "__main__":
    serve(load)
