#!/usr/bin/env python3
"""Exercise the actual Security.framework unlock path on a disposable keychain."""
import ctypes
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('headless', Path(__file__).with_name('package-headless-release.py'))
headless = importlib.util.module_from_spec(spec)
spec.loader.exec_module(headless)


class HeadlessReleaseTests(unittest.TestCase):
    def test_locked_keychain_unlocks_without_shell_password_arguments_or_dialogs(self):
        with tempfile.TemporaryDirectory(prefix='tb-signing-keychain-test-') as directory:
            path = Path(directory) / 'fixture.keychain-db'
            # This password protects only this empty disposable test fixture.
            password = 'termbridge-test-fixture-only'
            subprocess.run(['/usr/bin/security', 'create-keychain', '-p', password, str(path)],
                           check=True, capture_output=True)
            try:
                subprocess.run(['/usr/bin/security', 'lock-keychain', str(path)], check=True)
                headless.unlock_keychain(path, password.encode())
                api = ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
                api.SecKeychainOpen.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
                api.SecKeychainGetStatus.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
                keychain, status = ctypes.c_void_p(), ctypes.c_uint32()
                self.assertEqual(api.SecKeychainOpen(os.fsencode(path), ctypes.byref(keychain)), 0)
                try:
                    self.assertEqual(api.SecKeychainGetStatus(keychain, ctypes.byref(status)), 0)
                    self.assertTrue(status.value & 1, 'Security.framework must report the keychain unlocked')
                finally:
                    core = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
                    core.CFRelease.argtypes = [ctypes.c_void_p]
                    core.CFRelease(keychain)
                subprocess.run(['/usr/bin/security', 'lock-keychain', str(path)], check=True)
                with self.assertRaisesRegex(RuntimeError, 'OSStatus'):
                    headless.unlock_keychain(path, b'incorrect-fixture-password')
            finally:
                subprocess.run(['/usr/bin/security', 'delete-keychain', str(path)], check=True, capture_output=True)

    def test_shared_password_file_is_rejected_before_reading_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'password'
            path.write_text('test-fixture')
            path.chmod(0o644)
            with self.assertRaisesRegex(ValueError, '0600'):
                headless.private_file(path)
            path.chmod(0o600)
            self.assertEqual(headless.private_file(path), path)


if __name__ == '__main__':
    unittest.main()
