import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const MAX_VOICE_MEMORY_CHARS = 6_000;
const MAX_MEMORY_FILE_CHARS = 32_000;
const MAX_ENTRY_CHARS = 1_000;

const INITIAL_MEMORY = `# TermBridge Memory

Durable user preferences, project decisions, and cross-session facts belong here.
Do not store passwords, API keys, tokens, or transient Agent status.
`;

const SECRET_PATTERNS = [
  /\bsk-[a-zA-Z0-9_-]{16,}\b/,
  /\btb1_[a-zA-Z0-9_-]{12,}\b/,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
  /\b(?:api[_-]?key|secret|token|password|passwd|credential)\s*[:=]\s*\S{8,}/i,
  /\b(?:DASHSCOPE_API_KEY|TYPESAFE_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)\b/,
];

export interface MemorySection {
  heading: string;
  body: string;
}

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

  /** Read raw bounded memory text for tool calls. */
  read(): string {
    try {
      return readFileSync(this.path, 'utf8').replace(/\u0000/g, '').trim();
    } catch {
      return '';
    }
  }

  /** Search durable memory sections and bullet items by keyword(s). */
  search(query: string): { ok: true; matches: Array<{ section: string; line: string }>; total: number } {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 1);
    if (terms.length === 0) return { ok: true, matches: [], total: 0 };
    const text = this.read();
    if (!text) return { ok: true, matches: [], total: 0 };
    const matches: Array<{ section: string; line: string }> = [];
    let currentSection = 'General';
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      if (/^#{1,3}\s+/.test(line)) {
        currentSection = line.replace(/^#{1,3}\s+/, '').trim();
        continue;
      }
      const haystack = `${currentSection} ${line}`.toLowerCase();
      if (terms.every((term) => haystack.includes(term))) {
        matches.push({ section: currentSection, line: line.slice(0, 400) });
      }
    }
    return { ok: true, matches: matches.slice(0, 20), total: matches.length };
  }

  /** Durably upsert a preference or project decision into a named Markdown section. */
  upsert(input: { section: string; key?: string; content: string }): {
    ok: true;
    section: string;
    key?: string;
    updated: boolean;
    size: number;
  } {
    const section = sanitizeInline(input.section, 80) || 'General';
    const key = input.key ? sanitizeInline(input.key, 80) : undefined;
    const content = sanitizeEntry(input.content);
    if (!content) throw new Error('Memory content cannot be empty');
    assertNoSecrets(`${section}\n${key ?? ''}\n${content}`);

    this.ensure();
    const existing = this.read();
    const entryLine = key ? `- **${key}**: ${content}` : `- ${content}`;
    const { header, sections } = parseSections(existing);
    let target = sections.find((item) => item.heading.toLowerCase() === section.toLowerCase());
    if (!target) {
      target = { heading: section, body: '' };
      sections.push(target);
    }

    const lines = target.body ? target.body.split('\n') : [];
    let updated = false;
    if (key) {
      const prefix = `- **${key.toLowerCase()}**:`;
      const idx = lines.findIndex((line) => line.trim().toLowerCase().startsWith(prefix));
      if (idx >= 0) {
        lines[idx] = entryLine;
        updated = true;
      }
    } else {
      const idx = lines.findIndex((line) => line.trim().toLowerCase() === entryLine.toLowerCase());
      if (idx >= 0) {
        lines[idx] = entryLine;
        updated = true;
      }
    }
    if (!updated) lines.push(entryLine);
    target.body = lines.filter((line, idx, arr) => line.trim() !== '' || (idx > 0 && idx < arr.length - 1)).join('\n');

    const serialized = serializeSections(header, sections);
    if (serialized.length > MAX_MEMORY_FILE_CHARS) {
      throw new Error(`Memory file exceeds ${MAX_MEMORY_FILE_CHARS} character limit; remove obsolete entries first`);
    }
    this.atomicWrite(serialized);
    return { ok: true, section: target.heading, ...(key ? { key } : {}), updated, size: serialized.length };
  }

  /** Remove matching entries from durable memory. */
  remove(input: { section?: string; query: string }): { ok: true; removedCount: number } {
    const needle = sanitizeInline(input.query, 200).toLowerCase();
    if (!needle) throw new Error('query is required to remove memory entries');
    if (!existsSync(this.path)) return { ok: true, removedCount: 0 };
    const sectionFilter = input.section ? sanitizeInline(input.section, 80).toLowerCase() : undefined;
    const { header, sections } = parseSections(this.read());
    let removedCount = 0;
    for (const sec of sections) {
      if (sectionFilter && sec.heading.toLowerCase() !== sectionFilter) continue;
      const lines = sec.body.split('\n');
      const kept = lines.filter((line) => {
        const match = line.trim().startsWith('-') && line.toLowerCase().includes(needle);
        if (match) removedCount += 1;
        return !match;
      });
      sec.body = kept.join('\n').trim();
    }
    if (removedCount > 0) {
      const nonEmpty = sections.filter((sec) => sec.body.trim().length > 0);
      this.atomicWrite(serializeSections(header, nonEmpty));
    }
    return { ok: true, removedCount };
  }

  /** A bounded snapshot sent to Global Brain; optionally prioritizes query-relevant sections. */
  voiceSnapshot(query?: string): string {
    const text = this.read();
    if (!text) return '';
    if (text.length <= MAX_VOICE_MEMORY_CHARS) return text;
    const marker = '\n\n[... memory truncated by Host ...]\n\n';
    const available = MAX_VOICE_MEMORY_CHARS - marker.length;

    if (query?.trim()) {
      const { header, sections } = parseSections(text);
      const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
      const relevant = sections.filter((sec) => {
        const hay = `${sec.heading}\n${sec.body}`.toLowerCase();
        return terms.some((term) => hay.includes(term));
      });
      if (relevant.length > 0) {
        const headBudget = Math.min(1_200, Math.floor(available * 0.25));
        const tailBudget = Math.min(1_200, Math.floor(available * 0.25));
        const midBudget = Math.max(0, available - headBudget - tailBudget - 64);
        const headPart = (header || text.slice(0, headBudget)).slice(0, headBudget);
        const relPart = relevant.map((s) => `## ${s.heading}\n${s.body}`).join('\n\n').slice(0, midBudget);
        const tailPart = text.slice(-tailBudget);
        const combined = `${headPart}\n\n${relPart}${marker}${tailPart}`;
        if (combined.length <= MAX_VOICE_MEMORY_CHARS) return combined;
      }
    }

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

  private atomicWrite(content: string): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, content.endsWith('\n') ? content : `${content}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

function parseSections(text: string): { header: string; sections: MemorySection[] } {
  const lines = text.split('\n');
  const headerLines: string[] = [];
  const sections: MemorySection[] = [];
  let current: MemorySection | undefined;
  for (const line of lines) {
    const match = /^##\s+(.+)$/.exec(line);
    if (match) {
      current = { heading: match[1]!.trim(), body: '' };
      sections.push(current);
      continue;
    }
    if (!current) {
      headerLines.push(line);
    } else {
      current.body = current.body ? `${current.body}\n${line}` : line;
    }
  }
  for (const sec of sections) sec.body = sec.body.trim();
  return { header: headerLines.join('\n').trim(), sections };
}

function serializeSections(header: string, sections: MemorySection[]): string {
  const parts: string[] = [];
  if (header) parts.push(header);
  for (const sec of sections) {
    parts.push(`## ${sec.heading}\n${sec.body}`);
  }
  return `${parts.join('\n\n')}\n`;
}

function sanitizeInline(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function sanitizeEntry(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ').replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_ENTRY_CHARS);
}

function assertNoSecrets(text: string): void {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error('Refused to store potential secret, API key, token, or credential in persistent memory');
  }
}
