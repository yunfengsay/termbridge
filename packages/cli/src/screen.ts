import net from 'node:net';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { Command } from 'commander';

export async function screenRequest(op: string, args: Record<string, unknown>, socketPath = process.env.TB_BRIDGE_SOCK ?? resolve(homedir(), '.termbridge/host.sock')): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    socket.setTimeout(20_000, () => socket.destroy(new Error('Desktop request timed out; not retried')));
    socket.on('connect', () => socket.write(JSON.stringify({ session: 'app', op: `screen.${op}`, args }) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 24 * 1024 * 1024) socket.destroy(new Error('Desktop reply too large'));
    });
    socket.on('end', () => {
      try { resolve(JSON.parse(buffer)); } catch { reject(new Error('Invalid desktop reply')); }
    });
    socket.on('error', reject);
  });
}

export function registerScreenCommands(program: Command): void {
  const command = program.command('screen').description('inspect and operate this Host desktop; JSON results');
  const run = async (op: string, args: Record<string, unknown> = {}, output?: string) => {
    try {
      const response = await screenRequest(op, args);
      const data = response.data as Record<string, unknown> | undefined;
      if (output && response.ok && typeof data?.data === 'string') {
        await writeFile(resolve(output), Buffer.from(data.data, 'base64'), { mode: 0o600 });
        delete data.data; data.path = resolve(output);
      }
      console.log(JSON.stringify(response));
      if (!response.ok) process.exitCode = 1;
    } catch (error) { console.log(JSON.stringify({ ok: false, error: (error as Error).message })); process.exitCode = 1; }
  };
  for (const op of ['status', 'displays', 'release']) command.command(op).action(() => run(op));
  command.command('inspect').option('--pid <pid>', 'inspect one application process', Number).action(opts => run('inspect', { pid: opts.pid }));
  command.command('permissions <kind>').description('request screen/input permission or open sharing settings on this Mac').action((kind: string) => run('permissions', { kind }));
  command.command('capture').option('--display <id>', 'physical display ID', Number).option('--width <pixels>', 'maximum image width', Number)
    .requiredOption('-o, --output <path>', 'write private JPEG to file').action((opts) => run('capture', { displayId: opts.display, maxWidth: opts.width }, opts.output));
  command.command('pointer <action> <x> <y>').description('move/down/up/click; normalized coordinates 0..1')
    .option('--display <id>', 'physical display ID', Number).option('--button <button>', 'left/right/middle', 'left')
    .action((action: string, x: string, y: string, opts) => run('pointer', { action, x: Number(x), y: Number(y), displayId: opts.display, button: { left: 0, right: 1, middle: 2 }[opts.button as string] ?? -1 }));
  command.command('key <code> <state>').description('macOS virtual key code; down/up').action((code: string, state: string) => {
    if (!['down', 'up'].includes(state)) throw new Error('Key state must be down or up');
    return run('key', { code: Number(code), down: state === 'down' });
  });
  command.command('text <text>').description('type Unicode into the focused application').action((text: string) => run('text', { text }));
  command.command('scroll <dx> <dy>').description('scroll in pixels').action((dx: string, dy: string) => run('scroll', { dx: Number(dx), dy: Number(dy) }));
  command.command('space <direction>').description('previous / next / overview via macOS shortcuts').action((direction: string) => run('space', { direction }));
  command.command('press <controlId>').description('press a current inspect control; caller must have authorization for this action')
    .option('--authorized', 'user explicitly authorized this exact control press, including while viewing')
    .action((controlId: string, opts) => run('press', { controlId, authorized: opts.authorized === true }));
  command.command('attention').description('highlight a desktop region on mobile; never clicks or approves it')
    .requiredOption('--display <id>', 'physical display ID', Number)
    .requiredOption('--region <x,y,width,height>', 'normalized rectangle')
    .option('--title <text>', 'short prompt shown inside the encrypted viewer')
    .option('--device <id>', 'phone device ID when multiple peers are online')
    .action((opts) => {
      const [x, y, width, height] = String(opts.region).split(',').map(Number);
      return run('attention', { displayId: opts.display, region: { x, y, width, height }, title: opts.title, deviceId: opts.device });
    });
}
