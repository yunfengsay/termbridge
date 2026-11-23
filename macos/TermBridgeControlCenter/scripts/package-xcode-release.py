#!/usr/bin/env python3
"""Use Xcode's logged-in account and cloud-managed Developer ID signing."""
import argparse
import datetime
import os
import pathlib
import plistlib
import re
import shutil
import subprocess
import tempfile
import time

PROJECT = pathlib.Path(__file__).resolve().parent.parent


def run(*args, capture=False, env=None):
    result = subprocess.run(list(map(str, args)), check=True, env=env,
                            stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.STDOUT if capture else None, text=True)
    return result.stdout if capture else None


def write_plist(path, value):
    with path.open('wb') as stream:
        plistlib.dump(value, stream)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--resume', type=pathlib.Path, help='Resume exporting an already submitted .xcarchive')
    args = parser.parse_args()
    if args.resume:
        archive = args.resume.resolve()
        if not (archive / 'Info.plist').is_file():
            parser.error('Archive does not exist')
        work = archive.parent
    else:
        identities = run('security', 'find-identity', '-v', '-p', 'codesigning', capture=True)
        candidates = re.findall(r'([A-Fa-f0-9]{40}) "(Apple Development:[^"]+)"', identities)
        selected = os.environ.get('TB_MACOS_DEVELOPMENT_IDENTITY')
        if selected:
            candidates = [item for item in candidates if selected in item]
        if len(candidates) != 1:
            parser.error('Set TB_MACOS_DEVELOPMENT_IDENTITY to exactly one installed Apple Development identity name or hash')
        identity_hash, identity_name = candidates[0]
        (PROJECT / 'dist').mkdir(exist_ok=True)
        work = pathlib.Path(tempfile.mkdtemp(prefix='xcode-release-', dir=PROJECT / 'dist'))
        archive = work / 'TermBridge.xcarchive'
        app = archive / 'Products/Applications/TermBridge.app'
        env = dict(os.environ, TB_MACOS_SIGN_IDENTITY='-', TB_MACOS_OUTPUT_APP=str(app))
        env.pop('TB_MACOS_NOTARY_PROFILE', None)
        run(PROJECT / 'scripts/package-app.sh', env=env)
        info_path = app / 'Contents/Info.plist'
        with info_path.open('rb') as stream:
            info = plistlib.load(stream)
        info.update(CFBundleSupportedPlatforms=['MacOSX'], DTPlatformName='macosx')
        write_plist(info_path, info)
        run('python3', PROJECT / 'scripts/sign-app.py', app, identity_hash)
        details = run('codesign', '-dv', '--verbose=2', app, capture=True)
        team = re.search(r'^TeamIdentifier=([A-Z0-9]{10})$', details, re.MULTILINE)
        if not team:
            raise RuntimeError('Development-signed archive has no TeamIdentifier')
        properties = {'ApplicationPath': 'Applications/TermBridge.app', 'Architectures': ['arm64'],
                      'SigningIdentity': identity_name, 'Team': team[1]}
        for key in ['CFBundleIdentifier', 'CFBundleShortVersionString', 'CFBundleVersion']:
            properties[key] = info[key]
        write_plist(archive / 'Info.plist', {'ArchiveVersion': 2, 'Name': 'TermBridge', 'SchemeName': 'TermBridge',
                    'CreationDate': datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None),
                    'ApplicationProperties': properties})
        options = work / 'ExportOptions.plist'
        write_plist(options, {'method': 'developer-id', 'destination': 'upload',
                             'signingStyle': 'automatic', 'teamID': team[1]})
        print(f'Archive retained for retry: {archive}', flush=True)
        run('xcodebuild', '-exportArchive', '-archivePath', archive,
            '-exportOptionsPlist', options, '-allowProvisioningUpdates')
    export = pathlib.Path(tempfile.mkdtemp(prefix='notarized-', dir=work))
    # Upload completion precedes Apple's notarization result. Retry only the
    # documented processing state; rejected archives must fail immediately.
    for attempt in range(30):
        result = subprocess.run(['xcodebuild', '-exportNotarizedApp', '-archivePath', str(archive),
                                 '-exportPath', str(export)], text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        print(result.stdout, end='', flush=True)
        if result.returncode == 0:
            break
        if 'is processing and not ready for distribution' not in result.stdout or attempt == 29:
            raise RuntimeError(f'Notarized export failed; retry with --resume {archive}')
        print('Apple is still processing; checking again in 20 seconds.', flush=True)
        time.sleep(20)
    app = export / 'TermBridge.app'
    run('codesign', '--verify', '--deep', '--strict', app)
    details = run('codesign', '-dv', '--verbose=2', app, capture=True)
    if 'Authority=Developer ID Application:' not in details or '(runtime)' not in details:
        raise RuntimeError('Export lacks Developer ID signing or hardened runtime')
    run('xcrun', 'stapler', 'validate', app)
    run('spctl', '--assess', '--type', 'execute', '--verbose=2', app)
    destination = PROJECT / 'dist/TermBridge.app'
    if destination.is_symlink():
        raise RuntimeError('Refusing to replace a symlinked release app')
    if destination.exists():
        # This is the reproducible build output, never the installed user app.
        # Do not create previous-app backups during routine packaging.
        shutil.rmtree(destination)
    shutil.move(app, destination)
    print(f'Verified notarized app: {destination}')


if __name__ == '__main__':
    main()
