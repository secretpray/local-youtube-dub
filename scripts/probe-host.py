r"""Talk to the native host the way the browser does, without a browser.

    .venv/bin/python scripts/probe-host.py              # status + four phrases, en -> ru
    .venv/bin/python scripts/probe-host.py --into uk    # dub into Ukrainian
    .venv/bin/python scripts/probe-host.py --from de    # German phrases
    .venv/bin/python scripts/probe-host.py --bare-env   # with the browser's bare PATH
    .venv/bin/python scripts/probe-host.py --transcribe cMX-u9ltG5Q --start 600

On Windows the interpreter is .venv\Scripts\python.exe.

Prints how long each answer took, which is the quickest way to tell a model,
voice or environment problem from an extension problem.
"""

import base64
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import time

PROJECT = Path(__file__).resolve().parent.parent
HOST = PROJECT / "bin" / ("local-youtube-dub-host.exe" if os.name == "nt" else "local-youtube-dub-host")
PHRASES = {
    "en": ["So what does that mean for Rails?",
           "Because this is the person who has been coming up with all the features.",
           "And improving the language for twenty years.",
           "I think that is a big deal."],
    "es": ["Hola a todos, bienvenidos de nuevo al canal.",
           "Hoy vamos a ver cómo funciona esta herramienta."],
    "de": ["Heute zeige ich euch, wie man in zehn Minuten eine kleine Web-App baut.",
           "Das ist eigentlich gar nicht so schwer, wie viele denken."],
}


def option(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def main():
    # Windows gives a redirected stdout its ANSI code page, which has no
    # Cyrillic: printing the first translation raised UnicodeEncodeError.
    sys.stdout.reconfigure(encoding="utf-8")
    env = None
    if "--bare-env" in sys.argv and os.name == "nt":
        # Nothing the project installed on PATH; Windows itself can't start a
        # process without SystemRoot, and Python wants the profile folders.
        keep = ("SystemRoot", "SystemDrive", "USERPROFILE", "LOCALAPPDATA", "APPDATA",
                "TEMP", "TMP", "ComSpec", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS")
        env = {name: os.environ[name] for name in keep if name in os.environ}
        env["PATH"] = os.path.join(os.environ["SystemRoot"], "System32") + ";" + os.environ["SystemRoot"]
    elif "--bare-env" in sys.argv:
        env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": os.environ["HOME"]}
    host = subprocess.Popen([str(HOST)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)

    def send(message):
        data = json.dumps(message).encode()
        host.stdin.write(struct.pack("<I", len(data)) + data)
        host.stdin.flush()

    def receive():
        header = host.stdout.read(4)
        if len(header) < 4:
            sys.exit("The host exited without answering")
        return json.loads(host.stdout.read(struct.unpack("<I", header)[0]))

    if "--transcribe" in sys.argv:
        # Speech recognition of one section, as the extension asks for it
        # when a video has no subtitles.
        started = time.time()
        send({"id": "transcription", "type": "transcribe", "videoId": option("--transcribe", ""),
              "startSeconds": int(option("--start", "0")), "windowSeconds": 180,
              "language": option("--from", "auto")})
        answer = receive()
        if answer.get("resultJsonBase64"):
            parts = [answer["resultJsonBase64"]]
            while len(parts) < answer["chunkCount"]:
                parts.append(receive()["resultJsonBase64"])
            answer = {"ok": True, "result": json.loads(base64.b64decode("".join(parts)))}
        result = answer.get("result") or {}
        if not answer.get("ok"):
            sys.exit(f"{time.time() - started:5.1f} s  error {answer.get('code')}: {answer.get('error')}")
        segments = result["segments"]
        print(f"{time.time() - started:5.1f} s  {result['language']}, {len(segments)} segments, "
              f"{result['model']}")
        for segment in segments[:5]:
            print(f"         {segment['start']:7.1f}  {segment['text']}")
        host.stdin.close()
        host.wait()
        return

    source, into = option("--from", "en"), option("--into", "ru")
    phrases = PHRASES[source]
    started = time.time()
    send({"id": "status", "type": "status", "into": into})
    status = receive()
    print(f"{time.time() - started:5.1f} s  status: {status.get('result') or status.get('error')}")
    if not status.get("ok"):
        sys.exit(1)
    for index, text in enumerate(phrases):
        send({"id": index, "type": "translate", "source": text, "language": source,
              "into": into, "targetDuration": 4})
    for _ in phrases:
        answer = receive()
        result = answer.get("result") or {}
        detail = (f"{result.get('translated')} ({result.get('duration', 0):.1f} s of audio)"
                  if answer.get("ok") else f"error {answer.get('code')}: {answer.get('error')}")
        print(f"{time.time() - started:5.1f} s  #{answer['id']}: {detail}")
    host.stdin.close()
    host.wait()


if __name__ == "__main__":
    main()
