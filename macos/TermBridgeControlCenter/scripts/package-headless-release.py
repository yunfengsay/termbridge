#!/usr/bin/env python3
"""Build with a dedicated signing keychain instead of Xcode account access."""
import argparse
import ctypes
import json
import os
from pathlib import Path
import stat
import subprocess

DEFAULT_CONFIG = Path.home() / '.termbridge/macos-release/config.json'


def private_file(path):
    path = Path(path).expanduser()
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError(f'Private release file must be owned by this user and mode 0600: {path}')
    return path


def unlock_keychain(path, password):
    # Keep the password out of process arguments, shell history and tool output.
    security = ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
    core = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    security.SecKeychainSetUserInteractionAllowed.argtypes = [ctypes.c_ubyte]
    security.SecKeychainSetUserInteractionAllowed.restype = ctypes.c_int32
    security.SecKeychainOpen.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
    security.SecKeychainOpen.restype = ctypes.c_int32
    security.SecKeychainUnlock.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_ubyte]
    security.SecKeychainUnlock.restype = ctypes.c_int32
    core.CFRelease.argtypes = [ctypes.c_void_p]
    core.CFRelease.restype = None
    status = security.SecKeychainSetUserInteractionAllowed(False)
    if status:
        raise RuntimeError(f'Cannot disable keychain dialogs (OSStatus {status})')
    keychain = ctypes.c_void_p()
    status = security.SecKeychainOpen(os.fsencode(path), ctypes.byref(keychain))
    if status:
        raise RuntimeError(f'Cannot open release keychain (OSStatus {status})')
    try:
        secret = ctypes.create_string_buffer(password)
        try:
            status = security.SecKeychainUnlock(keychain, len(password), secret, True)
        finally:
            ctypes.memset(secret, 0, len(secret))
        if status:
            raise RuntimeError(f'Cannot unlock release keychain (OSStatus {status})')
    finally:
        core.CFRelease(keychain)


def release_environment(config_file):
    config = json.loads(private_file(config_file).read_text())
    keychain = private_file(config['keychain'])
    password_file = private_file(config['passwordFile'])
    password = password_file.read_bytes().rstrip(b'\r\n')
    if not password:
        raise ValueError('Release keychain password file is empty')
    identity = config['identity']
    if not isinstance(identity, str) or not identity.startswith('Developer ID Application: '):
        raise ValueError('A local Developer ID Application identity is required')
    profile = config['notaryProfile']
    if not isinstance(profile, str) or not profile:
        raise ValueError('A notarytool credential profile is required')
    unlock_keychain(keychain, password)
    identities = subprocess.run(['/usr/bin/security', 'find-identity', '-v', '-p', 'codesigning', str(keychain)],
                                capture_output=True, text=True, check=True).stdout
    if f'"{identity}"' not in identities:
        raise RuntimeError('The release keychain lacks the requested signing certificate/private key')
    # Refuse to build if authentication is not provisioned. This path does not
    # fall back to Xcode's GUI account or to ad-hoc signing.
    result = subprocess.run(['/usr/bin/xcrun', 'notarytool', 'history', '--keychain-profile', profile,
                             '--keychain', str(keychain), '--output-format', 'json'],
                            capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError('Notary credentials failed validation; provision the release keychain profile first')
    env = dict(os.environ, TB_MACOS_SIGN_IDENTITY=identity,
               TB_MACOS_SIGNING_KEYCHAIN=str(keychain), TB_MACOS_NOTARY_KEYCHAIN=str(keychain),
               TB_MACOS_NOTARY_PROFILE=profile)
    if config.get('sparkleKeyFile'):
        env['TB_SPARKLE_KEY_FILE'] = str(private_file(config['sparkleKeyFile']))
    return env


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=DEFAULT_CONFIG)
    parser.add_argument('--check', action='store_true', help='Verify keychain, signing identity and notary credentials only')
    parser.add_argument('--publish-site', action='store_true', help='Build, validate and deploy the download site from already signed release artifacts')
    args = parser.parse_args()
    if args.check and args.publish_site:
        parser.error('--check and --publish-site are mutually exclusive')
    try:
        env = release_environment(args.config)
        print('Dedicated signing identity and notary credentials are ready.', flush=True)
        if args.publish_site:
            if not env.get('TB_SPARKLE_KEY_FILE'):
                raise ValueError('sparkleKeyFile is required for unattended update-feed signing')
            env.setdefault('TB_MACOS_FORMAT', 'zip')
            site = Path(__file__).resolve().parents[3] / 'cloudflare/downloads-site'
            subprocess.run(['node', 'scripts/build-release.mjs'], cwd=site, env=env, check=True)
            subprocess.run(['npm', 'run', 'deploy'], cwd=site, env=env, check=True)
        elif not args.check:
            subprocess.run([str(Path(__file__).with_name('package-app.sh'))], env=env, check=True)
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        # Do not print command arguments or captured credential-tool output.
        if isinstance(error, subprocess.SubprocessError):
            parser.exit(1, 'Headless release command failed; inspect the build stage above.\n')
        parser.exit(1, f'{error}\n')


if __name__ == '__main__':
    main()
