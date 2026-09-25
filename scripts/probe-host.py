"""Talk to the native host the way the browser does, without a browser.

    .venv/bin/python scripts/probe-host.py              # status + four phrases, en -> ru
    .venv/bin/python scripts/probe-host.py --into uk    # dub into Ukrainian
    .venv/bin/python scripts/probe-host.py --from de    # German phrases
    .venv/bin/python scripts/probe-host.py --bare-env   # with the browser's bare PATH

Prints how long each answer took, which is the quickest way to tell a model,
voice or environment problem from an extension problem.
"""

import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import time

PROJECT = Path(__file__).resolve().parent.parent
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
    env = None
    if "--bare-env" in sys.argv:
        env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": os.environ["HOME"]}
    host = subprocess.Popen([str(PROJECT / "bin/local-youtube-dub-host")],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)

    def send(message):
        data = json.dumps(message).encode()
        host.stdin.write(struct.pack("<I", len(data)) + data)
        host.stdin.flush()

    def receive():
        header = host.stdout.read(4)
        if len(header) < 4:
            sys.exit("Хост завершился без ответа")
        return json.loads(host.stdout.read(struct.unpack("<I", header)[0]))

    source, into = option("--from", "en"), option("--into", "ru")
    phrases = PHRASES[source]
    started = time.time()
    send({"id": "status", "type": "status", "into": into})
    status = receive()
    print(f"{time.time() - started:5.1f} с  status: {status.get('result') or status.get('error')}")
    if not status.get("ok"):
        sys.exit(1)
    for index, text in enumerate(phrases):
        send({"id": index, "type": "translate", "source": text, "language": source,
              "into": into, "targetDuration": 4})
    for _ in phrases:
        answer = receive()
        result = answer.get("result") or {}
        detail = (f"{result.get('translated')} ({result.get('duration', 0):.1f} с звука)"
                  if answer.get("ok") else f"ошибка {answer.get('code')}: {answer.get('error')}")
        print(f"{time.time() - started:5.1f} с  #{answer['id']}: {detail}")
    host.stdin.close()
    host.wait()


if __name__ == "__main__":
    main()
