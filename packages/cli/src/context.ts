import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Table from 'cli-table3';
import pc from 'picocolors';

export interface StoredAgentContext {
  sessionId: string;
  source: string;
  workspace?: string;
  paneId?: string;
  agent?: string;
  command: string;
  status: string;
  firstSeenAt: number;
  lastSeenAt: number;
  completedAt?: number;
  present: boolean;
  preview?: string;
  context?: string;
  history?: Array<{ observedAt: number; status: string; summary: string }>;
}

interface StoredContextState {
  generatedAt: number;
  records: StoredAgentContext[];
}

const SEMANTIC_GROUPS = [
  ['voice', 'audio', 'speech', 'tts', 'microphone', 'mic', '语音', '声音', '朗读', '麦克风'],
  ['android', 'samsung', '三星', '安卓'],
  ['iphone', 'ipad', 'ios', 'apple', '苹果'],
  ['terminal', 'shell', 'cli', '命令行', '终端', '工具'],
  ['context', 'memory', 'history', '上下文', '记忆', '历史'],
];

export function contextStatePath(): string {
  return process.env.TB_CONTEXT_STATE || join(homedir(), '.termbridge', 'context.json');
}

export function loadContextState(path = contextStatePath()): StoredContextState {
  if (!existsSync(path)) return { generatedAt: 0, records: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredContextState>;
    return {
      generatedAt: typeof parsed.generatedAt === 'number' ? parsed.generatedAt : 0,
      records: Array.isArray(parsed.records) ? parsed.records.filter(validRecord) : [],
    };
  } catch {
    return { generatedAt: 0, records: [] };
  }
}

export function searchContexts(records: StoredAgentContext[], query: string): StoredAgentContext[] {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || [];
  return [...records]
    .map((record) => ({ record, score: searchScore(record, query, terms) }))
    .filter(({ score }) => !query.trim() || score > 0)
    .sort((left, right) => right.score - left.score || right.record.lastSeenAt - left.record.lastSeenAt)
    .map(({ record }) => record);
}

export function runContextList(includeHistory = false): void {
  const state = loadContextState();
  const records = searchContexts(state.records.filter((record) => includeHistory || record.present), '');
  if (!records.length) {
    console.log(pc.dim('No Agent contexts captured yet. Keep the host running, then try `tb context list` again.'));
    return;
  }
  printTable(records);
  console.log(pc.dim(`  snapshot ${formatAge(state.generatedAt)} · ${contextStatePath()}`));
}

export function runContextSearch(terms: string[]): void {
  const query = terms.join(' ').trim();
  if (!query) throw new Error('usage: tb context search <terms>');
  const records = searchContexts(loadContextState().records, query).slice(0, 20);
  if (!records.length) {
    console.log(pc.dim(`No Agent context matched ${JSON.stringify(query)}.`));
    return;
  }
  printTable(records);
  for (const record of records.slice(0, 5)) {
    const excerpt = matchingExcerpt(record, query);
    if (excerpt) console.log(`\n${pc.cyan(record.sessionId)}\n${excerpt}`);
  }
}

export function runContextShow(sessionId: string): void {
  const record = loadContextState().records.find((candidate) =>
    candidate.sessionId === sessionId || candidate.paneId === sessionId,
  );
  if (!record) throw new Error(`no captured Agent context ${sessionId}`);
  console.log(pc.bold(`${record.workspace || '-'} · ${record.agent || record.command}`));
  console.log(
    pc.dim('  session ') + record.sessionId + pc.dim('   status ') + colorStatus(record.status) +
    pc.dim('   last seen ') + formatAge(record.lastSeenAt),
  );
  if (record.preview) console.log(`\n${pc.bold('Latest summary')}\n${record.preview}`);
  if (record.context) console.log(`\n${pc.bold('Captured recent context')}\n${record.context}`);
  if (record.history?.length) {
    console.log(`\n${pc.bold('Summary history')}`);
    for (const item of record.history) {
      console.log(`${pc.dim(new Date(item.observedAt).toISOString())} ${item.status.padEnd(8)} ${item.summary}`);
    }
  }
}

function printTable(records: StoredAgentContext[]): void {
  const table = new Table({
    head: ['priority', 'workspace / agent', 'session', 'status', 'last context'].map((value) => pc.dim(value)),
    colWidths: [10, 34, 18, 12, 68],
    wordWrap: true,
  });
  for (const [index, record] of records.entries()) {
    table.push([
      String(index + 1),
      `${record.workspace || '-'}\n${pc.dim(record.agent || record.command)}`,
      record.sessionId,
      colorStatus(record.status),
      record.preview || record.history?.at(-1)?.summary || '(no summary)',
    ]);
  }
  console.log(table.toString());
}

function searchScore(record: StoredAgentContext, query: string, terms: string[]): number {
  const identity = [record.workspace, record.agent, record.command, record.paneId]
    .filter(Boolean).join('\n').toLowerCase();
  const content = [record.preview, record.context,
    ...(record.history || []).map((entry) => entry.summary)].filter(Boolean).join('\n').toLowerCase();
  const status: Record<string, number> = { working: 4_000, done: 3_000, idle: 1_600, unknown: 700 };
  const direct = terms.reduce((score, term) => score
    + (identity.includes(term) ? 3_000 : 0)
    + (content.includes(term) ? 300 : 0), 0);
  const semantic = SEMANTIC_GROUPS.reduce((score, group) => {
    if (!group.some((term) => query.toLowerCase().includes(term))) return score;
    if (group.some((term) => identity.includes(term))) return score + 12_000;
    if (group.some((term) => content.includes(term))) return score + 5_000;
    return score;
  }, 0);
  return (record.present ? 10_000 : 0) + (status[record.status] || 0) + direct + semantic;
}

function matchingExcerpt(record: StoredAgentContext, query: string): string {
  const text = record.context || record.preview || record.history?.at(-1)?.summary || '';
  if (!text) return '';
  const terms = query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || [];
  const lower = text.toLowerCase();
  const position = terms.map((term) => lower.indexOf(term)).find((index) => index >= 0) ?? -1;
  if (position === -1) return text.slice(-800);
  return text.slice(Math.max(0, position - 300), position + 700);
}

function colorStatus(status: string): string {
  if (status === 'working') return pc.green(status);
  if (status === 'done') return pc.cyan(status);
  if (status === 'failed') return pc.red(status);
  return pc.dim(status);
}

function formatAge(timestamp: number): string {
  if (!timestamp) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function validRecord(value: unknown): value is StoredAgentContext {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<StoredAgentContext>;
  return typeof record.sessionId === 'string'
    && typeof record.command === 'string'
    && typeof record.status === 'string'
    && typeof record.lastSeenAt === 'number';
}
