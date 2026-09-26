"""Keep one local Piper voice loaded for the lifetime of a browser session.

    piper_worker.py VOICE.onnx [SPEAKER]

The protocol is in voice_common.py. On Windows, where piper-tts has no ARM64
wheels, sherpa_voice_worker.py plays the same voices instead.
"""

import io
import sys
import wave

from voice_common import letters_only, serve


def load():
    from piper import PiperVoice, SynthesisConfig

    voice = PiperVoice.load(sys.argv[1])
    speakers = voice.config.speaker_id_map or {}
    requested = sys.argv[2] if len(sys.argv) > 2 else ""
    speaker = speakers.get(requested, 0) if speakers else None
    text_voice = str(getattr(voice.config.phoneme_type, "value", voice.config.phoneme_type)) == "text"
    language = (voice.config.espeak_voice or "uk").split("-")[0]

    def render(text, length_scale):
        if text_voice:
            text = letters_only(text, language)
        output = io.BytesIO()
        with wave.open(output, "wb") as wav:
            voice.synthesize_wav(text, wav, syn_config=SynthesisConfig(
                length_scale=length_scale, speaker_id=speaker))
        return output.getvalue()
    return render


if __name__ == "__main__":
    serve(load)
