import { Channel } from '@termbridge/protocol/automation-channel';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AutomationSchema, type AutomationMessage } from '@termbridge/protocol';
import { execute } from './process.js';
import { pull, push, fullPath } from './files.js';
import { Audit } from './storage.js';
export class Automation {
  private channels = new Map<string, Channel>();
  private audit = new Audit(process.env.TB_AUTOMATION_DIR || join(homedir(), '.termbridge'));
  constructor(private options: { send: (client: number, msg: AutomationMessage) => void; config: () => { shell: string; remoteAutomation?: boolean } }) {}
  handle(client: number, input: AutomationMessage) {
    const parsed = AutomationSchema.safeParse(input); if (!parsed.success) return;
    const msg = parsed.data; const key = `${client}:${msg.id}`;
    if (msg.kind !== 'request') { this.channels.get(key)?.receive(msg); return; }
    if (this.channels.has(key)) return;
    const channel = new Channel(msg.id, m => this.options.send(client, m)); this.channels.set(key, channel);
    const started = Date.now(); const args = msg.args || {};
    const record = { clientId: client, clientName: String(args.clientName || '').slice(0, 128), op: msg.op,
      cwd: typeof args.cwd === 'string' ? args.cwd : homedir(),
      argv: Array.isArray(args.argv) ? JSON.stringify(args.argv).slice(0, 2048) : undefined,
      path: typeof args.path === 'string' ? fullPath(args.path) : undefined };
    void (async () => {
      let result: Record<string, unknown> | undefined; let error: string | undefined;
      try {
        if (this.options.config().remoteAutomation === false && msg.op !== 'audit') throw new Error('remote exec/fs disabled by host configuration');
        if (msg.op === 'exec') result = await execute(channel, args, this.options.config().shell);
        else if (msg.op === 'pull' || msg.op === 'cat') result = await pull(channel, args);
        else if (msg.op === 'push') result = await push(channel, args);
        else if (msg.op === 'audit') {
          for (const record of await this.audit.tail(Math.min(10000, Math.max(1, Number(args.tail) || 50)))) await channel.data(Buffer.from(JSON.stringify(record) + '\n'), 'stdout');
          result = {};
        }
        else throw new Error('unsupported automation operation');
      } catch (e) { error = (e as Error).message; }
      finally {
        try {
          if (msg.op !== 'audit') {
            try { this.audit.append({ ...record, bytes: result?.bytes, exitCode: result?.exitCode, durationMs: Date.now() - started, error }); }
            catch { error = 'Host could not append audit metadata'; }
          }
          if (!channel.signal.aborted) channel.send({ kind: 'result', result, error });
        } finally { this.channels.delete(key); channel.abort(); }
      }
    })().catch(() => { this.channels.delete(key); channel.abort(); });
  }
  drop(client: number) { for (const [key, channel] of this.channels) if (key.startsWith(`${client}:`)) { this.channels.delete(key); channel.abort(); } }
  dispose() { for (const channel of this.channels.values()) channel.abort(); this.channels.clear(); }
}
