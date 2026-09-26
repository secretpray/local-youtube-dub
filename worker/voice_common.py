"""What the two voice workers share: text preparation, fitting speech into the
phrase, and the JSON-lines loop. The engines differ by platform (Piper where
piper-tts has wheels, sherpa-onnx on Windows), the protocol does not.

After a {"ready": true} handshake, JSON lines: {"text", "targetDuration"} in,
{"wav", "duration"} or {"error"} out.
"""

import base64
import io
import json
import re
import sys
import wave

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


def wav_bytes(samples, sample_rate):
    """16-bit mono WAV from int16 PCM bytes."""
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(samples)
    return output.getvalue()


def wav_duration(data):
    with wave.open(io.BytesIO(data), "rb") as wav:
        return wav.getnframes() / wav.getframerate()


def fitted(render, target_duration):
    """Speech at its natural pace, or faster when that overruns the phrase.

    render(length_scale) returns WAV bytes. The pace is never raised past
    length_scale 0.72 (1.39x): faster than that stops being intelligible, and
    the extension slows or pauses the video for the rest.
    """
    target = max(1.0, min(30.0, float(target_duration)))
    data = render(1.0)
    duration = wav_duration(data)
    if duration > target * 1.05:
        scale = max(0.72, min(1.0, target / duration * 0.98))
        if scale < 0.99:
            data = render(scale)
            duration = wav_duration(data)
    return data, duration


def serve(load):
    """Runs the worker. load() returns render(text, length_scale) -> WAV bytes."""
    try:
        render = load()
    except Exception as error:
        print(json.dumps({"error": f"Voice not loaded: {error}"}, ensure_ascii=False), flush=True)
        return
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            text = request["text"]
            data, duration = fitted(lambda scale: render(text, scale),
                                    request.get("targetDuration", 8.0))
            response = {"wav": base64.b64encode(data).decode("ascii"), "duration": duration}
        except Exception as error:
            response = {"error": str(error)}
        print(json.dumps(response, ensure_ascii=False), flush=True)
