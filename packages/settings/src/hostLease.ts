import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

export interface HostLease {
  release(): void;
}

type IsProcessAlive = (pid: number) => boolean;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function hostLeasePath(bridgeSocket: string, hostId: string): string {
  const identity = createHash('sha256').update(hostId).digest('hex').slice(0, 16);
  return `${bridgeSocket}.${identity}.pid`;
}

/** Atomic per-bridge lease. Prevents two Hosts from racing under one stable host identity. */
export function acquireHostLease(
  path: string,
  pid = process.pid,
  isAlive: IsProcessAlive = processIsAlive,
): HostLease {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const candidate = `${path}.${pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(candidate, `${pid}\n`, { mode: 0o600, flag: 'wx' });
      linkSync(candidate, path);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          try {
            if (Number(readFileSync(path, 'utf8').trim()) === pid) unlinkSync(path);
          } catch {
            // The lease may already have been cleaned after a crash or forced shutdown.
          }
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      const owner = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
      if (Number.isSafeInteger(owner) && owner > 0 && isAlive(owner)) {
        throw new Error(`TermBridge Host is already running (pid ${owner})`);
      }
      unlinkSync(path);
    } finally {
      try {
        unlinkSync(candidate);
      } catch {
        // Candidate is a private short-lived inode used only for atomic linking.
      }
    }
  }
  throw new Error('Could not acquire the TermBridge Host lease');
}
