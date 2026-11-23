#!/usr/bin/env python3
"""Sign known nested Sparkle code from the inside out, then the application."""
import pathlib
import os
import subprocess
import sys

app = pathlib.Path(sys.argv[1])
identity = sys.argv[2]
keychain = os.environ.get('TB_MACOS_SIGNING_KEYCHAIN')
keychain_args = ['--keychain', keychain] if keychain and identity != '-' else []
framework = app / 'Contents/Frameworks/Sparkle.framework'
if not framework.is_dir():
    raise SystemExit('Missing embedded Sparkle.framework')
version = (framework / 'Versions/Current').resolve(strict=True)
targets = [version / 'XPCServices/Downloader.xpc', version / 'XPCServices/Installer.xpc',
           version / 'Autoupdate', version / 'Updater.app', framework, app]
runtime = app / 'Contents/Resources/Runtime'
# Embedded Node and native addons must be signed before sealing the App resources.
for binary in runtime.rglob('*'):
    if binary.is_file() and not binary.is_symlink():
        with binary.open('rb') as stream:
            magic = stream.read(4)
        if magic in (b'\xcf\xfa\xed\xfe', b'\xce\xfa\xed\xfe', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca'):
            args = ['codesign', '--force', '--sign', identity, *keychain_args]
            if identity != '-':
                args += ['--options', 'runtime', '--timestamp']
                if binary == runtime / 'node':
                    args += ['--entitlements', str(pathlib.Path(__file__).with_name('node-entitlements.plist'))]
            subprocess.run([*args, str(binary)], check=True)
for target in targets:
    args = ['codesign', '--force', '--sign', identity, *keychain_args]
    if target != app:
        args += ['--preserve-metadata=entitlements']
    if identity != '-':
        args += ['--options', 'runtime', '--timestamp']
    subprocess.run([*args, str(target)], check=True)
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
