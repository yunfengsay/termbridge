import { appendFileSync, mkdirSync, existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
export class Audit {
  readonly path: string;
  constructor(root: string) { mkdirSync(root, { recursive: true, mode: 0o700 }); this.path = join(root, 'audit.log'); }
  append(data: Record<string, unknown>) { appendFileSync(this.path, JSON.stringify({ timestamp: new Date().toISOString(), ...data }) + '\n', { mode: 0o600 }); }
  async tail(n: number) {
    const rows: unknown[] = [];
    if (existsSync(this.path)) for await (const line of createInterface({ input: createReadStream(this.path) })) {
      try { rows.push(JSON.parse(line)); if (rows.length > n) rows.shift(); } catch { /* interrupted record */ }
    }
    return rows;
  }
}
