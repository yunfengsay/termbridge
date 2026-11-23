import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, dirname } from 'node:path';
import {
  AgentRegistry,
  type AgentCapability,
  type AgentDescriptor,
  type AgentRuntime,
} from '@termbridge/brain';

/**
 * Host config — maps short agent names to full commands. `new claude` on a
 * client resolves here to a real command run as `<shell> -ic "<command>"`, so
 * shell syntax / aliases / proxy all work.
 *
 * Path: $TB_CONFIG or ~/.termbridge/config.json. Written on first run if absent.
 */
export interface Config {
  remoteAutomation?: boolean;
  shell: string;
  agents: Record<string, string>;
  agentProfiles?: Record<string, AgentProfileConfig>;
}

export interface AgentProfileConfig {
  name?: string;
  runtime?: AgentRuntime;
  purpose?: string;
  capabilities?: AgentCapability[];
  defaultWorkspace?: string;
}

const DEFAULT_SHELL = process.env.SHELL || (process.platform === 'darwin' ? 'zsh' : 'bash');

const DEFAULTS: Config = {
  shell: DEFAULT_SHELL,
  agents: {
    // Edit these to taste (e.g. via `tb set claude "..."`). Values are run as: <shell> -lic "<value>"
    claude: 'claude',
    codex: 'codex',
  },
  agentProfiles: {
    codex: {
      name: 'Codex',
      runtime: 'codex',
      purpose: 'Implement, inspect, test, and review software changes.',
      capabilities: ['coding', 'terminal', 'files'],
    },
    claude: {
      name: 'Claude Code',
      runtime: 'claude',
      purpose: 'Implement, inspect, test, and review software changes.',
      capabilities: ['coding', 'terminal', 'files'],
    },
  },
};

export function configPath(): string {
  return process.env.TB_CONFIG || join(homedir(), '.termbridge', 'config.json');
}

export function saveConfig(cfg: Config): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
}

export function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(DEFAULTS, null, 2) + '\n');
      console.log(`[host] wrote starter config: ${path}`);
    } catch (e) {
      console.error(`[host] could not write config (${(e as Error).message}); using defaults`);
    }
    return DEFAULTS;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>;
    return {
      shell: parsed.shell || DEFAULTS.shell,
      remoteAutomation: parsed.remoteAutomation !== false,
      agents: { ...DEFAULTS.agents, ...(parsed.agents ?? {}) },
      agentProfiles: { ...DEFAULTS.agentProfiles, ...(parsed.agentProfiles ?? {}) },
    };
  } catch (e) {
    console.error(`[host] bad config ${path} (${(e as Error).message}); using defaults`);
    return DEFAULTS;
  }
}

export function createAgentRegistry(cfg: Config): AgentRegistry {
  const descriptors: AgentDescriptor[] = Object.entries(cfg.agents)
    .filter(([agentId]) => agentId !== 'shell')
    .map(([agentId, command]) => {
      const profile = cfg.agentProfiles?.[agentId];
      const runtime = profile?.runtime ?? inferAgentRuntime(agentId, command);
      const name = profile?.name?.trim() || displayAgentName(agentId);
      return {
        agentId,
        name,
        runtime,
        purpose: profile?.purpose?.trim() || `${name} execution agent`,
        capabilities: profile?.capabilities ?? defaultCapabilities(runtime),
        ...(profile?.defaultWorkspace ? { defaultWorkspace: profile.defaultWorkspace } : {}),
      };
    });
  return new AgentRegistry(descriptors);
}

function inferAgentRuntime(agentId: string, command: string): AgentRuntime {
  const normalized = `${agentId} ${command}`.toLowerCase();
  if (/\bcodex\b/.test(normalized)) return 'codex';
  if (/\bclaude\b/.test(normalized)) return 'claude';
  return 'custom';
}

function defaultCapabilities(runtime: AgentRuntime): AgentCapability[] {
  return runtime === 'codex' || runtime === 'claude'
    ? ['coding', 'terminal', 'files']
    : ['terminal'];
}

function displayAgentName(agentId: string): string {
  return agentId.split(/[-_.]+/g)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ') || agentId;
}

/**
 * Resolve a preset agent name to a spawnable (command, args). The agent's
 * command string is wrapped in an interactive shell so `~/.zshrc` (aliases,
 * proxy, PATH) is loaded. Returns null for unknown agents.
 */
export function resolveAgent(cfg: Config, name: string): { command: string; args: string[] } | null {
  const shell = cfg.shell || process.env.SHELL || 'zsh';
  // `shell` is a reserved built-in: a plain login+interactive shell — i.e. a
  // fresh remote terminal (the `tb new` default). Login (`-l`) loads ~/.zprofile
  // so PATH/nvm/etc. are complete, exactly like the terminal app you'd open
  // locally; from there you run anything by hand. Shadows any same-named preset.
  if (name === 'shell') return { command: shell, args: ['-l', '-i'] };
  const cmd = cfg.agents[name];
  if (!cmd) return null;
  // Interactive shells source the user's rc file, which may export the Brain's
  // Bailian key again after the Host scrubbed its own environment. Remove it
  // inside the shell, after rc loading and immediately before the coding agent.
  const scrubKey = basename(shell) === 'fish' ? 'set -e DASHSCOPE_API_KEY; ' : 'unset DASHSCOPE_API_KEY; ';
  return { command: shell, args: ['-lic', scrubKey + cmd] };
}

export function resolveBrainAgent(
  cfg: Config,
  name: string,
  prompt: string,
  resultPath: string,
): { command: string; args: string[]; env: Record<string, string> } | null {
  const shell = cfg.shell || process.env.SHELL || 'zsh';
  const command = cfg.agents[name];
  if (!command || (name !== 'codex' && name !== 'claude')) return null;
  const scrubKey = basename(shell) === 'fish' ? 'set -e DASHSCOPE_API_KEY; ' : 'unset DASHSCOPE_API_KEY; ';
  const invocation = name === 'codex'
    ? `${command} exec --skip-git-repo-check --color never --output-last-message "$TB_BRAIN_RESULT" "$TB_BRAIN_PROMPT"`
    : `${basename(shell) === 'fish' ? '' : 'set -o pipefail; '}${command} -p "$TB_BRAIN_PROMPT" | tee "$TB_BRAIN_RESULT"`;
  return {
    command: shell,
    args: ['-ic', scrubKey + invocation],
    env: { TB_BRAIN_PROMPT: prompt, TB_BRAIN_RESULT: resultPath },
  };
}
