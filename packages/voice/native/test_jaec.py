"""Offline tests; set TB_JAEC_MODEL_DIR for pinned real-native tests. Never plays audio."""
import hashlib
import io
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import wave

import jaec


class Passthrough:
    def __init__(self):
        self.resets = 0
        self.frames = []

    def reset(self):
        self.resets += 1

    def process(self, mic, reference):
        self.frames.append((mic, reference))
        return mic


def wav(path, data, rate=16000):
    with wave.open(str(path), "wb") as output:
        output.setparams((1, 2, rate, len(data) // 2, "NONE", "not compressed"))
        output.writeframes(data)


class JaecTests(unittest.TestCase):
    def test_checksum_rejects_untrusted_code(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "library"
            path.write_bytes(b"untrusted")
            with self.assertRaisesRegex(RuntimeError, "checksum"):
                jaec.checked(path, hashlib.sha256(b"trusted").hexdigest())

    def test_unsupported_android_not_mistaken_for_macos_arm(self):
        with patch.object(jaec.platform, "system", return_value="Linux"), \
                patch.object(jaec.platform, "machine", return_value="aarch64"):
            with self.assertRaisesRegex(RuntimeError, "does not support"):
                jaec.artifacts()

    def test_existing_invalid_cache_not_replaced_or_downloaded(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "weights").write_bytes(b"bad")
            with patch.object(jaec, "artifacts", return_value=[("weights", "invalid")]), \
                    patch.object(jaec.urllib.request, "urlopen") as request:
                with self.assertRaisesRegex(RuntimeError, "checksum"):
                    jaec.install(root)
                request.assert_not_called()
                self.assertEqual((root / "weights").read_bytes(), b"bad")

    def test_wav_keeps_stream_state_and_partial_tail(self):
        with tempfile.TemporaryDirectory() as directory:
            mic, ref, output = [Path(directory) / name for name in ["mic.wav", "ref.wav", "out.wav"]]
            data = struct.pack("<321h", *range(321))
            wav(mic, data)
            wav(ref, bytes(len(data)))
            engine = Passthrough()
            stats = jaec.process_wav(engine, mic, ref, output)
            self.assertEqual(stats["samples"], 321)
            self.assertEqual(engine.resets, 1)
            self.assertEqual(len(engine.frames), 3)
            self.assertTrue(all(len(a) == len(b) == 320 for a, b in engine.frames))
            with wave.open(str(output)) as result:
                self.assertEqual(result.readframes(1000), data)
            with self.assertRaisesRegex(ValueError, "already exists"):
                jaec.process_wav(engine, mic, ref, output)

    def test_rejects_sample_rate_mismatch_and_unaligned_reference(self):
        with tempfile.TemporaryDirectory() as directory:
            mic, ref, output = [Path(directory) / name for name in ["mic.wav", "ref.wav", "out.wav"]]
            wav(mic, bytes(320), rate=48000)
            wav(ref, bytes(320))
            with self.assertRaisesRegex(ValueError, "16 kHz"):
                jaec.process_wav(Passthrough(), mic, ref, output)
            wav(mic, bytes(640))
            with self.assertRaisesRegex(ValueError, "equal nonzero"):
                jaec.process_wav(Passthrough(), mic, ref, output)
            self.assertFalse(output.exists())

    def test_binary_protocol_and_truncated_frame(self):
        incoming, outgoing = io.BytesIO(bytes(640)), io.BytesIO()
        with patch.object(jaec.sys, "stdin") as stdin, patch.object(jaec.sys, "stdout") as stdout:
            stdin.buffer, stdout.buffer = incoming, outgoing
            jaec.serve(Passthrough())
        self.assertEqual(outgoing.getvalue(), jaec.READY + bytes(320))
        with patch.object(jaec.sys, "stdin") as stdin, patch.object(jaec.sys, "stdout") as stdout:
            stdin.buffer, stdout.buffer = io.BytesIO(bytes(639)), io.BytesIO()
            with self.assertRaisesRegex(ValueError, "Truncated"):
                jaec.serve(Passthrough())


@unittest.skipUnless(os.environ.get("TB_JAEC_MODEL_DIR"), "real native test is opt-in")
class NativeTests(unittest.TestCase):
    def test_synthetic_linear_echo_is_reduced_without_clipping(self):
        from benchmark_jaec import run
        result = run(Path(os.environ["TB_JAEC_MODEL_DIR"]))
        self.assertEqual(result["samples"], 160000)
        self.assertEqual(result["clippedSamples"], 0)
        self.assertGreater(result["steadyStateErleDb"], 20)

    def test_native_reset_shutdown_and_invalid_frames(self):
        engine = jaec.Jaec(Path(os.environ["TB_JAEC_MODEL_DIR"]))
        try:
            first = b"".join(engine.process(bytes(320), bytes(320)) for _ in range(100))
            engine.reset()
            second = b"".join(engine.process(bytes(320), bytes(320)) for _ in range(100))
            self.assertEqual(first, second)
            self.assertEqual(first, bytes(32000))
            with self.assertRaises(ValueError):
                engine.process(bytes(319), bytes(320))
        finally:
            engine.close()
            engine.close()
        with self.assertRaises(RuntimeError):
            engine.process(bytes(320), bytes(320))

    def test_real_subprocess_pipe(self):
        child = subprocess.run([sys.executable, str(Path(jaec.__file__)), "serve", "--model-dir",
                                os.environ["TB_JAEC_MODEL_DIR"]], input=bytes(640 * 200),
                               capture_output=True, timeout=15, check=True)
        self.assertEqual(child.stdout, jaec.READY + bytes(320 * 200))
        self.assertEqual(child.stderr, b"")


if __name__ == "__main__":
    unittest.main()
