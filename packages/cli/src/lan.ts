import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { resolveStableHostId } from '@termbridge/settings';
import { acquireHostLease } from '@termbridge/settings';
import { pairingUri } from './pairing.js';
import { RelayTopologySchema, type RelayTopology } from '@termbridge/protocol';
import { checkLanHost } from './lanHostCheck.js';

declare const __TB_BUNDLED__: boolean;
const bundled = typeof __TB_BUNDLED__ !== 'undefined' && __TB_BUNDLED__;
export interface LanConfiguration {
  address: string; port: number; password?: string;
  mode?: 'direct' | 'relay' | 'join'; shareLocalHost?: boolean;
}
export function unicastIPv4(value: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return false;
  const pieces = value.split('.');
  if (pieces.some(part => part.length > 1 && part.startsWith('0'))) return false;
  const n = pieces.map(Number);
  if (n.some(x => x > 255)) return false;
  return n[0]! > 0 && n[0]! < 224;
}
export function validateLanConfiguration(value: LanConfiguration): void {
  if (!value || typeof value.address !== 'string') throw new Error('请输入有效的服务地址');
  if (value.mode !== undefined && !['direct', 'relay', 'join'].includes(value.mode)) throw new Error('服务模式无效');
  if (value.shareLocalHost !== undefined && typeof value.shareLocalHost !== 'boolean') throw new Error('共享本机设置无效');
  if (value.mode === 'join') {
    if (!unicastIPv4(value.address) && !/^(?=.{1,253}$)[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)*$/i.test(value.address)) {
      throw new Error('请输入中转机 IP 或主机名，不含协议和端口');
    }
    if (/^[\d.]+$/.test(value.address) && !unicastIPv4(value.address)) throw new Error('中转机 IP 无效');
  } else if (!unicastIPv4(value.address)) throw new Error('请选择这台 Mac 的 IPv4 地址');
  if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) throw new Error('端口须为 1024–65535');
  if (value.password !== undefined && (typeof value.password !== 'string' || value.password.length < 1 || value.password.length > 256)) {
    throw new Error('连接密码须为 1–256 个字符');
  }
}
function atomic(path: string, data: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, data, { mode: 0o600 }); renameSync(temp, path); chmodSync(path, 0o600);
}
export interface LanDiagnostic { source: 'supervisor' | 'relay' | 'host'; code: string; fields: Record<string, string> }
export async function startLan(value: LanConfiguration, options: { directory?: string; dist?: string; signal?: AbortSignal;
  diagnostic?: (event: LanDiagnostic) => void; topology?: (value: RelayTopology) => void;
  connectionState?: (connected: boolean) => void; failure?: (message: string) => void } = {}) {
  const report = (code: string, fields: Record<string, string> = {}) => options.diagnostic?.({ source: 'supervisor', code, fields });
  validateLanConfiguration(value);
  // The binding must belong to this machine. Corporate networks may use an
  // assigned address outside RFC1918; private-range membership is not ownership.
  const local = Object.values(networkInterfaces()).flat().some(entry => entry?.address === value.address);
  if (value.mode !== 'join' && !local) throw new Error('所选 IP 不在这台 Mac 上，请重新选择当前内网地址');
  const mode = value.mode ?? 'direct';
  const sharesHost = mode !== 'relay' || value.shareLocalHost !== false;
  const directory = options.directory || join(homedir(), 'Library/Application Support/TermBridge/LAN');
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  const lease = acquireHostLease(join(directory, 'service.pid'));
  const children: ChildProcess[] = [];
  let stopping: Promise<void> | undefined;
  let failed = false;
  let onExit: (() => void) | undefined;
  const stop = (): Promise<void> => stopping ??= (async () => {
    report('stopping');
    await Promise.all(children.map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('close', () => { clearTimeout(timeout); resolve(); });
      child.kill('SIGTERM');
    })));
    options.signal?.removeEventListener('abort', abort);
    lease.release();
    report('stopped');
  })();
  const abort = () => { void stop(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (options.signal?.aborted) throw new Error('启动已取消');
    const path = join(directory, 'connection.json');
    const previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as LanConfiguration : undefined;
    const samePasswordScope = mode === 'join'
      ? previous?.mode === 'join' && previous.address === value.address && previous.port === value.port
      : previous?.mode !== 'join';
    const password = value.password || (samePasswordScope ? previous?.password : undefined)
      || (mode !== 'join' ? randomBytes(24).toString('base64url') : undefined);
    if (!password) throw new Error('请输入中转机的连接密码');
    validateLanConfiguration({ ...value, password });
    // LAN uses password authentication over WS. Leave legacy certificate files
    // in the owned scope for backups, but never load or regenerate them.
    const hostId = resolveStableHostId();
    if (mode === 'join') await checkLanHost(`ws://${value.address}:${value.port}`, password, hostId, options.signal);
    const config = { ...value, mode, password };
    atomic(join(directory, 'settings.json'), JSON.stringify({ networkPolicy: 'direct' }));
    const bridge = join('/tmp', `termbridge-lan-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(directory).digest('hex').slice(0, 16)}.sock`);
    const env = { ...process.env, PORT: String(value.port), TB_RELAY_BIND: value.address,
      RELAY_URL: `ws://${value.address}:${value.port}`, HOST_ID: hostId, HOST_NAME: hostname(),
      TB_RELAY_ID: `lan:${hostId}:${value.port}`, TB_RELAY_NAME: hostname(),
      TB_LAN_PARENT: '1', TB_SETTINGS: join(directory, 'settings.json'), TB_SECRET: password,
      TB_TLS_CERT: '', TB_TLS_KEY: '', TB_TLS_PIN: '', TB_RELAY_NO_TLS: '1',
      TB_BRIDGE_SOCK: bridge, TB_HOST_STATE_DIR: directory,
      TB_BRAIN_STATE: join(directory, 'brain.json'), TB_CONTEXT_STATE: join(directory, 'context.json'),
      TB_BRAIN_MEMORY: join(directory, 'memory.md'), TB_VOICE_LEARNING_DIR: join(directory, 'voice-learning'),
      TB_VOICE_PIPELINE_DIR: join(directory, 'voice-pipeline'), TB_VOICE_USAGE_LEDGER: join(directory, 'voice-usage.jsonl'),
      TB_VOICE_DIAGNOSTICS_LOG: join(directory, 'voice-events.jsonl'),
    };
    const here = dirname(fileURLToPath(import.meta.url));
    const launch = async (target: 'relay' | 'host', event: string) => {
      if (stopping || options.signal?.aborted) throw new Error('启动已取消');
      const root = join(here, '../../..');
      const command = process.execPath;
      const args = options.dist ? [join(options.dist, `${target}.js`)] : bundled ? [join(here, `${target}.js`)]
        : ['--import', join(root, 'node_modules/tsx/dist/loader.mjs'), join(root, `packages/${target}/src/index.ts`)];
      const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      children.push(child);
      report('child_started', { source: target, pid: String(child.pid ?? ''), step: event });
      child.on('message', (message: unknown) => {
        if (stopping) return;
        const data = message as { event?: string; code?: string; fields?: Record<string, unknown>; topology?: unknown };
        if (data?.event === 'host_conflict') {
          options.failure?.('此中转上已有服务共享本机，请使用已有连接或停止原共享服务。');
          return;
        }
        if (target === (mode === 'join' ? 'host' : 'relay') && data?.event === 'topology') {
          const result = RelayTopologySchema.safeParse(data.topology);
          if (result.success) options.topology?.(result.data);
          return;
        }
        if (target === 'host' && mode === 'join') {
          if (data?.event === 'relay_disconnected') options.connectionState?.(false);
          else if (data?.event === 'ready') options.connectionState?.(true);
        }
        if (data?.event !== 'diagnostic' || !['listening', 'bind_failed', 'http_probe', 'socket_open', 'socket_closed', 'socket_error', 'auth_accepted', 'auth_rejected', 'client_rejected', 'host_registered'].includes(data.code ?? '')) return;
        const allowed = ['attempt', 'address', 'port', 'code', 'closeCode', 'cause', 'protocol', 'httpStatus'];
        const fields = Object.fromEntries(Object.entries(data.fields ?? {}).filter(([key, value]) => allowed.includes(key) && ['string', 'number'].includes(typeof value)).map(([key, value]) => [key, String(value).slice(0, 128)]));
        options.diagnostic?.({ source: target, code: data.code!, fields });
      });
      child.once('exit', (code, signal) => {
        report('child_exited', { source: target, code: String(code ?? ''), signal: signal ?? '', status: stopping ? 'requested' : 'unexpected' });
        if (!stopping) { failed = true; void stop().then(() => onExit?.()); }
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { report('startup_timeout', { source: target, step: event }); finish(new Error('内网服务启动超时，请检查端口是否被占用')); }, 20000);
        const finish = (error?: Error) => {
          clearTimeout(timer); child.off('message', message); child.off('error', errored); child.off('exit', exited);
          error ? reject(error) : resolve();
        };
        const message = (message: unknown) => {
          const data = message as { event?: string; code?: string; fields?: { code?: string } };
          if (data?.event === event) { report('child_ready', { source: target }); finish(); }
          else if (data?.event === 'host_conflict') finish(new Error('此中转上已有服务共享本机，请使用已有连接或停止原共享服务。'));
          else if (data?.event === 'diagnostic' && data.code === 'bind_failed' && data.fields?.code === 'EADDRINUSE') {
            finish(new Error(`端口 ${value.port} 已被占用（可能是 tb serve）。请改用空闲端口；若要接入已有中转，请在共享本机中填写它的地址。`));
          }
        };
        const errored = (error: NodeJS.ErrnoException) => { report('child_error', { source: target, code: error.code ?? 'UNKNOWN' }); finish(new Error('无法启动内置服务')); };
        const exited = () => finish(new Error('内网服务已退出，请检查运行组件或端口'));
        child.on('message', message); child.once('error', errored); child.once('exit', exited);
      });
      if (failed || stopping) throw new Error('内网服务启动已中断');
    };
    if (mode !== 'join') await launch('relay', 'listening');
    if (sharesHost) await launch('host', 'ready');
    atomic(path, JSON.stringify(config));
    report('configuration_saved', { address: value.address, port: String(value.port), passwordConfigured: 'true', protocol: 'ws' });
    return { stop, onExit(callback: () => void) { onExit = callback; if (failed) callback(); },
      info: { event: 'ready', address: value.address, port: value.port, hostId, mode, sharesHost,
        bridgeSocket: sharesHost ? bridge : undefined,
        pairing: pairingUri({ relayUrl: env.RELAY_URL, secret: password, hostId: sharesHost ? hostId : '',
          hostName: sharesHost ? hostname() : '内网中转', mode: 'direct' }) } };
  } catch (error) { await stop(); throw error; }
}

/** Private JSON stdin/stdout interface owned by the native App. EOF stops its children. */
export async function runLanApp(): Promise<void> {
  const cancellation = new AbortController();
  let input = '', started = false, closed = false;
  let service: Awaited<ReturnType<typeof startLan>> | undefined;
  const close = () => { closed = true; cancellation.abort(); process.stdin.destroy(); void service?.stop(); };
  process.stdin.setEncoding('utf8');
  process.stdin.on('end', close); process.on('SIGTERM', close); process.on('SIGINT', close);
  process.stdin.on('data', chunk => {
    if (started) return;
    input += chunk;
    if (input.length > 4096) { started = true; close(); process.stdin.destroy(); return; }
    if (!input.includes('\n')) return;
    started = true;
    void (async () => {
      try {
        const config = JSON.parse(input.slice(0, input.indexOf('\n'))) as LanConfiguration;
        input = '';
        service = await startLan(config, { signal: cancellation.signal, directory: process.env.TB_LAN_DIR,
          failure: message => console.log(JSON.stringify({ event: 'error', message })),
          topology: topology => console.log(JSON.stringify({ event: 'topology', topology })),
          connectionState: connected => console.log(JSON.stringify({ event: 'connection_state', connected })),
          diagnostic: diagnostic => console.log(JSON.stringify({ event: 'diagnostic', ...diagnostic })) });
        if (closed) { await service.stop(); return; }
        service.onExit(() => { console.log(JSON.stringify({ event: 'stopped' })); process.stdin.destroy(); });
        console.log(JSON.stringify(service.info));
      } catch (error) {
        console.log(JSON.stringify({ event: 'error', message: (error as Error).message }));
        process.stdin.destroy(); process.exitCode = 1;
      }
    })();
  });
}
