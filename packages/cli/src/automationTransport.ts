import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, chmod, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { dial, handshake } from './client.js';
import { encodeControl, parseFrame, FrameType, type AutomationMessage } from '@termbridge/protocol';
import { resolveRelayUrl, resolvePin, resolveSecret } from '@termbridge/settings';

export interface Transport { send(m: AutomationMessage): void; close(): void; }
type Receive = (m: AutomationMessage) => void;
export async function direct(host: string, receive: Receive, closed: (error: Error) => void): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const ws = dial(error => fail(error)); let ready = false; let closing = false;
    const timer = setTimeout(() => { reject(new Error('host capability negotiation timed out; host 0.1.37 does not support exec, upgrade host')); ws.terminate(); }, 10000);
    const fail = (error: Error) => { clearTimeout(timer); if (!ready) reject(error); else if (!closing) closed(error); };
    let heartbeat: NodeJS.Timeout;
    const pet = () => { clearTimeout(heartbeat); heartbeat = setTimeout(() => ws.terminate(), 70000); };
    ws.on('open', pet); ws.on('ping', pet);
    handshake(ws, host, socket => socket.send(encodeControl({ t: 'config_get' })));
    ws.on('message', raw => {
      pet();
      try {
        const frame = parseFrame(raw as Buffer); if (frame.type !== FrameType.Control) return; const m = frame.msg;
        if (m.t === 'config_info') {
          clearTimeout(timer);
          if (!m.automation) { fail(new Error(`host ${m.version || '0.1.37'} does not support exec, upgrade host`)); ws.close(); return; }
          ready = true; resolve({ send: message => ws.send(encodeControl(message)), close: () => { closing = true; ws.close(); } });
        } else if (m.t === 'automation') receive(m);
        else if (m.t === 'error') { fail(new Error(m.message)); ws.close(); }
      } catch (e) { fail(e as Error); ws.terminate(); }
    });
    ws.on('error', fail); ws.on('close', () => { clearTimeout(heartbeat); fail(new Error('connection lost; request was not replayed')); });
  });
}
function socketPath(host: string) {
  const key = createHash('sha256').update([resolveRelayUrl(), host, process.env.TB_SETTINGS || '', resolveSecret() || '', resolvePin() || ''].join('\0')).digest('hex').slice(0, 24);
  return join(process.env.TB_CONTROL_DIR || join(homedir(), '.termbridge', 'control'), `${key}.sock`);
}
function local(path: string, receive: Receive, closed: (e: Error) => void): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path); let ready = false; let ending = false; let buffer = '';
    const timer = setTimeout(() => { reject(new Error('control connection timeout')); socket.destroy(); }, 12000);
    socket.on('data', data => {
      buffer += data.toString(); if (buffer.length > 4 * 1024 * 1024) { socket.destroy(); return; }
      let i: number; while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        try {
          const m = JSON.parse(line);
          if (m.ready) { ready = true; clearTimeout(timer); resolve({ send: m => socket.write(JSON.stringify(m) + '\n'), close: () => { ending = true; socket.end(); } }); }
          else receive(m);
        } catch { socket.destroy(); }
      }
    });
    socket.on('error', e => { clearTimeout(timer); if (!ready) reject(e); else if (!ending) closed(e); });
    socket.on('close', () => { clearTimeout(timer); if (!ready) reject(new Error('control unavailable')); else if (!ending) closed(new Error('control connection lost; request was not replayed')); });
  });
}
export async function connectAutomation(host: string, receive: Receive, closed: (e: Error) => void): Promise<Transport> {
  if (process.env.TB_NO_CONTROL === '1') return direct(host, receive, closed);
  const path = socketPath(host);
  try { return await local(path, receive, closed); } catch { /* no daemon */ }
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], '__automation-control', host], { detached: true, stdio: 'ignore', env: process.env }); child.unref();
  for (let n = 0; n < 30; n++) {
    await new Promise(r => setTimeout(r, 100));
    try { return await local(path, receive, closed); } catch { /* start race, then direct fallback */ }
  }
  return direct(host, receive, closed);
}
export async function controlDaemon(host: string) {
  const path = socketPath(host); await mkdir(join(path, '..'), { recursive: true, mode: 0o700 }); await chmod(join(path, '..'), 0o700);
  // Probe a stale socket before removing it; simultaneous starters never unlink a live listener.
  try { const probe = await local(path, () => {}, () => {}); probe.close(); return; } catch { /* missing/stale */ }
  try { await unlink(path); } catch { /* absent */ }
  const owners = new Map<string, net.Socket>(); const sockets = new Set<net.Socket>();
  let remote: Transport; let idle: NodeJS.Timeout;
  const server = net.createServer(socket => {
    sockets.add(socket); clearTimeout(idle); let buffer = '';
    socket.write('{"ready":true}\n');
    socket.on('data', b => {
      buffer += b.toString(); if (buffer.length > 4 * 1024 * 1024) return socket.destroy();
      let i: number; while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        try {
          const m = JSON.parse(line) as AutomationMessage;
          if (m.kind === 'request') { if (owners.has(m.id)) throw new Error('duplicate id'); owners.set(m.id, socket); }
          if (owners.get(m.id) !== socket) throw new Error('request owner mismatch');
          remote.send(m);
        } catch { socket.destroy(); }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      sockets.delete(socket);
      for (const [id, owner] of owners) if (owner === socket) { owners.delete(id); remote.send({ t: 'automation', id, kind: 'cancel' }); }
      if (!sockets.size) idle = setTimeout(shutdown, 600000);
    });
  });
  function shutdown() { clearTimeout(idle); for (const socket of sockets) socket.destroy(); remote?.close(); server.close(); }
  remote = await direct(host, m => { const socket = owners.get(m.id); if (socket) socket.write(JSON.stringify(m) + '\n'); if (m.kind === 'result') owners.delete(m.id); }, shutdown);
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); }); }
  catch { remote.close(); return; }
  await chmod(path, 0o600); idle = setTimeout(shutdown, 600000);
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
}
