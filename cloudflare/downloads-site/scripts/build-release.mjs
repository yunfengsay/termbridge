import { verifyAppcast } from './verify-appcast.mjs';
import { renderSite } from './render-site.mjs';
import { readFile, writeFile, mkdir, cp, rm, readdir, mkdtemp, symlink, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
const site = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(site, '../..');
const dist = join(site, 'dist');
const staging = await mkdtemp(join(site, '.release-'));
const scratch = await mkdtemp(join(tmpdir(), 'termbridge-downloads-'));
const hash = (buffer, algorithm = 'sha256') => createHash(algorithm).update(buffer).digest('hex');
const sizeLabel = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const safeVersion = version => { if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid artifact version'); return version; };
async function packageAsset(platform, version, extension, bytes, type, extra = {}) {
  const sha256 = hash(bytes);
  const { fileName, ...metadata } = extra;
  const file = fileName || `termbridge-${platform}-${version}-${sha256.slice(0, 12)}.${extension}`;
  if (!/^[A-Za-z0-9._-]+$/.test(file)) throw new Error('Invalid download filename');
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += 20 * 1024 * 1024) {
    const chunk = bytes.subarray(offset, offset + 20 * 1024 * 1024);
    const part = `${file}${fileName ? `.${sha256.slice(0, 12)}` : ''}.part${parts.length}`;
    await writeFile(join(staging, 'downloads', part), chunk);
    parts.push({ file: part, size: chunk.length, sha256: hash(chunk) });
  }
  return { version, file, url: `/download/${file}${fileName ? `?v=${sha256.slice(0, 12)}` : ''}`, size: bytes.length, sha256, type, parts, ...metadata };
}
try {
  await cp(join(site, 'public'), staging, { recursive: true });
  await mkdir(join(staging, 'downloads'));
  const requestedCLI = process.env.TB_CLI_VERSION ? safeVersion(process.env.TB_CLI_VERSION) : 'latest';
  const npmResponse = await fetch(`https://registry.npmjs.org/agent-termbridge/${requestedCLI}`);
  if (!npmResponse.ok) throw new Error(`npm metadata: ${npmResponse.status}`);
  const npm = await npmResponse.json();
  const cliVersion = safeVersion(npm.version);
  if (requestedCLI !== 'latest' && cliVersion !== requestedCLI) throw new Error('Unexpected npm version');
  const cliUrl = `https://registry.npmjs.org/agent-termbridge/-/agent-termbridge-${cliVersion}.tgz`;
  if (npm.name !== 'agent-termbridge' || npm.version !== cliVersion || npm.dist.tarball !== cliUrl) throw new Error('Unexpected npm artifact');
  const cliResponse = await fetch(cliUrl);
  if (!cliResponse.ok) throw new Error(`npm tarball: ${cliResponse.status}`);
  const cliBytes = Buffer.from(await cliResponse.arrayBuffer());
  const integrity = `sha512-${createHash('sha512').update(cliBytes).digest('base64')}`;
  if (npm.dist.integrity !== integrity) throw new Error('npm integrity mismatch');
  const cli = { version: cliVersion, file: `agent-termbridge-${cliVersion}.tgz`, url: cliUrl, size: cliBytes.length, sha256: hash(cliBytes), integrity };

  const apkPath = resolve(process.env.TB_ANDROID_APK || join(repo, 'android/app/build/outputs/apk/debug/app-debug.apk'));
  // Snapshot the build output before inspecting it; another agent may be rebuilding Android.
  const apk = await readFile(apkPath);
  const snapshot = join(scratch, 'android.apk');
  await writeFile(snapshot, apk);
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(homedir(), 'Library/Android/sdk');
  const buildTools = (await readdir(join(sdk, 'build-tools'))).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
  const badging = execFileSync(join(sdk, 'build-tools', buildTools, 'aapt'), ['dump', 'badging', snapshot], { encoding: 'utf8' });
  const info = badging.match(/^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/m);
  if (!info || info[1] !== 'com.termbridge.android') throw new Error('Unexpected Android package');
  execFileSync(join(sdk, 'build-tools', buildTools, 'apksigner'), ['verify', snapshot], { stdio: 'pipe' });
  const android = await packageAsset('android', safeVersion(info[3]), 'apk', apk, 'application/vnd.android.package-archive', { channel: 'debug', versionCode: Number(info[2]), minSdk: Number(badging.match(/^sdkVersion:'(\d+)'/m)?.[1]) });
  if (android.minSdk !== 24 || !badging.includes('application-debuggable')) throw new Error('Update page requirements/channel to match this APK');

  const app = resolve(process.env.TB_MACOS_APP || join(repo, 'macos/TermBridgeControlCenter/dist/TermBridge.app'));
  const appSnapshot = join(scratch, 'TermBridge.app');
  execFileSync('/usr/bin/ditto', [app, appSnapshot]);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appSnapshot], { stdio: 'pipe' });
  const plist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(appSnapshot, 'Contents/Info.plist')], { encoding: 'utf8' }));
  const arch = execFileSync('/usr/bin/lipo', ['-archs', join(appSnapshot, 'Contents/MacOS', plist.CFBundleExecutable)], { encoding: 'utf8' }).trim();
  if (plist.CFBundleIdentifier !== 'dev.termbridge.controlcenter' || arch !== 'arm64' || plist.LSMinimumSystemVersion !== '13.0') throw new Error('Update Mac page requirements for this artifact');
  if (plist.CFBundleName !== 'TermBridge' || plist.CFBundleDisplayName !== 'TermBridge' || plist.CFBundleIconFile !== 'AppIcon.icns') throw new Error('Mac bundle branding is incomplete');
  const icon = await readFile(join(appSnapshot, 'Contents/Resources/AppIcon.icns'));
  if (icon.subarray(0, 4).toString() !== 'icns') throw new Error('Missing Mac app icon');
  const macFormat = process.env.TB_MACOS_FORMAT || 'dmg';
  if (!['dmg', 'zip'].includes(macFormat)) throw new Error('TB_MACOS_FORMAT must be dmg or zip');
  let notarized = false;
  let macArtifact;
  if (macFormat === 'zip') {
    // Xcode cloud signing keeps the private key at Apple. Distribute its exported,
    // stapled app directly; ZIP containers themselves do not carry code signatures.
    execFileSync('/usr/bin/xcrun', ['stapler', 'validate', appSnapshot], { stdio: 'pipe' });
    execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', appSnapshot], { stdio: 'pipe' });
    macArtifact = join(scratch, 'TermBridge.zip');
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appSnapshot, macArtifact]);
    notarized = true;
  } else {
  const diskRoot = join(scratch, 'disk');
  await mkdir(diskRoot);
  execFileSync('/usr/bin/ditto', [appSnapshot, join(diskRoot, 'TermBridge.app')]);
  await symlink('/Applications', join(diskRoot, 'Applications'));
  await writeFile(join(diskRoot, '.VolumeIcon.icns'), icon);
  const dmg = join(scratch, 'TermBridge.dmg');
  const writableDisk = join(scratch, 'writable.dmg');
  const mountPoint = join(scratch, 'mounted');
  execFileSync('/usr/bin/hdiutil', ['create', '-volname', 'TermBridge', '-srcfolder', diskRoot, '-fs', 'HFS+', '-format', 'UDRW', writableDisk], { stdio: 'pipe' });
  execFileSync('/usr/bin/hdiutil', ['attach', '-nobrowse', '-mountpoint', mountPoint, writableDisk], { stdio: 'pipe' });
  try {
    execFileSync('/usr/bin/xcrun', ['SetFile', '-a', 'C', mountPoint]);
  } finally {
    execFileSync('/usr/bin/hdiutil', ['detach', mountPoint], { stdio: 'pipe' });
  }
  execFileSync('/usr/bin/hdiutil', ['convert', writableDisk, '-format', 'UDZO', '-o', dmg], { stdio: 'pipe' });
  if (process.env.TB_MACOS_NOTARY_PROFILE) {
    const identity = process.env.TB_MACOS_SIGN_IDENTITY;
    if (!identity?.startsWith('Developer ID Application: ')) throw new Error('Developer ID Application identity is required for notarized downloads');
    // The enclosed app must already carry its own ticket for offline installation.
    execFileSync('/usr/bin/xcrun', ['stapler', 'validate', appSnapshot], { stdio: 'pipe' });
    execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', appSnapshot], { stdio: 'pipe' });
    const keychainArgs = process.env.TB_MACOS_SIGNING_KEYCHAIN ? ['--keychain', process.env.TB_MACOS_SIGNING_KEYCHAIN] : [];
    execFileSync('/usr/bin/codesign', ['--force', '--timestamp', '--sign', identity, ...keychainArgs, dmg], { stdio: 'pipe' });
    execFileSync(join(repo, 'macos/TermBridgeControlCenter/scripts/notarize-artifact.sh'), [dmg], { stdio: 'inherit' });
    notarized = true;
  }
    macArtifact = dmg;
  }
  const macVersion = safeVersion(plist.CFBundleShortVersionString);
  const macos = await packageAsset('macos-arm64', macVersion, macFormat, await readFile(macArtifact), macFormat === 'zip' ? 'application/zip' : 'application/x-apple-diskimage', { fileName: `TermBridge-${macVersion}-macOS-AppleSilicon.${macFormat}`, channel: notarized ? 'release' : 'preview', format: macFormat, arch, minOS: plist.LSMinimumSystemVersion, notarized });
  if (plist.SUFeedURL) {
    if (!notarized || macFormat !== 'zip') throw new Error('App updates require a notarized ZIP release');
    if (plist.SUFeedURL !== 'https://termbridge-a0k.pages.dev/appcast.xml' || !plist.SUPublicEDKey) throw new Error('Unexpected update feed or missing signing key');
    const updates = join(scratch, 'updates');
    await mkdir(updates);
    await cp(macArtifact, join(updates, macos.file));
    await cp(join(repo, 'macos/TermBridgeControlCenter/Resources/ReleaseNotes.md'), join(updates, macos.file.replace(/\.zip$/, '.md')));
    const sparkleBin = process.env.TB_SPARKLE_BIN || join(repo, 'macos/TermBridgeControlCenter/.build/artifacts/sparkle/Sparkle/bin');
    let signingArgs = ['--account', 'dev.termbridge.controlcenter'];
    if (process.env.TB_SPARKLE_KEY_FILE) {
      const keyFile = resolve(process.env.TB_SPARKLE_KEY_FILE);
      const keyInfo = await stat(keyFile);
      if (!keyInfo.isFile() || keyInfo.uid !== process.getuid() || (keyInfo.mode & 0o077) !== 0) {
        throw new Error('Sparkle key file must be owned by this user and mode 0600');
      }
      signingArgs = ['--ed-key-file', keyFile];
    }
    execFileSync(join(sparkleBin, 'generate_appcast'), [...signingArgs,
      '--download-url-prefix', 'https://termbridge-a0k.pages.dev/download/',
      '--link', 'https://termbridge-a0k.pages.dev/', '--embed-release-notes',
      '--maximum-deltas', '0', updates], { stdio: 'pipe' });
    const appcastPath = join(updates, 'appcast.xml');
    // Reuse the website's content-addressed URL so a repeated marketing version
    // with a higher build number cannot fetch an older CDN-cached archive.
    const feed = await readFile(appcastPath, 'utf8');
    const plainURL = `https://termbridge-a0k.pages.dev/download/${macos.file}`;
    if (!feed.includes(`url="${plainURL}"`)) throw new Error('Generated appcast has an unexpected download URL');
    await writeFile(appcastPath, feed.replace(`url="${plainURL}"`, `url="https://termbridge-a0k.pages.dev${macos.url}"`));
    execFileSync(join(sparkleBin, 'sign_update'), [...signingArgs, appcastPath], { stdio: 'pipe' });
    await cp(appcastPath, join(staging, 'appcast.xml'));
    macos.build = plist.CFBundleVersion;
    macos.updateFeed = plist.SUFeedURL;
    macos.updatePublicKey = plist.SUPublicEDKey;
    verifyAppcast(await readFile(join(staging, 'appcast.xml')), await readFile(macArtifact), macos, plist.SUPublicEDKey);
  }
  // Windows is optional: the site keeps its previous state unless an installer is
  // supplied, so a release without a fresh Windows build cannot silently ship a
  // stale one under a new version number.
  let windows = { available: false };
  if (process.env.TB_WINDOWS_SETUP) {
    const setupPath = resolve(process.env.TB_WINDOWS_SETUP);
    const setupBytes = await readFile(setupPath);
    const named = setupPath.match(/TermBridge-Setup-(\d+\.\d+\.\d+)-x64\.exe$/);
    if (!named) throw new Error('Windows installer must be named TermBridge-Setup-<version>-x64.exe');
    if (setupBytes.subarray(0, 2).toString('latin1') !== 'MZ') throw new Error('Windows installer is not a PE image');
    const winVersion = safeVersion(named[1]);
    // The bundled offline CLI is what gives the Windows app a Host; record which
    // one it is instead of assuming it matches the published npm release.
    const bundledCLI = process.env.TB_WINDOWS_CLI_VERSION ? safeVersion(process.env.TB_WINDOWS_CLI_VERSION) : undefined;
    windows = await packageAsset('windows-x64', winVersion, 'exe', setupBytes, 'application/vnd.microsoft.portable-executable',
      { fileName: `TermBridge-Setup-${winVersion}-x64.exe`, channel: 'preview', arch: 'x64', installScope: 'user',
        ...(bundledCLI ? { bundledCLI } : {}) });
  }
  const manifest = { schema: 1, builtAt: new Date().toISOString(), cli, android, macos, windows, ios: { available: false } };
  await writeFile(join(staging, 'downloads/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(staging, 'downloads/checksums.txt'), [cli, android, macos, ...(windows.file ? [windows] : [])].map(a => `${a.sha256}  ${a.file}`).join('\n') + '\n');
  await renderSite(staging, manifest);
  // Functions run only for downloads; the landing page and static assets stay static.
  await writeFile(join(staging, '_routes.json'), JSON.stringify({ version: 1, include: ['/download/*'], exclude: [] }));
  await rm(dist, { recursive: true, force: true });
  await cp(staging, dist, { recursive: true });
  console.log(JSON.stringify({ cli: cli.version, android: { version: android.version, size: sizeLabel(android.size), parts: android.parts.length }, macos: { version: macos.version, size: sizeLabel(macos.size), arch }, windows: windows.file ? { version: windows.version, size: sizeLabel(windows.size), parts: windows.parts.length } : 'not supplied' }, null, 2));
} finally {
  await rm(staging, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
}
