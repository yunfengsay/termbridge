const MAX_LINES = 2000;
const MAX_BYTES = 1024 * 1024;

/** One viewer's bounded, frozen history. Only explicit wheel input reads history. */
export class HerdrScrollback {
  private offset = 0;
  private lines?: string[];
  private generation = 0;
  private revision = 0;
  private completed = 0;
  private working = false;
  private closed = false;

  constructor(private readonly options: {
    rows: () => number;
    readHistory: (lines: number) => Promise<string>;
    readLive: () => Promise<Buffer>;
    output: (data: Buffer) => void;
    error: () => void;
  }) {}

  get active(): boolean { return this.offset > 0; }
  private get rows(): number { return Math.max(2, Math.min(200, Math.trunc(this.options.rows()) || 24)); }

  scroll(direction: 'up' | 'down', lines: number): void {
    if (this.closed || !Number.isSafeInteger(lines) || lines < 1 || lines > 100) return;
    const limit = Math.max(0, (this.lines?.length ?? MAX_LINES) - this.rows);
    const next = Math.max(0, Math.min(limit, this.offset + (direction === 'up' ? lines : -lines)));
    if (next === this.offset) return;
    this.offset = next; this.revision++;
    void this.render();
  }

  /** Input resumes live output without waiting for a potentially slow history read. */
  resume(): void {
    if (this.closed || (!this.active && !this.working)) return;
    this.generation++; this.offset = 0; this.lines = undefined; this.revision++;
    void this.render();
  }

  close(): void { this.closed = true; this.generation++; this.lines = undefined; }

  private async render(): Promise<void> {
    if (this.working || this.closed) return;
    this.working = true;
    try {
      while (!this.closed && this.completed !== this.revision) {
        const generation = this.generation, revision = this.revision;
        try {
          if (this.active && !this.lines) {
            const text = await this.options.readHistory(MAX_LINES);
            if (this.closed || generation !== this.generation) continue;
            if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('History limit exceeded');
            // History is plain text, never terminal commands or keyboard input.
            this.lines = text.replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
              .replace(/\n$/, '').split('\n').slice(-MAX_LINES);
          }
          if (this.closed || generation !== this.generation) continue;
          let data: Buffer;
          if (this.active && this.lines) {
            this.offset = Math.min(this.offset, Math.max(0, this.lines.length - this.rows));
          }
          if (this.active && this.lines) {
            const end = this.lines.length - this.offset;
            data = Buffer.from('\x1b[0m\x1b[2J\x1b[H' + this.lines.slice(Math.max(0, end - this.rows), end).join('\r\n'));
          } else {
            data = await this.options.readLive();
            if (this.closed || generation !== this.generation || revision !== this.revision) continue;
            this.lines = undefined;
          }
          this.completed = this.revision;
          this.options.output(data);
        } catch {
          if (this.closed || generation !== this.generation) continue;
          this.offset = 0; this.lines = undefined; this.completed = this.revision;
          this.options.error();
        }
      }
    } finally { this.working = false; }
  }
}
