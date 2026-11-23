import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import type { ControlMessage } from '@termbridge/protocol';

/** Random installation identity, shared by all CLI connections on this computer. */
export function resolvePeerDeviceId(file = process.env.TB_PEER_ID_FILE || join(homedir(), '.termbridge', 'peer-id')): string {
  mkdirSync(dirname(file), { recursive: true });
  const read = () => {
    const id = readFileSync(file, 'utf8').trim();
    if (!/^cli-[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid CLI peer-id; refusing to change device identity automatically');
    return id;
  };
  try {
    return read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const id = `cli-${randomUUID()}`;
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${id}\n`, { mode: 0o600, flag: 'wx' });
  try {
    // Publish an already complete identity without replacing another CLI's
    // simultaneous first-run identity. Readers never observe an empty file.
    try { linkSync(temporary, file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return read();
  } finally { unlinkSync(temporary); }
}

/** Advertise implementation capabilities, never permission or secret material. */
export function desktopPeerRegistration(deviceId: string): Extract<ControlMessage, { t: 'peer_register' }> {
  return {
    t: 'peer_register', deviceId, platform: process.platform, name: hostname().slice(0, 128),
    role: 'manager', capabilities: ['peer.desktop', 'peer.exec', 'peer.fs'],
  };
}
