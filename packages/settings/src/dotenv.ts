import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface LoadLocalEnvOptions {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Parse simple `.env` content (`KEY=VALUE`, optional `export `, single/double quotes, `#` comments).
 */
export function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const line = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    } else {
      const commentIndex = value.search(/\s+#/);
      if (commentIndex >= 0) value = value.slice(0, commentIndex).trim();
    }
    result[key] = value;
  }
  return result;
}

function loadFileInto(filePath: string, target: NodeJS.ProcessEnv, loadedKeys: Set<string>): boolean {
  if (!existsSync(filePath)) return false;
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return false;
  }
  const parsed = parseDotEnv(content);
  for (const [key, value] of Object.entries(parsed)) {
    // Existing shell/process env always wins (including explicit empty string overrides in tests).
    if (Object.prototype.hasOwnProperty.call(target, key)) continue;
    target[key] = value;
    loadedKeys.add(key);
  }
  return true;
}

/**
 * Load local TermBridge `.env` overrides without clobbering existing environment variables.
 *
 * Precedence (highest wins):
 *   1. Existing `process.env`
 *   2. Explicit `TB_ENV_FILE` (when set)
 *   3. `<cwd>/.env.local`
 *   4. `<cwd>/.env`
 *   5. `~/.termbridge/.env`
 *
 * Isolation guard: skipped when `TB_NO_DOTENV=1`, or when `TB_SETTINGS`/`TB_CONFIG` is explicitly
 * overridden (e.g. isolated test runs) unless `TB_ENV_FILE` or `TB_LOAD_DOTENV=1` is set.
 */
export function loadLocalEnv(options: LoadLocalEnvOptions = {}): string[] {
  const env = options.env ?? process.env;
  if (env.TB_NO_DOTENV === '1') return [];
  const explicitFile = env.TB_ENV_FILE?.trim();
  const isolated = Boolean(env.TB_SETTINGS || env.TB_CONFIG);
  if (isolated && !explicitFile && env.TB_LOAD_DOTENV !== '1') return [];

  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const candidates = explicitFile
    ? [explicitFile]
    : [
        join(cwd, '.env.local'),
        join(cwd, '.env'),
        join(home, '.termbridge', '.env'),
      ];

  const loadedKeys = new Set<string>();
  const loadedFiles: string[] = [];
  for (const file of candidates) {
    if (loadFileInto(file, env, loadedKeys)) loadedFiles.push(file);
  }
  return loadedFiles;
}
