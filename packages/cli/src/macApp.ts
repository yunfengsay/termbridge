import { execFile } from 'node:child_process';
import { createHash, createPublicKey, randomUUID, verify as verifySignature } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix } from 'node:path';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';

const exec = promisify(execFile);
export const APP_SITE = 'https://termbridge-a0k.pages.dev';
const BUNDLE = 'dev.termbridge.controlcenter';
const TEAM = 'WU6H4A72FC';
const MAX_ARCHIVE = 256 * 1024 * 1024;
export interface MacAppRelease { version: string; build: string; url: string; sha256: string; size: number; minOS: string }
export function macAppRelease(manifest: unknown): MacAppRelease {
  const value = (manifest as { schema?: number; macos?: Record<string, unknown> })?.macos;
  if ((manifest as { schema?: number })?.schema !== 1 || !value || value.arch !== 'arm64' || value.format !== 'zip' || value.notarized !== true ||
      typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.version) ||
      typeof value.build !== 'string' || !/^\d+$/.test(value.build) ||
      typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      typeof value.url !== 'string' || !/^\/download\/TermBridge-[a-zA-Z0-9.-]+\.zip\?v=[a-f0-9]{12}$/.test(value.url) ||
      typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_ARCHIVE ||
      typeof value.minOS !== 'string' || !/^\d+(\.\d+){0,2}$/.test(value.minOS)) throw new Error('官网 macOS 下载信息无效，请稍后重试。');
  return value as unknown as MacAppRelease;
}

const UPDATE_KEY = createPublicKey({ key: Buffer.concat([
  Buffer.from('302a300506032b6570032100', 'hex'),
  Buffer.from('wwp7b4BX/H20gTMLey/BngTUNgk4YsWtm1mH7V33NZY=', 'base64'),
]), format: 'der', type: 'spki' });
export function verifyAppDownload(feed: Buffer, archive: Buffer, release: MacAppRelease): void {
  const text = feed.toString('utf8');
  const trailer = text.match(/<!-- sparkle-signatures:\nedSignature: ([A-Za-z0-9+/=]+)\nlength: (\d+)\n-->\n$/);
  if (!trailer || Number(trailer[2]) !== feed.length - Buffer.byteLength(trailer[0]) ||
      !verifySignature(null, feed.subarray(0, Number(trailer[2])), UPDATE_KEY, Buffer.from(trailer[1], 'base64'))) throw new Error('App 更新信息签名无效。');
  const items = [...text.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  if (items.length !== 1 || !items[0][1].includes(`<sparkle:version>${release.build}</sparkle:version>`) ||
      !items[0][1].includes(`<sparkle:shortVersionString>${release.version}</sparkle:shortVersionString>`)) throw new Error('App 更新版本校验失败。');
  const enclosure = items[0][1].match(/<enclosure\s+([^>]+)>/);
  const attrs = Object.fromEntries([...(enclosure?.[1] ?? '').matchAll(/([\w:]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
  if (attrs.url !== APP_SITE + release.url || Number(attrs.length) !== archive.length || archive.length !== release.size ||
      !verifySignature(null, archive, UPDATE_KEY, Buffer.from(attrs['sparkle:edSignature'] ?? '', 'base64'))) throw new Error('App 下载包签名无效。');
}

/** Validate ZIP paths and link targets before extraction; Sparkle contains legitimate internal symlinks. */
export function validateAppArchive(bytes: Buffer): void {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > bytes.length || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length ||
      bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) throw new Error('Unsupported app ZIP');
  let offset = bytes.readUInt32LE(end + 16); const count = bytes.readUInt16LE(end + 10);
  if (!count || count > 20_000 || offset + bytes.readUInt32LE(end + 12) !== end) throw new Error('Invalid ZIP directory');
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP entry');
    const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const next = offset + 46 + nameLength + extra + comment;
    if (next > end) throw new Error('Invalid ZIP bounds');
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if ((!name.startsWith('TermBridge.app/') && !name.startsWith('__MACOSX/')) || name.includes('\\') || /[\x00-\x1f\x7f]/.test(name) || name.split('/').includes('..')) throw new Error('Unsafe app ZIP path');
    const mode = bytes.readUInt32LE(offset + 38) >>> 16;
    if ((mode & 0xf000) === 0xa000) {
      const local = bytes.readUInt32LE(offset + 42), size = bytes.readUInt32LE(offset + 20);
      if (local + 30 > offset || size > 16_384 || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid ZIP link');
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      if (start + size > offset) throw new Error('Invalid ZIP link bounds');
      const compressed = bytes.subarray(start, start + size), method = bytes.readUInt16LE(offset + 10);
      const data = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed, { maxOutputLength: 4096 }) : undefined;
      if (!data || data.length > 4096) throw new Error('Invalid ZIP link compression');
      const target = data.toString('utf8');
      if (!target || target.startsWith('/') || target.includes('\\') || /[\x00-\x1f\x7f]/.test(target) ||
          !posix.resolve('/', posix.dirname(name), target).startsWith('/' + name.split('/')[0] + '/')) throw new Error('Unsafe app ZIP link');
    }
    offset = next;
  }
  if (offset !== end) throw new Error('Invalid ZIP directory size');
}

export type AppRunner = (command: string, args: string[]) => Promise<string>;
const run: AppRunner = async (command, args) => {
  const result = await exec(command, args, { timeout: 180_000, maxBuffer: 1024 * 1024, env: process.env });
  return result.stdout.trim();
};
const exists = async (path: string) => { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } };
const plist = async (app: string, key: string, runner: AppRunner) => runner('/usr/libexec/PlistBuddy', ['-c', `Print ${key}`, join(app, 'Contents/Info.plist')]);
async function verify(app: string, runner: AppRunner): Promise<void> {
  await runner('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', `=anchor apple generic and identifier "${BUNDLE}" and certificate leaf[subject.OU] = "${TEAM}" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists`, app]);
  await runner('/usr/sbin/spctl', ['--assess', '--type', 'execute', app]);
  if (await plist(app, 'CFBundleIdentifier', runner) !== BUNDLE) throw new Error('Unexpected app identity');
}
export class MacAppInstaller {
  readonly application: string;
  constructor(readonly home = homedir(), readonly runner: AppRunner = run, readonly exactApplication?: string) {
    this.application = exactApplication ?? join(home, 'Applications/TermBridge.app');
  }
  async status() {
    for (const path of this.exactApplication ? [this.application] : [this.application, '/Applications/TermBridge.app']) {
      if (await exists(path)) return { path, version: await plist(path, 'CFBundleShortVersionString', this.runner), build: await plist(path, 'CFBundleVersion', this.runner) };
    }
    return undefined;
  }
  async open() {
    const app = await this.status(); if (!app) throw new Error('未安装 App，请先运行 tb app install。');
    await verify(app.path, this.runner);
    await this.runner('/usr/bin/open', [app.path]);
  }
  async install(log: (message: string) => void = console.log) {
    const architecture = await this.runner('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64']);
    if (architecture !== '1') throw new Error('官网目前提供 Apple Silicon 版 App；Intel Mac 请等待对应安装包。');
    const parent = join(this.application, '..'); await mkdir(parent, { recursive: true });
    const work = await mkdtemp(join(parent, '.termbridge-install-'));
    try {
      const manifest = join(work, 'manifest.json');
      const download = async (url: string, destination: string, limit: number) => this.runner('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '20', '--max-time', '120', '--retry', '1', '--max-filesize', String(limit), '--output', destination, url]);
      log('正在检查官网 macOS 版本…');
      await download(`${APP_SITE}/downloads/manifest.json`, manifest, 128 * 1024);
      const release = macAppRelease(JSON.parse(await readFile(manifest, 'utf8')));
      const system = await this.runner('/usr/bin/sw_vers', ['-productVersion']);
      const versionNumber = (version: string) => version.split('.').slice(0, 3).reduce((total, n, i) => total + Number(n) * [1_000_000, 1000, 1][i], 0);
      if (versionNumber(system) < versionNumber(release.minOS)) throw new Error(`需要 macOS ${release.minOS} 或更高版本。`);
      const installed = await this.status();
      if (installed && /^\d+$/.test(installed.build) && BigInt(installed.build) >= BigInt(release.build)) {
        await verify(installed.path, this.runner); log(`App ${installed.version} 已安装：${installed.path}`); return installed;
      }
      // The executable must not be in use during replacement. App updates use Sparkle when running.
      if (installed) {
        try {
          const pids = await this.runner('/usr/sbin/lsof', ['-t', join(installed.path, 'Contents/MacOS/TermBridgeControlCenter')]);
          if (pids) throw new Error('APP_RUNNING');
        } catch (error) {
          if ((error as { code?: unknown }).code !== 1) {
            if (error instanceof Error && error.message === 'APP_RUNNING') throw new Error('请先正常退出 TermBridge App 再安装，或在 App 设置中检查更新。');
            throw error;
          }
        }
      }
      log(`正在下载 TermBridge ${release.version}…`);
      const archive = join(work, 'app.zip'); await download(APP_SITE + release.url, archive, MAX_ARCHIVE);
      const bytes = await readFile(archive);
      if (bytes.length !== release.size || createHash('sha256').update(bytes).digest('hex') !== release.sha256) throw new Error('下载校验失败，原 App 未更改。');
      const feed = join(work, 'appcast.xml');
      await download(`${APP_SITE}/appcast.xml`, feed, 128 * 1024);
      verifyAppDownload(await readFile(feed), bytes, release);
      validateAppArchive(bytes);
      await this.runner('/usr/bin/ditto', ['-x', '-k', archive, work]);
      const candidate = join(work, 'TermBridge.app');
      log('正在验证 Apple 签名与公证…'); await verify(candidate, this.runner);
      if (await plist(candidate, 'CFBundleShortVersionString', this.runner) !== release.version || await plist(candidate, 'CFBundleVersion', this.runner) !== release.build) throw new Error('下载包版本与官网不一致。');
      const backup = this.application + '.backup-' + randomUUID();
      const replacing = await exists(this.application);
      if (replacing) await rename(this.application, backup);
      try { await rename(candidate, this.application); }
      catch (error) { if (replacing) await rename(backup, this.application); throw error; }
      log(`已安装 ${release.version}：${this.application}`);
      if (replacing) log(`原版本备份：${backup}`);
      log('运行 tb app open 打开 App。');
      return { path: this.application, version: release.version, build: release.build };
    } finally { await rm(work, { recursive: true, force: true }); }
  }
}
