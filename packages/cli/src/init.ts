import { spawn, spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  constants,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export type InterceptedAgent = 'codex' | 'claude';

const AGENTS: InterceptedAgent[] = ['codex', 'claude'];
const START = '# >>> termbridge agent interception >>>';
const END = '# <<< termbridge agent interception <<<';
const DISPATCHER = '.agent-shim';

export interface InitPaths {
  home: string;
  rcFile: string;
  shell: string;
  shimsDir: string;
}

export interface InitResult {
  changed: boolean;
  backup?: string;
  warnings: string[];
  paths: InitPaths;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function initPaths(env: NodeJS.ProcessEnv = process.env): InitPaths {
  const home = resolve(env.TB_INIT_HOME || homedir());
  const shell = env.TB_INIT_SHELL || env.SHELL || '/bin/zsh';
  const shellName = basename(shell);
  const defaultRc = shellName === 'bash' ? '.bashrc' : shellName === 'fish' ? '.config/fish/config.fish' : '.zshrc';
  return {
    home,
    shell,
    rcFile: resolve(env.TB_INIT_RC || join(home, defaultRc)),
    shimsDir: join(home, '.termbridge', 'shims'),
  };
}

function managedBlock(paths: InitPaths): string {
  if (basename(paths.shell) === 'fish') {
    return `${START}\nfish_add_path --prepend ${shellQuote(paths.shimsDir)}\n${END}`;
  }
  return `${START}\nexport PATH=${shellQuote(paths.shimsDir)}:\"$PATH\"\n${END}`;
}

function replaceManagedBlock(input: string, replacement: string): string {
  const start = input.indexOf(START);
  const end = input.indexOf(END, start + START.length);
  let base = input;
  if (start !== -1 && end !== -1) {
    base = input.slice(0, start) + input.slice(end + END.length);
  }
  base = base.replace(/\s+$/u, '');
  return replacement ? `${base}${base ? '\n\n' : ''}${replacement}\n` : `${base}${base ? '\n' : ''}`;
}

function dispatcher(): string {
  return `#!/bin/sh
# Managed by \`tb init\`. codex and claude are links to this shared dispatcher.
agent=\${0##*/}
shim_dir=\$(CDPATH= cd "\$(dirname "$0")" && pwd)
case "$agent" in
  codex|claude) ;;
  *) echo "[tb init] invalid agent link: $agent" >&2; exit 2 ;;
esac
# Re-resolve the public launcher on every invocation. The install-time link is
# only a fallback for shells that do not have tb on PATH.
current_tb=\$(command -v tb 2>/dev/null)
if [ -n "$current_tb" ] && [ -x "$current_tb" ]; then
  exec "$current_tb" __agent-shim "$agent" "$@"
fi
exec "$shim_dir/.tb" __agent-shim "$agent" "$@"
`;
}

function currentCliEntrypoint(): string {
  const candidate = process.argv[1] ? resolve(process.argv[1]) : '';
  if (candidate) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // A development entrypoint run through tsx may not be executable.
    }
  }
  return findExecutable('tb', process.env.PATH || '') || 'tb';
}

function runIntegrationInstaller(agent: InterceptedAgent, env: NodeJS.ProcessEnv): string | undefined {
  const result = spawnSync('herdr', ['integration', 'install', agent], { env, encoding: 'utf8' });
  if (result.status === 0) return undefined;
  const detail = (result.stderr || result.stdout || result.error?.message || 'Herdr is not installed').trim();
  return `${agent}: ${detail}`;
}

export function installInit(
  paths = initPaths(),
  installIntegration: (agent: InterceptedAgent) => string | undefined = (agent) =>
    runIntegrationInstaller(agent, process.env),
  cliEntrypoint = currentCliEntrypoint(),
): InitResult {
  mkdirSync(paths.shimsDir, { recursive: true });
  const dispatcherPath = join(paths.shimsDir, DISPATCHER);
  writeFileSync(dispatcherPath, dispatcher(), { mode: 0o755 });
  chmodSync(dispatcherPath, 0o755);
  const cliLink = join(paths.shimsDir, '.tb');
  rmSync(cliLink, { force: true });
  symlinkSync(cliEntrypoint, cliLink);
  for (const agent of AGENTS) {
    const file = join(paths.shimsDir, agent);
    rmSync(file, { force: true });
    symlinkSync(DISPATCHER, file);
  }

  mkdirSync(dirname(paths.rcFile), { recursive: true });
  const before = existsSync(paths.rcFile) ? readFileSync(paths.rcFile, 'utf8') : '';
  const after = replaceManagedBlock(before, managedBlock(paths));
  let backup: string | undefined;
  if (after !== before) {
    if (existsSync(paths.rcFile)) {
      backup = `${paths.rcFile}.termbridge-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      copyFileSync(paths.rcFile, backup);
    }
    writeFileSync(paths.rcFile, after);
  }

  const warnings = AGENTS.map(installIntegration).filter((warning): warning is string => !!warning);
  return { changed: after !== before, backup, warnings, paths };
}

export function uninstallInit(paths = initPaths()): InitResult {
  const before = existsSync(paths.rcFile) ? readFileSync(paths.rcFile, 'utf8') : '';
  const after = replaceManagedBlock(before, '');
  let backup: string | undefined;
  if (after !== before) {
    backup = `${paths.rcFile}.termbridge-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(paths.rcFile, backup);
    writeFileSync(paths.rcFile, after);
  }
  for (const agent of AGENTS) rmSync(join(paths.shimsDir, agent), { force: true });
  rmSync(join(paths.shimsDir, DISPATCHER), { force: true });
  rmSync(join(paths.shimsDir, '.tb'), { force: true });
  try {
    if (existsSync(paths.shimsDir) && readdirSync(paths.shimsDir).length === 0) rmSync(paths.shimsDir, { recursive: false });
  } catch {
    // Preserve any unexpected user files in the directory.
  }
  return { changed: after !== before, backup, warnings: [], paths };
}

export function getInitStatus(paths = initPaths()): { installed: boolean; rcInstalled: boolean; shims: Record<InterceptedAgent, boolean>; paths: InitPaths } {
  const rc = existsSync(paths.rcFile) ? readFileSync(paths.rcFile, 'utf8') : '';
  const shims = Object.fromEntries(
    AGENTS.map((agent) => [agent, existsSync(join(paths.shimsDir, agent))]),
  ) as Record<InterceptedAgent, boolean>;
  const rcInstalled = rc.includes(START) && rc.includes(END);
  return { installed: rcInstalled && AGENTS.every((agent) => shims[agent]), rcInstalled, shims, paths };
}

export function stripShimPath(pathValue: string | undefined, shimsDir: string): string {
  const target = resolve(shimsDir);
  return (pathValue || '')
    .split(':')
    .filter((part) => part && resolve(part) !== target)
    .join(':');
}

export function findExecutable(command: string, pathValue: string): string | undefined {
  for (const directory of pathValue.split(':')) {
    if (!directory) continue;
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return undefined;
}

/** Preserve the shell's launcher order; package-manager hints are fallbacks only. */
export function resolveAgentExecutable(
  agent: InterceptedAgent,
  pathValue: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromPath = findExecutable(agent, pathValue);
  if (fromPath) return fromPath;
  const preferredDirectories = [
    env.PNPM_HOME,
    env.npm_config_prefix ? join(env.npm_config_prefix, 'bin') : undefined,
    env.NPM_CONFIG_PREFIX ? join(env.NPM_CONFIG_PREFIX, 'bin') : undefined,
    env.BUN_INSTALL ? join(env.BUN_INSTALL, 'bin') : undefined,
  ];
  for (const directory of preferredDirectories) {
    if (!directory) continue;
    const candidate = join(directory, agent);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Fall through to the next package manager or PATH.
    }
  }
  return undefined;
}

export function shouldIntercept(agent: InterceptedAgent, args: string[], env = process.env): boolean {
  // A Host-owned PTY is already remotely attachable. Intercepting it again
  // creates a duplicate Herdr pane and leaves agent attach holding its lease.
  if (env.HERDR_ENV === '1' || env.TB_SESSION || !process.stdin.isTTY || !process.stdout.isTTY) return false;
  if (args.some((arg) => ['-h', '--help', '-V', '--version'].includes(arg))) return false;
  if (agent === 'codex' && ['exec', 'completion', 'mcp', 'app-server', 'sandbox', 'login', 'logout', 'cloud', 'features'].includes(args[0] || '')) {
    return false;
  }
  if (agent === 'claude' && (args.includes('-p') || args.includes('--print') || ['mcp', 'plugin', 'doctor', 'update', 'install', 'setup-token'].includes(args[0] || ''))) {
    return false;
  }
  return true;
}

/** Preserve the old Codex convenience flag after upstream renamed it. */
export function normalizeAgentArgs(agent: InterceptedAgent, args: string[]): string[] {
  if (agent !== 'codex' || !args.includes('--yolo')) return args;
  return args.map((arg) =>
    arg === '--yolo' ? '--dangerously-bypass-approvals-and-sandbox' : arg,
  );
}

export function isAgentPaneBusy(stdout: string, stderr: string): boolean {
  return `${stderr}${stdout}`.includes('agent_pane_busy');
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolveCode) => {
    const child = spawn(command, args, { stdio: 'inherit', env });
    child.once('error', (error) => {
      console.error(`[tb init] ${error.message}`);
      resolveCode(127);
    });
    child.once('exit', (code, signal) => resolveCode(code ?? (signal ? 128 : 1)));
  });
}

async function ensureHerdr(herdr: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (spawnSync(herdr, ['status', 'server'], { env, stdio: 'ignore' }).status === 0) return true;
  const server = spawn(herdr, ['server'], { env, detached: true, stdio: 'ignore' });
  server.unref();
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    if (spawnSync(herdr, ['status', 'server'], { env, stdio: 'ignore' }).status === 0) return true;
  }
  return false;
}

function workspacePane(output: string): { workspaceId: string; paneId: string } | undefined {
  try {
    const parsed = JSON.parse(output) as {
      result?: { root_pane?: { pane_id?: string }; workspace?: { workspace_id?: string } };
    };
    const paneId = parsed.result?.root_pane?.pane_id;
    const workspaceId = parsed.result?.workspace?.workspace_id;
    if (paneId && workspaceId) return { paneId, workspaceId };
  } catch {
    // The caller will safely fall back to the real executable.
  }
  return undefined;
}

/** Called only by the managed shims. Returns the child process exit code. */
export async function runAgentShim(agent: InterceptedAgent, args: string[]): Promise<number> {
  const paths = initPaths();
  const cleanPath = stripShimPath(process.env.PATH, paths.shimsDir);
  const env = { ...process.env, PATH: cleanPath };
  const real = resolveAgentExecutable(agent, cleanPath);
  if (!real) {
    console.error(`[tb init] cannot find the real ${agent} executable after ${paths.shimsDir}`);
    return 127;
  }
  const forwardedArgs = normalizeAgentArgs(agent, args);
  if (!shouldIntercept(agent, forwardedArgs, process.env)) return run(real, forwardedArgs, env);

  const herdr = findExecutable('herdr', cleanPath);
  if (!herdr || !(await ensureHerdr(herdr, env))) {
    console.error('[tb init] Herdr is unavailable; running the original command directly.');
    return run(real, forwardedArgs, env);
  }

  const created = spawnSync(
    herdr,
    [
      'workspace',
      'create',
      '--cwd',
      process.cwd(),
      '--label',
      `${agent} · ${basename(process.cwd())}`,
      '--env',
      'HERDR_ENV=1',
      '--env',
      `PATH=${cleanPath}`,
      '--no-focus',
    ],
    { env, encoding: 'utf8' },
  );
  const workspace = created.status === 0 ? workspacePane(created.stdout) : undefined;
  if (!workspace) {
    console.error('[tb init] Could not create a Herdr workspace; running the original command directly.');
    return run(real, forwardedArgs, env);
  }

  const name = `tb_${agent}_${Date.now().toString(36)}_${process.pid}`;
  let started = spawnSync(
    herdr,
    ['agent', 'start', name, '--kind', agent, '--pane', workspace.paneId, '--', ...forwardedArgs],
    { env, encoding: 'utf8', timeout: 310_000 },
  );
  // A freshly created workspace can report its root pane before the login
  // shell reaches an interactive prompt. Retry only that explicit race; every
  // other launch error still falls back immediately.
  for (let attempt = 0; started.status !== 0 && attempt < 30; attempt++) {
    if (!isAgentPaneBusy(started.stdout || '', started.stderr || '')) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    started = spawnSync(
      herdr,
      ['agent', 'start', name, '--kind', agent, '--pane', workspace.paneId, '--', ...forwardedArgs],
      { env, encoding: 'utf8', timeout: 310_000 },
    );
  }
  if (started.status !== 0) {
    spawnSync(herdr, ['workspace', 'close', workspace.workspaceId], { env, stdio: 'ignore' });
    const detail = (started.stderr || started.stdout || started.error?.message || 'unknown error').trim();
    console.error(`[tb init] Herdr launch failed (${detail}); running the original command directly.`);
    return run(real, forwardedArgs, env);
  }

  return run(herdr, ['agent', 'attach', name], env);
}
