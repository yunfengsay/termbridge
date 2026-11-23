import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { dirname, join } from 'node:path';

const HOST_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;
const ZERO_MAC = '00:00:00:00:00:00';

export function deriveMacHostId(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[] | undefined> = networkInterfaces(),
): string | undefined {
  const candidates = Object.entries(interfaces)
    .flatMap(([name, entries]) => (entries ?? []).map((entry) => ({ name, entry })))
    .filter(({ entry }) => !entry.internal && entry.mac && entry.mac !== ZERO_MAC)
    .sort((left, right) => interfaceRank(left.name) - interfaceRank(right.name) || left.name.localeCompare(right.name));
  const mac = candidates[0]?.entry.mac.toLowerCase();
  if (!mac) return undefined;
  // The relay only needs a stable machine key, not the raw hardware address.
  return `mac-${createHash('sha256').update(mac).digest('hex').slice(0, 16)}`;
}

export function resolveStableHostId(
  env: NodeJS.ProcessEnv = process.env,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[] | undefined> = networkInterfaces(),
  file = env.TB_HOST_ID_FILE || join(homedir(), '.termbridge', 'host-id'),
): string {
  const explicit = env.HOST_ID?.trim();
  if (explicit) return explicit;

  const persisted = readPersistedHostId(file);
  if (persisted) return persisted;

  const generated = deriveMacHostId(interfaces) ?? `host-${randomBytes(8).toString('hex')}`;
  persistHostId(file, generated);
  return generated;
}

function readPersistedHostId(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const value = readFileSync(file, 'utf8').trim();
    return HOST_ID_PATTERN.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function persistHostId(file: string, hostId: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${hostId}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

function interfaceRank(name: string): number {
  if (name === 'en0' || name === 'eth0') return 0;
  if (/^(en|eth)\d+$/.test(name)) return 1;
  return 2;
}
