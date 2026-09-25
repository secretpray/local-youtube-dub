"""Keep one local Piper voice loaded for the lifetime of a browser session.

    piper_worker.py VOICE.onnx [SPEAKER]

After a {"ready": true} handshake, JSON lines: {"text", "targetDuration"} in,
{"wav", "duration"} or {"error"} out.
"""

import base64
import io
import json
import re
import sys
import wave

from piper import PiperVoice, SynthesisConfig

# Voices trained on letters rather than espeak phonemes (phoneme_type "text",
# e.g. uk_UA-ukrainian_tts) only know lower-case Cyrillic: capitals, digits and
# Latin words are silently dropped. Such text is normalised first.
LATIN = [("shch", "щ"), ("sh", "ш"), ("ch", "ч"), ("zh", "ж"), ("kh", "х"), ("th", "т"),
         ("ph", "ф"), ("ts", "ц"), ("ya", "я"), ("yu", "ю"), ("ye", "є"), ("oo", "у"),
         ("ee", "і"), ("ck", "к"), ("qu", "кв"), ("x", "кс"), ("a", "а"), ("b", "б"),
         ("c", "к"), ("d", "д"), ("e", "е"), ("f", "ф"), ("g", "ґ"), ("h", "г"), ("i", "і"),
         ("j", "дж"), ("k", "к"), ("l", "л"), ("m", "м"), ("n", "н"), ("o", "о"), ("p", "п"),
         ("q", "к"), ("r", "р"), ("s", "с"), ("t", "т"), ("u", "у"), ("v", "в"), ("w", "в"),
         ("y", "и"), ("z", "з")]


def letters_only(text, language):
    def spell(match):
        try:
            from num2words import num2words
            return num2words(int(match.group(0)), lang=language)
        except Exception:
            return match.group(0)
    text = re.sub(r"\d+", spell, text).lower()
    for latin, cyrillic in LATIN:
        text = text.replace(latin, cyrillic)
    return text


def synthesize(voice, text, length_scale, speaker):
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        voice.synthesize_wav(text, wav, syn_config=SynthesisConfig(
            length_scale=length_scale, speaker_id=speaker))
    data = output.getvalue()
    with wave.open(io.BytesIO(data), "rb") as wav:
        duration = wav.getnframes() / wav.getframerate()
    return data, duration


def main():
    try:
        voice = PiperVoice.load(sys.argv[1])
    except Exception as error:
        print(json.dumps({"error": f"Piper voice not loaded: {error}"}), flush=True)
        return
    speakers = voice.config.speaker_id_map or {}
    requested = sys.argv[2] if len(sys.argv) > 2 else ""
    speaker = speakers.get(requested, 0) if speakers else None
    text_voice = str(getattr(voice.config.phoneme_type, "value", voice.config.phoneme_type)) == "text"
    language = (voice.config.espeak_voice or "uk").split("-")[0]
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            text = request["text"]
            if text_voice:
                text = letters_only(text, language)
            target = max(1.0, min(30.0, float(request.get("targetDuration", 8.0))))
            data, duration = synthesize(voice, text, 1.0, speaker)
            if duration > target * 1.05:
                scale = max(0.72, min(1.0, target / duration * 0.98))
                if scale < 0.99:
                    data, duration = synthesize(voice, text, scale, speaker)
            response = {"wav": base64.b64encode(data).decode("ascii"),
                        "duration": duration}
        except Exception as error:
            response = {"error": str(error)}
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
