import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const MAX_VOICE_MEMORY_CHARS = 6_000;

const INITIAL_MEMORY = `# TermBridge Memory

Durable user preferences, project decisions, and cross-session facts belong here.
Do not store passwords, API keys, tokens, or transient Agent status.
`;

export class BrainMemory {
  constructor(
    readonly path = process.env.TB_BRAIN_MEMORY || join(homedir(), '.termbridge', 'memory.md'),
  ) {}

  ensure(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    try {
      writeFileSync(this.path, INITIAL_MEMORY, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  /** A bounded snapshot sent once when a new cloud Realtime session starts. */
  voiceSnapshot(): string {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8').replace(/\u0000/g, '').trim();
    } catch {
      return '';
    }
    if (text.length <= MAX_VOICE_MEMORY_CHARS) return text;
    const marker = '\n\n[... memory truncated by Host ...]\n\n';
    const available = MAX_VOICE_MEMORY_CHARS - marker.length;
    const head = Math.ceil(available / 2);
    return text.slice(0, head) + marker + text.slice(-(available - head));
  }

  /** Local coding Agents already have FS tools, so they only need the stable path and policy. */
  agentInstructions(): string {
    return [
      '[TermBridge persistent memory]',
      `Memory file: ${JSON.stringify(this.path)}`,
      'Read it when durable user preferences or prior project decisions are relevant.',
      'Update it only with durable facts worth carrying across sessions.',
      'Never store passwords, API keys, tokens, or transient Agent status.',
      '[/TermBridge persistent memory]',
    ].join('\n');
  }
}
