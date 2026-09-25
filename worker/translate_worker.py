"""Keep one language model loaded for the lifetime of a browser session.

    translate_worker.py mlx   HF_REPO                    # Apple Silicon
    translate_worker.py llama HF_REPO/FILE.gguf | PATH   # everywhere else (llama.cpp)

After a {"ready": true} handshake, JSON lines: {"system", "prompt",
"temperature", "maxTokens"} in, {"text"} or {"error"} out. The model is never
downloaded here: a session must not stall on a multi-gigabyte download, so a
missing model is an error that points at setup.
"""

import json
import os
from pathlib import Path
import sys

PROJECT = Path(__file__).resolve().parent.parent
os.environ.setdefault("HF_HOME", str(PROJECT / "cache" / "huggingface"))
os.environ["HF_HUB_OFFLINE"] = "1"


def load_mlx(model):
    from mlx_lm import generate, load
    from mlx_lm.sample_utils import make_sampler

    weights, tokenizer = load(model)

    def complete(system, prompt, temperature, max_tokens):
        messages = [{"role": "system", "content": system}, {"role": "user", "content": prompt}]
        text = tokenizer.apply_chat_template(messages, add_generation_prompt=True, tokenize=False)
        return generate(weights, tokenizer, prompt=text, max_tokens=max_tokens,
                        sampler=make_sampler(temp=temperature))
    return complete


def gguf_path(model):
    """A local .gguf path, or "org/repo/file.gguf" in the Hugging Face cache."""
    if Path(model).is_file():
        return model
    from huggingface_hub import hf_hub_download
    repo, _, filename = model.rpartition("/")
    return hf_hub_download(repo, filename)


def keep_weights_mapped():
    """Stops llama.cpp from repacking the weights into anonymous memory.

    On ARM it copies the whole Q4_K model into a CPU-friendly layout: 2.8 GB
    of memory the kernel can't reclaim, where the mapped file is page cache it
    can. On a 5 GB Linux machine that copy got the host OOM-killed, and
    systemd then stopped the browser whose scope the host runs in. The binding
    has no argument for it, so the default model parameters are adjusted.
    DUB_LLAMA_REPACK=1 turns repacking back on for machines with memory to spare.
    """
    import llama_cpp
    import llama_cpp.llama as llama_module

    if os.environ.get("DUB_LLAMA_REPACK") == "1":
        return
    if "use_extra_bufts" not in [name for name, _ in llama_cpp.llama_model_params._fields_]:
        return
    defaults = llama_cpp.llama_model_default_params

    def mapped():
        params = defaults()
        params.use_extra_bufts = False
        return params
    llama_module.llama_cpp.llama_model_default_params = mapped


def load_llama(model):
    keep_weights_mapped()
    from llama_cpp import Llama

    # The browser decodes the video on the same CPU. On 4 cores with 2 kept busy,
    # 2 threads prepared a phrase in about 3.5 s and 4 threads in about 5.5 s:
    # threads fighting the browser for cores lose to fewer threads.
    default = max(2, (os.cpu_count() or 4) - 2)
    threads = int(os.environ.get("DUB_LLAMA_THREADS") or default)
    llm = Llama(model_path=gguf_path(model), n_ctx=2048, n_threads=threads, verbose=False)

    def complete(system, prompt, temperature, max_tokens):
        answer = llm.create_chat_completion(
            messages=[{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            temperature=temperature, max_tokens=max_tokens)
        return answer["choices"][0]["message"]["content"] or ""
    return complete


def main():
    engine, model = sys.argv[1], sys.argv[2]
    try:
        complete = {"mlx": load_mlx, "llama": load_llama}[engine](model)
    except Exception as error:
        message = f"Translation model {model} ({engine}) not loaded: {error}. Run make setup"
        print(json.dumps({"error": message}, ensure_ascii=False), flush=True)
        return
    # Handshake: the host waits for this line, so a load failure is reported
    # once, up front, instead of as an error on every phrase.
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            text = complete(request["system"], request["prompt"],
                            float(request.get("temperature", 0.1)),
                            int(request.get("maxTokens", 240)))
            response = {"text": text}
        except Exception as error:
            response = {"error": str(error)}
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
