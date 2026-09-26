"""Downloads everything the Windows setup needs besides Python packages, each
file checked against a SHA-256 before it is used.

    .venv\\Scripts\\python.exe scripts\\fetch.py --arch arm64|x64 [--gpu vulkan]
        [--llama-build official|baseline]

setup.ps1 runs it. Everything lands inside the project:

    tools\\llama\\     llama-server, the translation engine (llama.cpp release)
    tools\\deno\\      Deno, the JavaScript runtime yt-dlp needs for YouTube
    voices\\          Piper voices and espeak-ng-data for sherpa-onnx
    cache\\models\\    Silero VAD
    cache\\huggingface the translation model and Whisper for sherpa-onnx

Versions are pinned: a release asset or a model file that changed upstream
fails the check instead of being run. To move to a newer build, update the
name and the checksum together. Voices other than the defaults (set with
DUB_VOICE_NAMES) are checked against the hashes Hugging Face publishes for
the pinned revision, and this project's own build of llama.cpp for older ARM
processors against the hash GitHub publishes for its release asset.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile

try:
    # Certificates checked by the system, as a browser checks them. Python
    # only reads the roots already in the Windows store, and a fresh Windows
    # fetches most of them on first use: huggingface.co failed with "unable
    # to get local issuer certificate" while GitHub worked. The system check
    # fetches the missing root, and honours a company's own CA as well.
    import truststore
    truststore.inject_into_ssl()
except ImportError:
    pass

PROJECT = Path(__file__).resolve().parent.parent
os.environ.setdefault("HF_HOME", str(PROJECT / "cache" / "huggingface"))
# Plain HTTP downloads: the Xet transfer backend stalled indefinitely on a
# Linux VM (no progress, no error), while HTTP from the same machine worked.
os.environ["HF_HUB_DISABLE_XET"] = "1"
# Without Developer Mode Windows allows no symlinks, and the cache keeps plain
# copies instead. Each file here is needed once, so nothing is duplicated.
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"

GITHUB = "https://github.com"
LLAMA_BUILD = "b11193"
LLAMA = {
    "arm64": ("win-cpu-arm64", "5ccc0c11b188e8eb53339f5917d2e37eddf6f6ddec25863798d72a3dc297abe6"),
    "x64": ("win-cpu-x64", "1110e183589e0e2ac5b365fb5c3c4a7e149e0760c1989cac18ee426b08e5813a"),
    "x64-vulkan": ("win-vulkan-x64", "a106346b30d79883626bd9cf9f0d787ff949eeaf3feaf6a4f31d41a2ecf9086b"),
}
# The same llama.cpp release built for ARM processors the official build
# can't run on (see official_arm64_build_runs). .github/workflows/ci.yml
# builds it with llama.cpp's own settings and publishes it on this project's
# releases under the tag llama-<build>. Pinned like every other download, so
# a replaced release asset is refused: after moving LLAMA_BUILD, run that
# workflow and add the new asset's SHA-256 here.
REPOSITORY = "secretpray/local-youtube-dub"
LLAMA_BASELINE = {
    "b11193": "f93a1b218e55efa8380b3dfd6a23eab87573d5e3db47488dac75ff4dc2fe7bff",
}
DENO_VERSION = "v2.9.7"
DENO = {
    "arm64": ("aarch64", "c4c4ac8bfdaa37814bda5c05fc9cdf2154904e2ef8277673a30bdceaaa649807"),
    "x64": ("x86_64", "a0c3101b4158d1dfb7d6a78a7bf0f3de80c96bb423c152beec8beb22786f2238"),
}
SHERPA_RELEASES = f"{GITHUB}/k2-fsa/sherpa-onnx/releases/download"
ESPEAK_DATA = (f"{SHERPA_RELEASES}/tts-models/espeak-ng-data.zip",
               "bc4525eafe31b4e3f5e43aea495f3169e97dd2544f1bbfe95514ce8a61baee39")
SILERO_VAD = (f"{SHERPA_RELEASES}/asr-models/silero_vad.onnx",
              "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6")
# (repository, revision, file, SHA-256) in the Hugging Face cache, where the
# host and the workers look models up by repository, as on Linux.
MODELS = [
    ("unsloth/Qwen3-4B-Instruct-2507-GGUF", "a06e946bb6b655725eafa393f4a9745d460374c9",
     "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
     "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597"),
    # Must match SHERPA_WHISPER in worker/transcribe_video.py.
    ("csukuangfj/sherpa-onnx-whisper-small", "8f3c18b358db4d1f2fc1eae49d75cd20989e4309",
     "small-encoder.int8.onnx", "4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9"),
    ("csukuangfj/sherpa-onnx-whisper-small", "8f3c18b358db4d1f2fc1eae49d75cd20989e4309",
     "small-decoder.int8.onnx", "acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee"),
    ("csukuangfj/sherpa-onnx-whisper-small", "8f3c18b358db4d1f2fc1eae49d75cd20989e4309",
     "small-tokens.txt", "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126"),
]
VOICES_REPO = ("rhasspy/piper-voices", "c10ece1aade47bb51c153c893d14e5bf8e5b7117")
VOICES = {
    "ru_RU-dmitri-medium": (
        "f073356ebc4bd0f80c5af58df2953a5988bd5bdab1eb38635ce960b071fbefcb",
        "667ef3117bc642c2892dff7690d8bdc8ca4228aeaa783b2dc1416df632855e0d"),
    "uk_UA-ukrainian_tts-medium": (
        "7920419ac5f6fd8b6450520f24b52ed5a319cb53dd018fbcd71c9e079cbac84f",
        "4e96e72917ca9b94edc77d6ccfee03a73f450ba2fc1ca93c2e562bc014e5aa55"),
}


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for block in iter(lambda: file.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def download(url, target, expected):
    """url -> target, unless target already has the expected checksum."""
    target = Path(target)
    if target.is_file() and sha256(target) == expected:
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".part")
    digest = hashlib.sha256()
    print(f"Downloading {url.rsplit('/', 1)[-1]}", flush=True)
    with urllib.request.urlopen(url, timeout=60) as response, open(partial, "wb") as file:
        size = int(response.headers.get("Content-Length") or 0)
        done, shown = 0, -1
        for block in iter(lambda: response.read(1 << 20), b""):
            file.write(block)
            digest.update(block)
            done += len(block)
            percent = done * 100 // size if size else -1
            if size > 20 << 20 and percent >= shown + 10:
                shown = percent
                print(f"  {percent}% of {size >> 20} MB", flush=True)
    if digest.hexdigest() != expected:
        partial.unlink(missing_ok=True)
        sys.exit(f"Checksum mismatch for {url}: got {digest.hexdigest()}, expected {expected}")
    os.replace(partial, target)
    return target


def unpack(url, expected, target, marker):
    """A checked zip, extracted into target. marker is a file that must be in
    it; the folder holding it becomes target, whatever the zip nests it in."""
    target = PROJECT / target
    stamp = target / ".sha256"
    if stamp.is_file() and stamp.read_text().strip() == expected and (target / marker).exists():
        return
    with tempfile.TemporaryDirectory(dir=PROJECT / "tools") as scratch:
        archive = download(url, Path(scratch) / "download.zip", expected)
        with zipfile.ZipFile(archive) as zipped:
            zipped.extractall(Path(scratch) / "files")
        found = next((Path(scratch) / "files").rglob(marker), None)
        if found is None:
            sys.exit(f"{url} has no {marker}")
        if target.exists():
            shutil.rmtree(target)
        shutil.move(str(found.parent), str(target))
    stamp.write_text(expected + "\n")
    print(f"Installed {target.relative_to(PROJECT)}", flush=True)


def official_arm64_build_runs():
    """Whether this processor runs llama.cpp's official Windows ARM64 build.

    That build is compiled for armv8.7-a, which takes int8 matrix multiply
    and bfloat16 for granted: Snapdragon X and Apple M2 or later have them,
    while Apple M1 (under Parallels) and the Snapdragon 8cx family don't, and
    there the server died loading the model with 0xC000001D, an illegal
    instruction. Windows reports the features; the numbers are winnt.h's
    PF_ARM_V82_DP_INSTRUCTIONS_AVAILABLE, _V82_I8MM_ and _V86_BF16_.
    """
    import ctypes

    present = ctypes.windll.kernel32.IsProcessorFeaturePresent
    return all(present(feature) for feature in (43, 66, 68))


def llama_source(arch, gpu, build):
    """(url, sha256) of the llama.cpp build for this machine."""
    if arch == "arm64" and (build == "baseline" or (build is None and not official_arm64_build_runs())):
        expected = LLAMA_BASELINE.get(LLAMA_BUILD)
        if expected is None:
            raise LookupError(
                f"This processor can't run llama.cpp's official ARM64 build, and this "
                f"project's build of llama.cpp {LLAMA_BUILD} for it is not pinned in "
                f"scripts/fetch.py. Build llama-server as described in docs/DEVELOPMENT.md "
                f"and point \"llama_server\" in bin/config.json at it.")
        return (f"{GITHUB}/{REPOSITORY}/releases/download/llama-{LLAMA_BUILD}/"
                f"llama-{LLAMA_BUILD}-bin-win-cpu-arm64-armv8.2.zip", expected)
    flavour, expected = LLAMA[f"{arch}-{gpu}" if gpu else arch]
    return (f"{GITHUB}/ggml-org/llama.cpp/releases/download/{LLAMA_BUILD}/"
            f"llama-{LLAMA_BUILD}-bin-{flavour}.zip", expected)


def configured_llama_server():
    """The llama-server named in bin/config.json, if that file exists: one
    built by hand for a processor no published build fits."""
    try:
        config = json.loads((PROJECT / "bin" / "config.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    path = config.get("llama_server")
    if not path:
        return None
    path = Path(path) if Path(path).is_absolute() else PROJECT / path
    return path if path.is_file() else None


def model(repository, revision, filename, expected):
    from huggingface_hub import hf_hub_download

    path = Path(hf_hub_download(repository, filename, revision=revision))
    if sha256(path) != expected:
        path.unlink(missing_ok=True)
        sys.exit(f"Checksum mismatch for {repository}/{filename}; run setup again")
    print(f"Model {repository}/{filename}", flush=True)


def voice_hashes(name):
    """The pinned checksums of a default voice, or the ones Hugging Face
    publishes for another: SHA-256 for the model (stored in LFS), and for the
    small .json the git blob id, which is a SHA-1 over its bytes."""
    if name in VOICES:
        return [("sha256", value) for value in VOICES[name]]
    repository, revision = VOICES_REPO
    request = urllib.request.Request(
        f"https://huggingface.co/api/models/{repository}/paths-info/{revision}",
        data=urllib.parse.urlencode([("paths", voice_path(name, suffix))
                                     for suffix in (".onnx", ".onnx.json")]).encode())
    with urllib.request.urlopen(request, timeout=60) as response:
        info = {item["path"]: item for item in json.load(response)}
    model_info = info.get(voice_path(name, ".onnx"))
    config_info = info.get(voice_path(name, ".onnx.json"))
    if not model_info or not config_info:
        sys.exit(f"No Piper voice {name} in {repository}")
    return [("sha256", model_info["lfs"]["oid"]), ("git-blob", config_info["oid"])]


def voice_path(name, suffix):
    """ru_RU-dmitri-medium -> ru/ru_RU/dmitri/medium/ru_RU-dmitri-medium.onnx"""
    locale, speaker, quality = name.split("-", 2)
    return f"{locale.split('_')[0]}/{locale}/{speaker}/{quality}/{name}{suffix}"


def fetch_voice(name):
    repository, revision = VOICES_REPO
    base = f"https://huggingface.co/{repository}/resolve/{revision}/"
    for suffix, (kind, expected) in zip((".onnx", ".onnx.json"), voice_hashes(name)):
        target = PROJECT / "voices" / f"{name}{suffix}"
        url = base + voice_path(name, suffix)
        if kind == "sha256":
            download(url, target, expected)
            continue
        with urllib.request.urlopen(url, timeout=60) as response:
            data = response.read()
        if hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest() != expected:
            sys.exit(f"Checksum mismatch for {url}")
        target.write_bytes(data)
    print(f"Voice {name}", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--arch", choices=["arm64", "x64"], required=True)
    parser.add_argument("--gpu", choices=["vulkan"])
    # Only to test one build on a machine that would get the other.
    parser.add_argument("--llama-build", choices=["official", "baseline"])
    options = parser.parse_args()
    if options.gpu and options.arch != "x64":
        sys.exit("llama.cpp publishes its Vulkan build for x64 Windows only")
    (PROJECT / "tools").mkdir(exist_ok=True)

    # A missing translation engine must not stop the rest from downloading:
    # it is reported at the end, and everything else is ready by then.
    problems = []
    own = configured_llama_server()
    if own:
        print(f"Using {own} from bin/config.json", flush=True)
    else:
        try:
            unpack(*llama_source(options.arch, options.gpu, options.llama_build),
                   "tools/llama", "llama-server.exe")
        except LookupError as error:
            problems.append(str(error))
    triple, expected = DENO[options.arch]
    unpack(f"{GITHUB}/denoland/deno/releases/download/{DENO_VERSION}/"
           f"deno-{triple}-pc-windows-msvc.zip", expected, "tools/deno", "deno.exe")
    unpack(*ESPEAK_DATA, "voices/espeak-ng-data", "phontab")
    download(SILERO_VAD[0], PROJECT / "cache" / "models" / "silero_vad.onnx", SILERO_VAD[1])
    names = os.environ.get("DUB_VOICE_NAMES", " ".join(VOICES)).split()
    for name in names:
        fetch_voice(name)
    for entry in MODELS:
        model(*entry)
    if problems:
        sys.exit("\n".join(problems))


if __name__ == "__main__":
    main()
