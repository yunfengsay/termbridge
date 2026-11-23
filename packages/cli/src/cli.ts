import { registerAutomation } from './automation.js';
import { controlDaemon } from './automationTransport.js';
// Unified `tb` / `termbridge` entrypoint.
//
//   tb                            start the local daemon (same as `tb serve`)
//   tb surf                       start the local daemon (relay + host in one)
//   tb new <agent>                new session from a preset (claude, codex, …)
//   tb new -- <cmd...>            new session from a raw command
//   tb ls                         list sessions (with short #)
//   tb <#|id>                     attach to a session by number or id
//   tb attach <#|id>              same, explicit
//   tb kill <#|id>                kill a session
//   tb @<hostId> <...>            target a specific host (when >1 online)
//
// relay / host (and `surf`, which is both) run as separate processes — they
// need a listening socket / node-pty. Bundled (npm), `tb` spawns the sibling
// dist/relay.js & dist/host.js with the same node; in dev it spawns tsx against
// the repo source. Client commands run in-process.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Command, Option } from 'commander';
import { MacAppInstaller } from './macApp.js';
import { readTopology, formatTopology } from './topology.js';
import { callPeer } from './peerNetwork.js';
import { setupLAN, passwordFromStdin } from './setup.js';
import { ServeSupervisor } from './serveSupervisor.js';
import { updateCLI } from './update.js';
import { printLearningStatus } from './voiceLearning.js';
import { pipelineCommand } from './voicePipeline.js';
import { trainingCommand } from './voiceTraining.js';
import { registerToolScriptCommands } from './toolScripts.js';
import { registerScreenCommands } from './screen.js';
import { runLanApp } from './lan.js';
import pc from 'picocolors';
import * as p from '@clack/prompts';
import {
  setMiddle,
  getMiddle,
  middleToUrl,
  MIDDLE_PORT,
  setSecret,
  getSecret,
  resolveSecret,
  generateSelfSigned,
  getPin,
  setPin,
  normalizeFp,
  getExpose,
  setExpose,
  peerAuditPath,
  type ExposeSettings,
  type FsMode,
  getNetworkPolicy,
  setNetworkPolicy,
  hasProxyForUrl,
  resolveRelayUrl,
  type NetworkPolicy,
} from '@termbridge/settings';
import { runDesktop } from './desktop.js';
import { runAttach, runInfo, runKill, runList, runNew, runRemove, runRestart, runSet } from './client.js';
import { ok, fail } from './ui.js';
import { getInitStatus, installInit, runAgentShim, uninstallInit, type InterceptedAgent } from './init.js';
import { cloudflareDeploy, cloudflareLogin, cloudflarePair, cloudflareStatus, cloudflareUse } from './cloudflare.js';
import { runContextList, runContextSearch, runContextShow } from './context.js';
import { validatePairingSecret } from './pairing.js';
import { HostServiceManager, type HostServiceStatus } from './hostService.js';

// bundled (npm): here = …/dist, and relay.js/host.js sit beside cli.js.
// dev (tsx):     here = packages/cli/src, three levels under the repo root.
const here = dirname(fileURLToPath(import.meta.url));

// Replaced with `true` by esbuild's `define` when bundling; undefined under tsx.
declare const __TB_BUNDLED__: boolean;
declare const __TB_VERSION__: string;
const BUNDLED = typeof __TB_BUNDLED__ !== 'undefined' && __TB_BUNDLED__ === true;
const VERSION = typeof __TB_VERSION__ !== 'undefined'
  ? __TB_VERSION__
  : (JSON.parse(readFileSync(join(here, '..', '..', '..', 'package.json'), 'utf8')) as { version: string }).version;

type Target = 'relay' | 'host';

/** Spawn a long-running daemon (relay/host) as a child of `tb`. */
function spawnTarget(target: Target, env: Record<string, string | undefined> = {}, ipc = false): ChildProcess {
  const opts = { stdio: ipc ? ['inherit', 'inherit', 'inherit', 'ipc'] as ('inherit' | 'ipc')[] : 'inherit' as const, env: { ...process.env, ...env } };
  if (BUNDLED) return spawn(process.execPath, [join(here, `${target}.js`)], opts);
  const repoRoot = join(here, '..', '..', '..');
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  return spawn(tsxBin, [join(repoRoot, `packages/${target}/src/index.ts`)], opts);
}

/** Spawn a daemon and exit `tb` with its exit code (foreground subcommands). */
function runTarget(target: Target, env: Record<string, string | undefined> = {}): void {
  const child = spawnTarget(target, env);
  child.on('exit', (code) => process.exit(code ?? 0));
}

function hostServiceManager(): HostServiceManager {
  if (BUNDLED) {
    const hostEntrypoint = join(here, 'host.js');
    return new HostServiceManager({
      nodePath: process.execPath,
      hostEntrypoint,
      executableArgs: [hostEntrypoint],
    });
  }
  const repoRoot = join(here, '..', '..', '..');
  const hostEntrypoint = join(repoRoot, 'packages/host/src/index.ts');
  return new HostServiceManager({
    nodePath: join(repoRoot, 'node_modules', '.bin', 'tsx'),
    hostEntrypoint,
    executableArgs: [hostEntrypoint],
  });
}

function printHostServiceStatus(status: HostServiceStatus): void {
  const state = status.running ? pc.green('running') : status.state === 'stopped' ? pc.yellow('stopped') : pc.cyan(status.state);
  console.log(pc.dim('  Host          ') + state + (status.pid ? pc.dim(`  pid ${status.pid}`) : ''));
  console.log(pc.dim('  login start   ') + (status.loginStart ? pc.green('enabled') : pc.dim('disabled')));
  console.log(pc.dim('  service       ') + status.plist);
  console.log(pc.dim('  logs          ') + status.logFile);
}

function hostServiceAction(action: (service: HostServiceManager) => void): void {
  try {
    action(hostServiceManager());
  } catch (error) {
    fail((error as Error).message);
    process.exitCode = 1;
  }
}

function networkPolicyCommand(value?: string): void {
  const normalized = value?.trim().toLowerCase();
  if (normalized && normalized !== 'system' && normalized !== 'direct') {
    fail('network policy must be system or direct');
    process.exitCode = 1;
    return;
  }
  const previous = getNetworkPolicy();
  if (normalized) setNetworkPolicy(normalized as NetworkPolicy);
  const policy = getNetworkPolicy();
  const relayUrl = resolveRelayUrl();
  console.log(pc.dim('  network       ') + (policy === 'direct' ? pc.cyan('direct') : pc.green('system')));
  console.log(pc.dim('  relay         ') + relayUrl);
  console.log(pc.dim('  env proxy     ') + (hasProxyForUrl(relayUrl) ? pc.yellow('matched') : pc.dim('not matched')));
  if (normalized && previous !== policy) {
    ok(`network policy saved as ${policy}`);
    console.log(pc.dim('  background Host applies it after reconnect; run ') + pc.cyan('tb host restart') + pc.dim(' to force that now'));
  }
  if (policy === 'direct') {
    console.log(pc.dim('  direct ignores HTTP_PROXY/HTTPS_PROXY/ALL_PROXY; an OS-level VPN may still route the socket'));
  }
}

/** The local daemon: relay + host in one command. */
function surf(): void {
  if (process.platform !== 'win32') {
    const port = process.env.PORT ?? '7400';
    const packageRoot = BUNDLED ? join(here, '..') : join(here, '../../..');
    const service = new ServeSupervisor({ packageRoot,
      watchReplacement: BUNDLED && (!!process.env.TB_APP_BUNDLE || here.includes('/Contents/Resources/Runtime/')),
      version: () => JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version,
      launch: target => spawnTarget(target, { TB_LAN_PARENT: '1', ...(target === 'relay'
        ? { PORT: port, TB_RELAY_NO_TLS: '1' } : { RELAY_URL: `ws://127.0.0.1:${port}` }) }, true),
      failed: error => { fail(error.message); process.exitCode = 1; },
    });
    const stop = () => { void service.stop().then(() => { process.exitCode = 0; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    void service.start().catch(error => { fail((error as Error).message); process.exitCode = 1; });
    return;
  }
  const port = process.env.PORT ?? '7400';
  const relay = spawnTarget('relay', { PORT: port, TB_RELAY_NO_TLS: '1' });
  const host = spawnTarget('host', { RELAY_URL: `ws://127.0.0.1:${port}` });
  const killBoth = () => {
    for (const c of [relay, host]) {
      try {
        c.kill();
      } catch {
        /* noop */
      }
    }
  };
  relay.on('exit', () => {
    killBoth();
    process.exit(0);
  });
  host.on('exit', () => {
    killBoth();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    killBoth();
    process.exit(0);
  });
}

/**
 * `tb middle …` — the shared relay (e.g. your VPS) that the Mac mini host AND
 * remote clients both dial, so they meet across networks without port-forwarding.
 *   serve        run the relay here (the server), default port 8001
 *   set <ip>     make THIS machine dial that relay
 *   unset        go back to the local relay
 *   (bare)       show the current setting
 */
function middle(args: string[]): void {
  const sub = args[0];

  if (sub === 'serve') {
    const port = process.env.PORT ?? String(MIDDLE_PORT);
    console.error(
      pc.dim('[middle] relay on ') + pc.cyan(`:${port}`) + pc.dim(' — point machines here:  ') + pc.cyan('tb middle set <this-ip>'),
    );
    if (!resolveSecret()) {
      console.error(
        pc.yellow('  ⚠ no password — anyone who reaches this port can use it. ') + pc.cyan('tb secret set') + pc.dim(' first.'),
      );
    }
    return runTarget('relay', { PORT: port });
  }

  if (sub === 'set') {
    const ip = args[1];
    if (!ip) {
      console.error('usage: tb middle set <ip|host|ws-url>   e.g.  tb middle set 203.0.113.10');
      return process.exit(1) as never;
    }
    setMiddle(ip);
    ok(`middle ${pc.dim('→')} ${pc.cyan(middleToUrl(ip))}`);
    console.error(
      pc.dim('  do the same on the Mac mini, then restart ') + pc.cyan('tb surf') + pc.dim(' (or the host) to dial it.'),
    );
    return;
  }

  if (sub === 'unset' || sub === 'clear' || sub === 'off' || sub === 'rm') {
    setMiddle(undefined);
    ok('middle cleared — back to the local relay');
    return;
  }

  // generate a self-signed wss cert on the server (SAN = given hosts + localhost)
  if (sub === 'cert') {
    const hosts = args.slice(1);
    const { fingerprint, certPath } = generateSelfSigned(hosts);
    ok(`self-signed cert written ${pc.dim(certPath)}`);
    console.log(pc.dim('  SAN:  ') + [...new Set([...hosts, 'localhost', '127.0.0.1'])].join(', '));
    console.log(pc.dim('  fingerprint (SHA-256):  ') + pc.cyan(fingerprint));
    console.log(pc.dim('  next:'));
    console.log(pc.dim('   1. serve wss here:        ') + pc.cyan('tb middle serve'));
    console.log(pc.dim('   2. on Mac mini + clients: ') + pc.cyan(`tb middle pin ${fingerprint}`));
    console.log(pc.dim('      then:                  ') + pc.cyan('tb middle set wss://<this-ip>:8001'));
    return;
  }

  // pin (or show) the relay cert's fingerprint this machine will trust
  if (sub === 'pin') {
    const fp = args.slice(1).join('');
    if (!fp) {
      const cur = getPin();
      if (cur) {
        console.log(pc.dim('  pin ') + pc.cyan(cur));
        console.log(pc.dim('  clear:  ') + pc.cyan('tb middle unpin'));
      } else {
        console.log(pc.dim('  pin (none) — wss would use the system trust store.'));
        console.log(pc.dim('  set:  ') + pc.cyan('tb middle pin <sha256-fingerprint>'));
      }
      return;
    }
    setPin(fp);
    ok(`pinned ${pc.dim(normalizeFp(fp))}`);
    console.log(pc.dim('  now point at it:  ') + pc.cyan('tb middle set wss://<vps-ip>:8001'));
    return;
  }

  if (sub === 'unpin') {
    setPin(undefined);
    ok('pin cleared');
    return;
  }

  // bare `tb middle` → show current
  const cur = getMiddle();
  if (cur) {
    console.log(pc.dim('  middle ') + pc.cyan(cur) + pc.dim('  →  ') + middleToUrl(cur));
    console.log(pc.dim('  clear:  ') + pc.cyan('tb middle unset'));
  } else {
    console.log(pc.dim('  middle (none) — using the local relay.'));
    console.log(pc.dim('  set one:  ') + pc.cyan('tb middle set <ip>'));
  }
  const pin = getPin();
  if (pin) console.log(pc.dim('  pin ') + pc.cyan(pin) + pc.dim('  (wss cert fingerprint)'));
}

/**
 * `tb secret …` — the shared password the relay enforces (HMAC challenge). Set
 * the SAME value on the relay (or env `TB_SECRET`) and every machine.
 *   set [pw]     set it (hidden prompt if no arg — keeps it out of shell history)
 *   unset        clear it (this machine)
 *   (bare)       show whether one is set (never the value)
 */
async function secret(args: string[]): Promise<void> {
  const sub = args[0];

  if (sub === 'unset' || sub === 'clear' || sub === 'off' || sub === 'rm') {
    setSecret(undefined);
    ok('password cleared on this machine');
    return;
  }

  if (sub === 'set') {
    let pw = args.slice(1).join(' ');
    if (!pw) {
      if (!process.stdout.isTTY) {
        console.error('usage: tb secret set <password>   (or run in a terminal for a hidden prompt)');
        return process.exit(1) as never;
      }
      const entered = await p.password({ message: 'relay password (a long passphrase is ideal)' });
      if (p.isCancel(entered)) {
        p.cancel('cancelled');
        return process.exit(0) as never;
      }
      pw = entered as string;
    }
    if (!pw) {
      fail('empty password');
      return process.exit(1) as never;
    }
    try {
      validatePairingSecret(pw);
    } catch (error) {
      fail((error as Error).message);
      return process.exit(1) as never;
    }
    setSecret(pw);
    ok(`password set ${pc.dim(`(${pw.length} chars)`)}`);
    console.error(
      pc.dim('  set the SAME on the relay (') +
        pc.cyan('tb secret set') +
        pc.dim(' / env ') +
        pc.cyan('TB_SECRET') +
        pc.dim(') + every machine, then restart ') +
        pc.cyan('tb surf') +
        pc.dim(' / the host.'),
    );
    return;
  }

  // bare `tb secret` → status only, never the value
  const cur = getSecret();
  const fromEnv = !!process.env.TB_SECRET;
  if (cur || fromEnv) {
    console.log(
      pc.dim('  password ') +
        pc.green('set') +
        (fromEnv ? pc.dim('  (from env TB_SECRET)') : pc.dim(`  (${cur!.length} chars, settings.json · chmod 600)`)),
    );
    console.log(pc.dim('  clear:  ') + pc.cyan('tb secret unset'));
  } else {
    console.log(pc.dim('  password (none) — relay accepts anyone who can reach it.'));
    console.log(pc.dim('  set one:  ') + pc.cyan('tb secret set'));
  }
}

/**
 * `tb expose …` — consent for the reverse tool channel: whether, and how much,
 * the agent on the host may touch THIS machine while you're attached. OFF by
 * default. fs.* is confined to `--root`; `exec` is full shell access (root does
 * NOT sandbox it), so it has its own on/off.
 *   on [--root D] [--fs ro|rw] [--exec on|off]   enable (with optional limits)
 *   off                                          disable
 *   (bare)                                       show status
 */
function exposeDir(d?: string): string {
  if (!d) return homedir();
  return resolve(d.replace(/^~(?=\/|$)/, homedir()));
}
function expose(args: string[]): void {
  const sub = args[0];

  if (sub === 'off' || sub === 'disable' || sub === 'unset' || sub === 'clear') {
    setExpose({ enabled: false });
    ok('peer tools DISABLED here — the remote agent can no longer touch this machine.');
    return;
  }

  if (sub === 'on' || sub === 'enable') {
    const patch: Partial<ExposeSettings> = { enabled: true };
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--root') patch.root = exposeDir(args[++i]);
      else if (args[i] === '--fs') patch.fs = args[++i] as FsMode;
      else if (args[i] === '--exec') patch.exec = args[++i] !== 'off';
    }
    const e = setExpose(patch);
    ok('peer tools ENABLED on this machine');
    console.log(
      pc.dim('  root ') + pc.cyan(e.root) + pc.dim('   fs ') + pc.cyan(e.fs) + pc.dim('   exec ') + (e.exec ? pc.green('on') : pc.dim('off')),
    );
    console.log(
      pc.yellow('  ⚠ while you are attached, the remote agent can ') +
        pc.yellow(e.exec ? 'run commands AND read/write files' : e.fs === 'rw' ? 'read/write files' : e.fs === 'ro' ? 'read files' : 'do nothing') +
        pc.yellow(' on THIS machine.'),
    );
    console.log(
      pc.dim('  narrow:  ') + pc.cyan('tb expose on --root ~/project --fs ro --exec off') + pc.dim('   ·   off:  ') + pc.cyan('tb expose off'),
    );
    console.log(pc.dim('  audit:  ') + peerAuditPath());
    return;
  }

  const e = getExpose();
  if (e.enabled) {
    console.log(
      pc.dim('  peer tools ') +
        pc.green('ENABLED') +
        pc.dim('   root ') +
        pc.cyan(e.root) +
        pc.dim('   fs ') +
        pc.cyan(e.fs) +
        pc.dim('   exec ') +
        (e.exec ? pc.green('on') : pc.dim('off')),
    );
    console.log(pc.dim('  disable:  ') + pc.cyan('tb expose off') + pc.dim('   ·   audit ') + peerAuditPath());
  } else {
    console.log(pc.dim('  peer tools ') + pc.dim('OFF') + pc.dim(' — the remote agent cannot touch this machine.'));
    console.log(pc.dim('  enable:  ') + pc.cyan('tb expose on [--root <dir>] [--fs ro|rw] [--exec on|off]'));
  }
}

/** `1` → `sess-1`; anything else passes through as an id. */
function resolveId(arg?: string): string {
  if (!arg) return '';
  return /^\d+$/.test(arg) ? `sess-${arg}` : arg;
}

function selectedHost(command: Command): string {
  return (command.optsWithGlobals().host as string | undefined) ?? process.env.TB_HOST ?? '';
}

function normalizeLegacyHostArg(argv: string[]): string[] {
  const normalized = [...argv];
  const legacyHost = normalized[2];
  if (legacyHost?.startsWith('@') && legacyHost.length > 1) {
    normalized.splice(2, 1, '--host', legacyHost.slice(1));
  }
  return normalized;
}

function createProgram(argv: string[]): Command {
  const program = new Command();
  const learning = program.command('voice').description('voice diagnostics and personal learning')
    .command('learning').description('automatic personal training in tb serve; isolated public-data experiments');
  learning.command('status').description('show private training counts and validation; never transcripts')
    .option('--json', 'machine-readable training status')
    .action((options: { json?: boolean }) => printLearningStatus(options.json));
  learning.command('pipeline <action> <directory>').description('init / plan / run / status: LoRA updates and periodic full tuning')
    .option('--base <path>', 'pinned LiveKit base directory')
    .option('--replay <path>', 'public replay fit JSON')
    .option('--dev <path>', 'calibration JSON, never fit data')
    .option('--peer-hash <sha256>', 'bind automatic Host training to one registered Peer')
    .option('--policy <path>', 'cadence policy JSON')
    .option('--check <path>', 'fresh, single-use held-out check JSON')
    .option('--idle', 'allow one cycle while no voice call is running')
    .option('--python <path>', 'dedicated Python 3.12 environment with training dependencies')
    .action(pipelineCommand);
  learning.command('experiment <stage> <directory>').description('prepare / prepare-second / train / check / verify an offline text model; never auto-activate')
    .option('--train-file <path>', 'pinned KE training JSON, or Easy Turn complete list for prepare-second')
    .option('--test-file <path>', 'pinned KE test JSON, or Easy Turn incomplete list for prepare-second')
    .option('--previous <directory>', 'rejected Round 1 experiment; its test becomes calibration only')
    .action(trainingCommand);
  program
    .name('tb')
    .description('Cross-machine terminal-agent bridge')
    .version(VERSION, '-V, --version', 'output the current version')
    .option('-H, --host <id>', 'target a specific host')
    .argument('[session]', 'session number or id to attach')
    .addHelpCommand('help [command]', 'display help for command')
    .showHelpAfterError('(add --help for additional information)')
    .showSuggestionAfterError();

  registerToolScriptCommands(program);
  registerScreenCommands(program);
  registerAutomation(program);

  program.command('update').description('update this CLI and reload its managed serve processes')
    .option('--check', 'check without replacing the installed CLI')
    .action(async function (this: Command) {
      try { console.log(JSON.stringify(await updateCLI({ entryDirectory: here, current: VERSION, bundled: BUNDLED, check: this.opts().check }), null, 2)); }
      catch (error) { fail((error as Error).message); process.exitCode = 1; }
    });

  program.command('setup [action]').description('configure the Mac App LAN services through an authorized connection')
    .option('--device <id>', 'configure this exact Peer instead of this Mac')
    .option('--relay-device <id>', 'reuse or start a relay on this authorized Mac Peer')
    .option('--address <ip>', 'relay address; automatically selected when unique')
    .option('--port <number>', 'relay port, default 7400')
    .option('--password-stdin', 'read an existing relay password from stdin')
    .action(async function (this: Command, action = 'status') {
      try {
        const opts = this.opts();
        const port = opts.port === undefined ? undefined : Number(opts.port);
        if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error('端口须为 1024–65535。');
        const result = await setupLAN(action, { ...opts, port, host: selectedHost(this), password: opts.passwordStdin ? await passwordFromStdin() : undefined });
        console.log(JSON.stringify(result, null, 2));
      } catch (error) { fail((error as Error).message); process.exitCode = 1; }
    });

  program.command('topology').description('show the authenticated relay topology')
    .option('--json', 'print the topology snapshot as JSON')
    .action(async function (this: Command) {
      try {
        const topology = await readTopology({ host: selectedHost(this) });
        console.log(this.opts().json ? JSON.stringify(topology, null, 2) : formatTopology(topology));
      } catch (error) { fail((error as Error).message); process.exitCode = 1; }
    });

  program
    .command('surf')
    .description('start a local relay and host')
    .action(surf);

  program
    .command('serve')
    .description('start a local relay, host, and optional cloud voice service')
    .action(surf);

  program
    .command('relay')
    .description('run the relay service')
    .action(() => runTarget('relay'));

  const appCommand = program.command('app').description('install and open the macOS app');
  for (const action of ['install', 'status', 'open'] as const) {
    appCommand.command(action).description({ install: 'install/update the official signed app in ~/Applications', status: 'show the installed app version', open: 'open the installed app' }[action]).action(async () => {
      try {
        if (process.platform !== 'darwin') throw new Error('tb app currently supports macOS. Downloads: https://termbridge-a0k.pages.dev/#downloads');
        const installer = new MacAppInstaller();
        if (action === 'install') await installer.install();
        else if (action === 'open') await installer.open();
        else { const app = await installer.status(); console.log(app ? `TermBridge ${app.version} (${app.build})\n${app.path}` : '未安装 App，运行 tb app install。'); }
      } catch (error) { fail(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
    });
  }

  const hostCommand = program
    .command('host')
    .description('run the Host in the foreground or manage its macOS background service')
    .action(() => runTarget('host'));
  hostCommand
    .command('start')
    .description('start the Host in the background')
    .option('--login', 'also start automatically after macOS login')
    .action((options: { login?: boolean }) => hostServiceAction((service) => {
      const result = service.start(options.login === true);
      ok(`Host started in the background${result.status.loginStart ? ' with login startup' : ''}`);
      if (result.backup) console.log(pc.dim('  previous plist backup  ') + result.backup);
      if (result.repaired.length > 0) console.log(pc.dim('  repaired node-pty helpers  ') + String(result.repaired.length));
      printHostServiceStatus(result.status);
    }));
  hostCommand
    .command('restart')
    .description('restart the background Host and reload pair/network settings')
    .action(() => hostServiceAction((service) => {
      const result = service.restart();
      ok('Host restarted with the current pair and network settings');
      if (result.backup) console.log(pc.dim('  previous plist backup  ') + result.backup);
      if (result.repaired.length > 0) console.log(pc.dim('  repaired node-pty helpers  ') + String(result.repaired.length));
      printHostServiceStatus(result.status);
    }));
  hostCommand
    .command('stop')
    .description('stop the background Host')
    .action(() => hostServiceAction((service) => {
      const status = service.stop();
      ok('Host stopped');
      printHostServiceStatus(status);
    }));
  hostCommand
    .command('enable')
    .description('enable login startup and start the Host now')
    .action(() => hostServiceAction((service) => {
      const result = service.enableLoginStart();
      ok('Host login startup enabled');
      if (result.backup) console.log(pc.dim('  previous plist backup  ') + result.backup);
      printHostServiceStatus(result.status);
    }));
  hostCommand
    .command('disable')
    .description('disable login startup without stopping the current Host')
    .action(() => hostServiceAction((service) => {
      const status = service.disableLoginStart();
      ok('Host login startup disabled');
      printHostServiceStatus(status);
    }));
  hostCommand
    .command('status')
    .description('show background Host, login startup, and log status')
    .action(() => hostServiceAction((service) => printHostServiceStatus(service.status())));
  hostCommand
    .command('doctor')
    .description('check background runtime, proxy capture, and node-pty spawn-helper')
    .option('--fix', 'repair missing spawn-helper execute permissions')
    .action((options: { fix?: boolean }) => hostServiceAction((service) => {
      const result = service.doctor(options.fix === true);
      for (const check of result.checks) {
        console.log(`  ${check.ok ? pc.green('✔') : pc.red('✖')} ${check.name.padEnd(14)} ${check.detail}`);
      }
      if (result.repaired.length > 0) ok(`repaired ${result.repaired.length} node-pty spawn-helper${result.repaired.length === 1 ? '' : 's'}`);
      if (!result.ok) process.exitCode = 1;
    }));
  hostCommand
    .command('logs')
    .description('show background Host logs')
    .option('-n, --lines <count>', 'number of lines', '100')
    .option('-f, --follow', 'keep following new log output')
    .action((options: { lines: string; follow?: boolean }) => hostServiceAction((service) => {
      const lines = Number.parseInt(options.lines, 10);
      if (!Number.isFinite(lines) || lines < 1) throw new Error('--lines must be a positive integer');
      service.showLogs(lines, options.follow === true);
    }));

  const initCommand = program
    .command('init')
    .description('make interactive codex and claude commands remotely controllable through Herdr')
    .action(() => {
      const result = installInit();
      ok('Codex and Claude interception installed');
      console.log(pc.dim('  shell config  ') + result.paths.rcFile);
      console.log(pc.dim('  shims        ') + result.paths.shimsDir);
      if (result.backup) console.log(pc.dim('  backup       ') + result.backup);
      for (const warning of result.warnings) console.error(pc.yellow(`  Herdr integration warning: ${warning}`));
      console.log(pc.dim('  activate now:  ') + pc.cyan(`source ${result.paths.rcFile}`) + pc.dim('  (or open a new terminal)'));
    });
  initCommand.command('status').description('show interception status').action(() => {
    const status = getInitStatus();
    console.log(pc.dim('  interception  ') + (status.installed ? pc.green('installed') : pc.yellow('not installed')));
    console.log(pc.dim('  shell config  ') + status.paths.rcFile + (status.rcInstalled ? pc.green('  ready') : pc.dim('  missing')));
    for (const [agent, installed] of Object.entries(status.shims)) {
      console.log(pc.dim(`  ${agent.padEnd(12)}`) + (installed ? pc.green('ready') : pc.dim('missing')));
    }
  });
  initCommand.command('uninstall').description('remove managed PATH shims').action(() => {
    const result = uninstallInit();
    ok('Codex and Claude interception removed');
    if (result.backup) console.log(pc.dim('  backup  ') + result.backup);
    console.log(pc.dim('  open a new terminal to refresh PATH'));
  });

  const cloudflareCommand = program
    .command('cloudflare')
    .description('deploy or pair with your own Cloudflare relay (or optional TB_CLOUDFLARE_RELAY)')
    .action(cloudflareStatus);
  cloudflareCommand
    .command('use [pairing-uri]')
    .description('import a termbridge://pair URI (or tb1_ code when TB_CLOUDFLARE_RELAY is set)')
    .action(cloudflareUse);
  cloudflareCommand
    .command('pair')
    .description('print a pairing QR code and termbridge://pair URI for your configured relay')
    .option('--current', 'always pair with the currently configured relay')
    .action(cloudflarePair);
  cloudflareCommand.command('login').description('authenticate Wrangler in the browser').action(cloudflareLogin);
  cloudflareCommand.command('deploy').description('deploy a private relay to your Cloudflare account').action(cloudflareDeploy);

  program.command('browser [args...]').description('install or use the Chrome browser extension').allowUnknownOption()
    .action(async (args: string[]) => { const { runBrowser } = await import('./browser.js'); await runBrowser(args); });
  program.command('lan-app').description('native App managed LAN service').action(runLanApp);
  program.command('desktop').description('native desktop JSON-lines bridge over stdin/stdout')
    .action(function (this: Command) { return runDesktop(selectedHost(this)); });

  program
    .command('ls')
    .alias('list')
    .description('list sessions')
    .action(function (this: Command) {
      return runList(selectedHost(this));
    });

  program
    .command('info')
    .description('show host and agent configuration')
    .action(function (this: Command) {
      return runInfo(selectedHost(this));
    });

  program
    .command('network [policy]')
    .description('show or set this Mac network policy (system or direct)')
    .action(networkPolicyCommand);

  const contextCommand = program
    .command('context')
    .description('inspect the durable Agent context index used by Global')
    .option('--all', 'include sessions no longer present')
    .action(function (this: Command) {
      return runContextList(Boolean(this.opts().all));
    });
  contextCommand
    .command('list')
    .description('list ranked Agent contexts')
    .option('--all', 'include sessions no longer present')
    .action(function (this: Command) {
      return runContextList(Boolean(this.opts().all));
    });
  contextCommand
    .command('search <terms...>')
    .description('search captured Agent summaries and execution context')
    .action((terms: string[]) => runContextSearch(terms));
  contextCommand
    .command('show <session>')
    .description('show one captured Agent context')
    .action((session: string) => runContextShow(session));

  program
    .command('set <name> <command...>')
    .description('define or replace an agent preset')
    .action(function (this: Command, name: string, command: string[]) {
      return runSet(selectedHost(this), name, command.join(' '));
    });

  program
    .command('rm <agent-name>')
    .alias('unset')
    .description('remove an agent preset')
    .action(function (this: Command, name: string) {
      return runRemove(selectedHost(this), name);
    });

  program
    .command('new [agent] [args...]')
    .description('open a shell, run an agent preset, or run a command after --')
    .option('-p, --pick', 'choose an agent preset interactively')
    .action(function (this: Command, agent?: string, args: string[] = []) {
      const commandIndex = argv.indexOf('new');
      const separatorIndex = argv.indexOf('--', commandIndex + 1);
      const host = selectedHost(this);
      if (separatorIndex !== -1) {
        const command = argv.slice(separatorIndex + 1);
        if (!command[0]) this.error('error: missing command after --');
        return runAttach({ host, command: command[0], args: command.slice(1) });
      }
      if (args.length) this.error('error: raw commands must follow --');
      if (this.opts().pick) {
        if (agent) this.error('error: --pick cannot be combined with an agent');
        return runNew(host);
      }
      return runAttach({ host, agent: agent || 'shell' });
    });

  program
    .command('attach <session>')
    .description('attach to an existing session')
    .action(function (this: Command, session: string) {
      return runAttach({ host: selectedHost(this), sessionId: resolveId(session) });
    });

  program
    .command('kill <session>')
    .description('kill a Termbridge-owned PTY session')
    .action(function (this: Command, session: string) {
      return runKill(selectedHost(this), resolveId(session));
    });

  program
    .command('restart <session>')
    .description('restart a Termbridge-owned PTY session')
    .action(function (this: Command, session: string) {
      return runRestart(selectedHost(this), resolveId(session));
    });

  const middleCommand = program
    .command('middle')
    .description('configure or run a shared relay')
    .action(() => middle([]));
  middleCommand.command('serve').description('serve the shared relay').action(() => middle(['serve']));
  middleCommand.command('set <address>').description('set the shared relay address').action((address: string) => middle(['set', address]));
  middleCommand
    .command('unset')
    .aliases(['clear', 'off', 'rm'])
    .description('clear the shared relay address')
    .action(() => middle(['unset']));
  middleCommand
    .command('cert [hosts...]')
    .description('generate a self-signed relay certificate')
    .action((hosts: string[]) => middle(['cert', ...hosts]));
  middleCommand
    .command('pin [fingerprint...]')
    .description('show or set the relay certificate fingerprint')
    .action((fingerprint: string[]) => middle(['pin', ...fingerprint]));
  middleCommand.command('unpin').description('clear the relay certificate fingerprint').action(() => middle(['unpin']));

  const secretCommand = program
    .command('secret')
    .description('configure the shared relay password')
    .action(() => secret([]));
  secretCommand
    .command('set [password...]')
    .description('set a 1–256 character password; prompts securely when omitted')
    .action((password: string[]) => secret(['set', ...password]));
  secretCommand
    .command('unset')
    .aliases(['clear', 'off', 'rm'])
    .description('clear the password on this machine')
    .action(() => secret(['unset']));

  const exposeCommand = program
    .command('expose')
    .description('control reverse-tool access to this machine')
    .action(() => expose([]));
  exposeCommand
    .command('on')
    .description('enable reverse-tool access')
    .option('--root <directory>', 'confine file access to a directory')
    .addOption(new Option('--fs <mode>', 'file access mode').choices(['ro', 'rw']))
    .addOption(new Option('--exec <mode>', 'command execution mode').choices(['on', 'off']))
    .action(function (this: Command) {
      const options = this.opts<{ root?: string; fs?: string; exec?: string }>();
      const args = ['on'];
      if (options.root) args.push('--root', options.root);
      if (options.fs) args.push('--fs', options.fs);
      if (options.exec) args.push('--exec', options.exec);
      return expose(args);
    });
  exposeCommand
    .command('off')
    .aliases(['disable', 'unset', 'clear'])
    .description('disable reverse-tool access')
    .action(() => expose(['off']));

  program
    .command('peer [operation] [args...]')
    .description('discover connected peers or run a tool on a selected device')
    .allowUnknownOption()
    .addHelpText('after', '\nOperations: list, topology, exec, read, write, ls, stat, info, computer, logcat, apk, photo, prompt, setup\nUse tb peer list to discover devices; pass --device ID before -- to select one.')
    .action(async function (this: Command) {
      const commandIndex = argv.indexOf('peer');
      const { runPeer } = await import('./peer.js');
      const host = selectedHost(this);
      return runPeer(argv.slice(commandIndex + 1), (op, args, timeout) => callPeer(op, args, timeout, host));
    });

  program.action(function (this: Command, session?: string) {
    if (!session) return surf();
    return runAttach({ host: selectedHost(this), sessionId: resolveId(session) });
  });

  return program;
}

async function main(): Promise<void> {
  const argv = normalizeLegacyHostArg(process.argv);
  if (argv[2] === '__automation-control') { await controlDaemon(argv[3] || '').catch(() => {}); return; }
  // Managed shims need byte-for-byte argument forwarding. Handle this private
  // entrypoint before Commander sees agent flags such as --help or --version.
  if (argv[2] === '__agent-shim') {
    const agent = argv[3];
    if (agent !== 'codex' && agent !== 'claude') {
      console.error('invalid Termbridge agent shim');
      process.exitCode = 2;
      return;
    }
    process.exitCode = await runAgentShim(agent as InterceptedAgent, argv.slice(4));
    return;
  }
  await createProgram(argv).parseAsync(argv);
}

void main();
