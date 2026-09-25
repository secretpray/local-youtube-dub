"""Keep one MLX language model loaded for the lifetime of a browser session.

After a {"ready": true} handshake, JSON lines: {"system", "prompt", "temperature", "maxTokens"} in, {"text"} or
{"error"} out. The model is never downloaded here: a session must not stall on
a multi-gigabyte download, so a missing model is an error that points at setup.
"""

import json
import os
from pathlib import Path
import sys

PROJECT = Path(__file__).resolve().parent.parent
os.environ.setdefault("HF_HOME", str(PROJECT / "cache" / "huggingface"))
os.environ["HF_HUB_OFFLINE"] = "1"


def main():
    from mlx_lm import generate, load
    from mlx_lm.sample_utils import make_sampler

    try:
        model, tokenizer = load(sys.argv[1])
    except Exception as error:
        message = f"Модель перевода {sys.argv[1]} не найдена ({error}). Выполните make setup"
        print(json.dumps({"error": message}, ensure_ascii=False), flush=True)
        return
    # Handshake: the host waits for this line, so a load failure is reported
    # once, up front, instead of as an error on every phrase.
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            messages = [{"role": "system", "content": request["system"]},
                        {"role": "user", "content": request["prompt"]}]
            prompt = tokenizer.apply_chat_template(messages, add_generation_prompt=True,
                                                   tokenize=False)
            text = generate(model, tokenizer, prompt=prompt,
                            max_tokens=int(request.get("maxTokens", 240)),
                            sampler=make_sampler(temp=float(request.get("temperature", 0.1))))
            response = {"text": text}
        except Exception as error:
            response = {"error": str(error)}
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
