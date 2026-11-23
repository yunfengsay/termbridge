"""Pinned JAEC frontend. No cloud calls, NumPy, torch, or audio playback.

ABI reference: modelscope/models/audio/aec/jaec.py (Apache-2.0).
One instance per call; paired mic/render-reference PCM16 at 16 kHz.
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import platform
import sys
import tempfile
import time
import urllib.request
import wave

MODEL = "iic/speech_jaec_aec_16k"
REVISION = "d8726e8b2b743a9f9093ae77bc6dcd317c78ea33"
WEIGHTS = "40234f7abea80b238c2804d7ebe2b63cfa5d12a1c86a6e7895d40f80f1bca75d"
LIBRARIES = {
    ("Darwin", "arm64"): ("jaec_arm.so", "8525c25c5e5da0796a152b30a228d0699e29876e12277a2388c37e59f77b558a"),
    ("Linux", "x86_64"): ("jaec_x86.so", "854a09f4634d806daee2150409ad1921eae013589bab9568fefa1874678fd9e8"),
    ("Windows", "amd64"): ("jaec_x86.dll", "3405118fd72be5142625e8384bdad10425352f4ac650b3be8ff350e98a65cf93"),
}
FRAME_BYTES = 320
READY = b"JAECv1\r\n"
NOTICES = [
    ("LICENSE", "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30"),
    ("THIRD_PARTY_NOTICES.md", "acd22b80554b8eedc7ce9737d14eb7ab142d9964eac6a5150a04169a5d37d246"),
]


def artifacts():
    key = (platform.system(), platform.machine().lower())
    if key not in LIBRARIES or sys.byteorder != "little":
        raise RuntimeError("JAEC native runtime does not support this platform")
    name, digest = LIBRARIES[key]
    return [("lib/" + name, digest), ("weights/tde_lp.bin", WEIGHTS)]


def checked(path, digest):
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != digest:
        raise RuntimeError("JAEC artifact checksum mismatch")
    return data


def install(root):
    """Explicit opt-in only. Never execute or silently replace unverified code."""
    for relative, digest in artifacts() + NOTICES:
        destination = root / relative
        if destination.exists():
            checked(destination, digest)
            continue
        url = f"https://modelscope.cn/api/v1/models/{MODEL}/repo?Revision={REVISION}&FilePath={relative}"
        with urllib.request.urlopen(url, timeout=30) as response:
            data = response.read(8 * 1024 * 1024 + 1)
        if hashlib.sha256(data).hexdigest() != digest:
            raise RuntimeError("JAEC download checksum mismatch; nothing loaded")
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, temporary = tempfile.mkstemp(dir=destination.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
            os.replace(temporary, destination)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


class Jaec:
    def __init__(self, root):
        files = artifacts()
        for relative, digest in files + NOTICES:
            checked(root / relative, digest)
        self.handle = None
        self.native = ctypes.CDLL(str((root / files[0][0]).resolve()))
        pcm = ctypes.POINTER(ctypes.c_int16)
        self.native.jaec_frontend_create.argtypes = [ctypes.c_char_p]
        self.native.jaec_frontend_create.restype = ctypes.c_void_p
        self.native.jaec_frontend_destroy.argtypes = [ctypes.c_void_p]
        self.native.jaec_frontend_destroy.restype = None
        self.native.jaec_frontend_reset.argtypes = [ctypes.c_void_p]
        self.native.jaec_frontend_reset.restype = None
        self.native.jaec_frontend_process.argtypes = [ctypes.c_void_p, pcm, pcm, ctypes.c_int, pcm]
        self.native.jaec_frontend_process.restype = ctypes.c_int
        self.handle = self.native.jaec_frontend_create(os.fsencode(root / files[1][0]))
        if not self.handle:
            raise RuntimeError("JAEC initialization failed")

    def process(self, mic, reference):
        if not self.handle:
            raise RuntimeError("JAEC is closed")
        if len(mic) != FRAME_BYTES or len(reference) != FRAME_BYTES:
            raise ValueError("JAEC needs paired 160-sample PCM16 frames")
        frame = ctypes.c_int16 * 160
        output = frame()
        status = self.native.jaec_frontend_process(self.handle, frame.from_buffer_copy(mic),
                                                  frame.from_buffer_copy(reference), 160, output)
        if status != 0:
            raise RuntimeError("JAEC processing failed")
        return bytes(output)

    def reset(self):
        if not self.handle:
            raise RuntimeError("JAEC is closed")
        self.native.jaec_frontend_reset(self.handle)

    def close(self):
        if self.handle:
            self.native.jaec_frontend_destroy(self.handle)
            self.handle = None


def process_wav(engine, mic_path, reference_path, output_path):
    if output_path.exists():
        raise ValueError("Output already exists; choose a new filename")
    with wave.open(str(mic_path), "rb") as mic, wave.open(str(reference_path), "rb") as reference:
        for audio in [mic, reference]:
            if (audio.getframerate(), audio.getnchannels(), audio.getsampwidth(), audio.getcomptype()) != (16000, 1, 2, "NONE"):
                raise ValueError("Inputs must be 16 kHz mono PCM16 WAV; resample explicitly")
        samples = mic.getnframes()
        if samples == 0 or samples != reference.getnframes():
            raise ValueError("Microphone and playback reference must have equal nonzero length")
        engine.reset()
        elapsed = 0
        with output_path.open("xb") as file, wave.open(file, "wb") as output:
            output.setparams((1, 2, 16000, samples, "NONE", "not compressed"))
            while True:
                a, b = mic.readframes(160), reference.readframes(160)
                if not a:
                    break
                start = time.perf_counter()
                cleaned = engine.process(a.ljust(FRAME_BYTES, b"\0"), b.ljust(FRAME_BYTES, b"\0"))
                elapsed += time.perf_counter() - start
                output.writeframesraw(cleaned[:len(a)])
    return {"samples": samples, "audioSeconds": samples / 16000, "processingSeconds": elapsed,
            "rtf": elapsed / (samples / 16000), "algorithmicDelayMs": 22}


def serve(engine):
    sys.stdout.buffer.write(READY)
    sys.stdout.buffer.flush()
    while True:
        pair = sys.stdin.buffer.read(FRAME_BYTES * 2)
        if not pair:
            return
        if len(pair) != FRAME_BYTES * 2:
            raise ValueError("Truncated JAEC mic/reference frame")
        sys.stdout.buffer.write(engine.process(pair[:FRAME_BYTES], pair[FRAME_BYTES:]))
        sys.stdout.buffer.flush()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["install", "process", "serve"])
    parser.add_argument("--model-dir", type=Path, default=Path.home() / ".termbridge/models/jaec" / WEIGHTS[:12])
    parser.add_argument("--mic", type=Path)
    parser.add_argument("--reference", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.operation == "install":
        install(args.model_dir)
        print(json.dumps({"status": "installed", "model": MODEL, "sha256": WEIGHTS}))
        return
    engine = Jaec(args.model_dir)
    try:
        if args.operation == "serve":
            serve(engine)
        else:
            if not all([args.mic, args.reference, args.output]):
                parser.error("process requires --mic, --reference and --output")
            print(json.dumps(process_wav(engine, args.mic, args.reference, args.output)))
    finally:
        engine.close()


if __name__ == "__main__":
    main()
