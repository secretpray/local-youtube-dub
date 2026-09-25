"""Keep one Vosk TTS model loaded for the lifetime of a browser session.

Same JSON-lines protocol as piper_worker.py: {"text", "targetDuration"} in,
{"wav", "duration"} or {"error"} out.
"""

import base64
import io
import json
import re
import sys
import wave

from num2words import num2words
from vosk_tts import Model, Synth


def spell_numbers(text):
    """Vosk's g2p drops digits, so numbers are written out in Russian first."""
    def replace(match):
        raw = match.group(0).replace(" ", "")
        try:
            if "," in raw or "." in raw:
                return num2words(float(raw.replace(",", ".")), lang="ru")
            return num2words(int(raw), lang="ru")
        except (ValueError, OverflowError, NotImplementedError):
            return raw
    text = re.sub(r"(\d+)\s?%", lambda m: f"{m.group(1)} процентов", text)
    return re.sub(r"\d+(?:[.,]\d+)?", replace, text)


def to_wav(samples, rate):
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(samples.tobytes())
    return output.getvalue()


def main():
    try:
        model = Model(model_path=sys.argv[1])
    except Exception as error:
        print(json.dumps({"error": f"Модель Vosk TTS не загружена: {error}"}, ensure_ascii=False), flush=True)
        return
    speakers = model.config["speaker_id_map"]
    speaker = speakers.get(sys.argv[2] if len(sys.argv) > 2 else "", 3)
    rate = model.config["audio"]["sample_rate"]
    synth = Synth(model)
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            text = spell_numbers(request["text"])
            target = max(1.0, min(30.0, float(request.get("targetDuration", 8.0))))
            audio = synth.synth_audio(text, speaker_id=speaker)
            duration = len(audio) / rate
            if duration > target * 1.05:
                speed = min(1.35, duration / target * 1.02)
                audio = synth.synth_audio(text, speaker_id=speaker, speech_rate=speed)
                duration = len(audio) / rate
            response = {"wav": base64.b64encode(to_wav(audio, rate)).decode("ascii"),
                        "duration": duration}
        except Exception as error:
            response = {"error": str(error)}
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
