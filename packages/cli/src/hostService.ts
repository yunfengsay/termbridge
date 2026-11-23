import { spawn, spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const HOST_SERVICE_LABEL = 'com.termbridge.host';
const MANAGED_MARKER = 'Managed by `tb host`.';
const PROXY_ENV = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const;
const SAFE_HOST_ENV = [
  'TB_INTENT_HINTS',
  'TYPESAFE_API_KEY',
  'HOST_NAME',
  'TB_BACKEND',
  'TB_PREFILL_DELAY_MS',
  'TB_TMUX_SOCKET',
  'TB_SETTINGS',
  'TB_HOST_ID_FILE',
  'LANG',
  'LC_ALL',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const;

export interface HostServicePaths {
  serviceDirectory: string;
  servicePlist: string;
  loginPlist: string;
  logFile: string;
}

export interface HostServiceSpec {
  nodePath: string;
  hostEntrypoint: string;
  executableArgs?: string[];
  home?: string;
  shell?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface HostServiceStatus {
  running: boolean;
  state: string;
  pid?: number;
  loginStart: boolean;
  plist: string;
  logFile: string;
}

export interface HostDoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface HostDoctorResult {
  ok: boolean;
  repaired: string[];
  checks: HostDoctorCheck[];
}

export interface HostServiceDependencies {
  platform: NodeJS.Platform;
  uid: number;
  now: () => Date;
  runLaunchctl: (args: string[]) => CommandResult;
  readPlistValue: (path: string, key: string) => string | undefined;
  repairSpawnHelpers: (hostEntrypoint: string) => { found: string[]; repaired: string[] };
}

function defaultRunLaunchctl(args: string[]): CommandResult {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || result.error?.message || '',
  };
}

function defaultDependencies(): HostServiceDependencies {
  return {
    platform: process.platform,
    uid: process.getuid?.() ?? -1,
    now: () => new Date(),
    runLaunchctl: defaultRunLaunchctl,
    readPlistValue: (path, key) => {
      const result = spawnSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path], { encoding: 'utf8' });
      // Only the selected credential enters memory; never return diagnostics containing plist data.
      return result.status === 0 ? result.stdout.trim() || undefined : undefined;
    },
    repairSpawnHelpers,
  };
}

export function hostServicePaths(home = homedir()): HostServicePaths {
  const root = resolve(home);
  return {
    serviceDirectory: join(root, '.termbridge', 'services'),
    servicePlist: join(root, '.termbridge', 'services', `${HOST_SERVICE_LABEL}.plist`),
    loginPlist: join(root, 'Library', 'LaunchAgents', `${HOST_SERVICE_LABEL}.plist`),
    logFile: join(root, 'Library', 'Logs', 'termbridge-host.log'),
  };
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function commandForShell(shell: string, executablePath: string, args: string[]): string[] {
  const command = `exec ${[executablePath, ...args].map(shellQuote).join(' ')}`;
  return basename(shell) === 'fish' ? [shell, '-l', '-c', command] : [shell, '-lic', command];
}

function serviceEnvironment(spec: HostServiceSpec): Record<string, string> {
  const env = spec.env ?? process.env;
  const home = resolve(spec.home || homedir());
  const shell = spec.shell || env.SHELL || '/bin/zsh';
  const result: Record<string, string> = {
    HOME: home,
    SHELL: shell,
    PATH: env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  };
  for (const name of [...PROXY_ENV, ...SAFE_HOST_ENV]) {
    const value = env[name];
    if (value) result[name] = value;
  }
  return result;
}

export function renderHostLaunchAgent(spec: HostServiceSpec, homeCredential?: { variable: string; value: string }): string {
  const paths = hostServicePaths(spec.home);
  const environment = serviceEnvironment(spec);
  if (homeCredential) environment[homeCredential.variable] = homeCredential.value;
  const shell = spec.shell || environment.SHELL || '/bin/zsh';
  const executableArgs = spec.executableArgs ?? [resolve(spec.hostEntrypoint)];
  const argumentsXml = commandForShell(shell, resolve(spec.nodePath), executableArgs)
    .map((argument) => `      <string>${xml(argument)}</string>`)
    .join('\n');
  const environmentXml = Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `      <key>${xml(name)}</key>\n      <string>${xml(value)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${MANAGED_MARKER} Re-run \`tb host restart\` after changing pair, proxy, or network settings. -->
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${HOST_SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(resolve(spec.home || homedir()))}</string>
    <key>EnvironmentVariables</key>
    <dict>
${environmentXml}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xml(paths.logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(paths.logFile)}</string>
  </dict>
</plist>
`;
}

function timestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function requireSuccess(result: CommandResult, action: string): void {
  if (result.status === 0) return;
  const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
  throw new Error(`${action}: ${detail}`);
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function walkSpawnHelpers(directory: string, depth = 0, found: string[] = []): string[] {
  if (depth > 6) return found;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === 'spawn-helper') found.push(path);
    if (entry.isDirectory() && ['prebuilds', 'build', 'Release'].includes(entry.name)) {
      walkSpawnHelpers(path, depth + 1, found);
    } else if (entry.isDirectory() && depth < 2) {
      walkSpawnHelpers(path, depth + 1, found);
    }
  }
  return found;
}

export function findSpawnHelpers(hostEntrypoint: string): string[] {
  try {
    const require = createRequire(resolve(hostEntrypoint));
    const entrypoint = require.resolve('node-pty');
    const packageRoot = dirname(dirname(entrypoint));
    return walkSpawnHelpers(packageRoot);
  } catch {
    return [];
  }
}

export function repairSpawnHelpers(hostEntrypoint: string): { found: string[]; repaired: string[] } {
  const found = findSpawnHelpers(hostEntrypoint);
  const repaired: string[] = [];
  for (const helper of found) {
    if (executable(helper)) continue;
    const mode = statSync(helper).mode;
    chmodSync(helper, mode | 0o111);
    if (executable(helper)) repaired.push(helper);
  }
  return { found, repaired };
}

export class HostServiceManager {
  readonly paths: HostServicePaths;
  private readonly dependencies: HostServiceDependencies;
  private readonly spec: HostServiceSpec;

  constructor(spec: HostServiceSpec, dependencies: Partial<HostServiceDependencies> = {}) {
    this.spec = { ...spec, home: resolve(spec.home || homedir()) };
    this.paths = hostServicePaths(this.spec.home);
    this.dependencies = { ...defaultDependencies(), ...dependencies };
  }

  private assertSupported(): void {
    if (this.dependencies.platform !== 'darwin' || this.dependencies.uid < 0) {
      throw new Error('background Host management currently requires macOS; run `tb host` in the foreground on this platform');
    }
  }

  private domain(): string {
    return `gui/${this.dependencies.uid}`;
  }

  private serviceTarget(): string {
    return `${this.domain()}/${HOST_SERVICE_LABEL}`;
  }

  private homeCredential(): { variable: string; value: string } | undefined {
    const env = this.spec.env ?? process.env;
    const settingsFile = env.TB_SETTINGS || join(this.spec.home!, '.termbridge', 'settings.json');
    if (!existsSync(settingsFile)) return undefined;
    let policy: { enabled?: boolean; tokenEnv?: unknown } | undefined;
    try { policy = JSON.parse(readFileSync(settingsFile, 'utf8')).homeAssistant; }
    catch { throw new Error('Cannot read Host Home Assistant policy; service configuration was not changed'); }
    if (!policy?.enabled) return undefined;
    const variable = policy.tokenEnv ?? 'TB_HA_TOKEN';
    if (typeof variable !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(variable)) {
      throw new Error('Invalid Home Assistant credential variable; service configuration was not changed');
    }
    if (Object.hasOwn(env, variable)) {
      const value = env[variable]?.trim();
      return value ? { variable, value } : undefined;
    }
    // Keep the credential from the active login definition when shell environment has none.
    // Never fall back to an older service copy when a login definition already exists.
    const path = existsSync(this.paths.loginPlist) ? this.paths.loginPlist : this.paths.servicePlist;
    if (!existsSync(path)) return undefined;
    const value = this.dependencies.readPlistValue(path, `EnvironmentVariables.${variable}`);
    return value ? { variable, value } : undefined;
  }

  private writePlists(loginStart: boolean): string | undefined {
    // Explicit Host-only configuration survives restarts from shells without the
    // key. Never copy unrelated environment/credentials into the launch agent.
    const env = { ...(this.spec.env ?? process.env) };
    const previous = existsSync(this.paths.loginPlist) ? this.paths.loginPlist : this.paths.servicePlist;
    for (const name of ['TB_INTENT_HINTS', 'TYPESAFE_API_KEY']) {
      if (!Object.hasOwn(env, name) && existsSync(previous)) {
        env[name] = this.dependencies.readPlistValue(previous, `EnvironmentVariables.${name}`);
      }
    }
    const content = renderHostLaunchAgent({ ...this.spec, env }, this.homeCredential());
    mkdirSync(dirname(this.paths.logFile), { recursive: true });
    writeAtomic(this.paths.servicePlist, content);
    if (!loginStart) return undefined;

    let backup: string | undefined;
    if (existsSync(this.paths.loginPlist)) {
      const previous = readFileSync(this.paths.loginPlist, 'utf8');
      if (!previous.includes(MANAGED_MARKER)) {
        backup = `${this.paths.loginPlist}.termbridge-backup-${timestamp(this.dependencies.now())}`;
        copyFileSync(this.paths.loginPlist, backup);
      }
    }
    writeAtomic(this.paths.loginPlist, content);
    return backup;
  }

  private load(plist: string): HostServiceStatus {
    this.dependencies.runLaunchctl(['bootout', this.serviceTarget()]);
    requireSuccess(
      this.dependencies.runLaunchctl(['enable', this.serviceTarget()]),
      'could not enable the Host service',
    );
    requireSuccess(
      this.dependencies.runLaunchctl(['bootstrap', this.domain(), plist]),
      'could not load the Host service',
    );
    requireSuccess(
      this.dependencies.runLaunchctl(['kickstart', '-k', this.serviceTarget()]),
      'could not start the Host service',
    );
    return this.status();
  }

  start(loginStart = false): { status: HostServiceStatus; backup?: string; repaired: string[] } {
    this.assertSupported();
    const doctor = this.doctor(true);
    if (!doctor.ok) {
      const failed = doctor.checks.filter((check) => !check.ok).map((check) => check.detail).join('; ');
      throw new Error(`Host runtime is not ready: ${failed}`);
    }
    const useLogin = loginStart || existsSync(this.paths.loginPlist);
    const backup = this.writePlists(useLogin);
    const status = this.load(useLogin ? this.paths.loginPlist : this.paths.servicePlist);
    return { status, backup, repaired: doctor.repaired };
  }

  restart(): { status: HostServiceStatus; backup?: string; repaired: string[] } {
    return this.start(existsSync(this.paths.loginPlist));
  }

  enableLoginStart(): { status: HostServiceStatus; backup?: string; repaired: string[] } {
    return this.start(true);
  }

  disableLoginStart(): HostServiceStatus {
    this.assertSupported();
    rmSync(this.paths.loginPlist, { force: true });
    return this.status();
  }

  stop(): HostServiceStatus {
    this.assertSupported();
    this.dependencies.runLaunchctl(['bootout', this.serviceTarget()]);
    return this.status();
  }

  status(): HostServiceStatus {
    this.assertSupported();
    const result = this.dependencies.runLaunchctl(['print', this.serviceTarget()]);
    const state = result.status === 0
      ? result.stdout.match(/\bstate\s*=\s*([^\s]+)/)?.[1] || 'loaded'
      : 'stopped';
    const pidText = result.status === 0 ? result.stdout.match(/\bpid\s*=\s*(\d+)/)?.[1] : undefined;
    return {
      running: result.status === 0 && state === 'running',
      state,
      ...(pidText ? { pid: Number(pidText) } : {}),
      loginStart: existsSync(this.paths.loginPlist),
      plist: existsSync(this.paths.loginPlist) ? this.paths.loginPlist : this.paths.servicePlist,
      logFile: this.paths.logFile,
    };
  }

  doctor(fix = false): HostDoctorResult {
    this.assertSupported();
    const environment = serviceEnvironment(this.spec);
    const shell = this.spec.shell || environment.SHELL || '/bin/zsh';
    const helpers = fix
      ? this.dependencies.repairSpawnHelpers(this.spec.hostEntrypoint)
      : { found: findSpawnHelpers(this.spec.hostEntrypoint), repaired: [] };
    const helpersWithoutExecutePermission = helpers.found.filter((helper) => !executable(helper));
    const helperReady = helpers.found.length > 0 && helpersWithoutExecutePermission.length === 0;
    const proxyNames = PROXY_ENV.filter((name) => !!environment[name]);
    const checks: HostDoctorCheck[] = [
      { name: 'node', ok: executable(this.spec.nodePath), detail: resolve(this.spec.nodePath) },
      { name: 'host', ok: readable(this.spec.hostEntrypoint), detail: resolve(this.spec.hostEntrypoint) },
      { name: 'shell', ok: executable(shell), detail: shell },
      {
        name: 'spawn-helper',
        ok: helperReady,
        detail: helpers.found.length === 0
          ? 'node-pty spawn-helper was not found; reinstall agent-termbridge with install scripts enabled'
          : helpersWithoutExecutePermission.length > 0
            ? `${helpers.found.length} helper${helpers.found.length === 1 ? '' : 's'} found; ${helpersWithoutExecutePermission.length} missing execute permission${fix ? ' after repair' : '; run `tb host doctor --fix`'}`
            : `${helpers.found.length} executable helper${helpers.found.length === 1 ? '' : 's'}`,
      },
      {
        name: 'proxy',
        ok: true,
        detail: proxyNames.length > 0 ? `capturing ${proxyNames.join(', ')}` : 'no proxy variables are set in this shell',
      },
    ];
    return { ok: checks.every((check) => check.ok), repaired: helpers.repaired, checks };
  }

  showLogs(lines = 100, follow = false): void {
    const args = ['-n', String(Math.max(1, Math.floor(lines)))];
    if (follow) args.push('-f');
    args.push(this.paths.logFile);
    const child = spawn('/usr/bin/tail', args, { stdio: 'inherit' });
    child.once('exit', (code) => {
      process.exitCode = code ?? 0;
    });
  }
}
