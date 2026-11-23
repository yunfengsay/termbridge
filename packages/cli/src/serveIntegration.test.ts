import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import net from 'node:net';
import { WebSocket } from 'ws';
import { readTopology } from './topology.js';
import { reloadOwnedServes } from './serveSupervisor.js';

test('packaged serve becomes ready, reloads its Host and Relay, and dies with its parent',
  { skip: !process.env.TB_TEST_CLI_DIST, timeout: 30000 }, async t => {
    const root = await mkdtemp('/tmp/tb-real-serve-'), dist = resolve(process.env.TB_TEST_CLI_DIST!);
    await mkdir(join(root, '.termbridge')); await writeFile(join(root, '.termbridge/settings.json'), '{}');
    const reservation = net.createServer(); await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as net.AddressInfo).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
    const env = { PATH: process.env.PATH, HOME: root, SHELL: '/bin/sh', HOST_ID: 'isolated-serve', PORT: String(port),
      TB_SECRET: 'fixture', TB_BACKEND: 'direct', TB_HERDR: 'off', TB_RELAY_BIND: '127.0.0.1',
      TB_SETTINGS: join(root, '.termbridge/settings.json') };
    const child = spawn(process.execPath, [join(dist, 'cli.js'), 'serve'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
    t.after(async () => { child.kill('SIGTERM'); await rm(root, { recursive: true, force: true }); });
    const directory = join(root, '.termbridge/services/serve');
    let records: string[] = [];
    for (let i = 0; i < 200; i++) {
      try { records = (await readdir(directory)).filter(name => name.endsWith('.json')); } catch {}
      if (records.length || child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(records.length, 1, log);
    const info = JSON.parse(await readFile(join(directory, records[0]), 'utf8'));
    const topology = () => readTopology({ socket: () => new WebSocket(`ws://127.0.0.1:${port}`), secret: 'fixture' });
    assert.equal((await topology()).nodes.filter(node => node.role === 'host').length, 1);
    assert.equal(await reloadOwnedServes(info.packageRoot, directory), 1);
    assert.equal((await topology()).nodes.filter(node => node.role === 'host').length, 1);
    child.kill('SIGKILL');
    let listening = true;
    for (let i = 0; i < 100 && listening; i++) {
      await new Promise(resolve => setTimeout(resolve, 30));
      listening = await new Promise<boolean>(resolve => {
        const socket = net.createConnection(port, '127.0.0.1');
        socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false));
      });
    }
    assert.equal(listening, false, 'Parent death must close its Relay');
    assert.equal(await reloadOwnedServes(info.packageRoot, directory), 0, 'Stale owner records cannot restart processes');
  });
