import { createHash } from 'node:crypto';
import { normalizedTurn, type TextExample } from '@termbridge/voice';

export const TURN_DATA_REVISION = 'b5b536e96076a156e79b7e6db9ca8fd100d3f976';
export const TURN_TRAIN_SHA = 'c43efde49c8a2d632095bc0e7dcd47080a5f0ea198d34a7c3b24a117cfc0eb3d';
export const digestText = (text: string) => createHash('sha256').update(text).digest('hex');
export type TrainingRow = TextExample & { id: string; group: string; lang: string; rawText: string; sourceKind?: 'real' | 'synthetic' };
type Message = { role: 'user' | 'assistant'; content: string };
function label(value: string): 0 | 1 | undefined { return value.trim() === '<完成>' ? 1 : value.trim() === '<未完>' ? 0 : undefined; }
function convert(dialog: Message[], target: 0 | 1, id: string, lang: string): TrainingRow {
  let current = -1;
  for (let index = 0; index < dialog.length; index++) if (dialog[index].role === 'user') current = index;
  if (current < 0 || !dialog[current].content.trim()) throw new Error('Missing current human utterance');
  const history = dialog.slice(0, current);
  const text = dialog[current].content.trim();
  return { id, group: '', label: target, text, rawText: text,
    context: history.slice(-4).map(item => `${item.role}: ${item.content}`).join('\n'), lang };
}
export function parseTraining(raw: unknown): TrainingRow[] {
  if (!Array.isArray(raw) || raw.length > 20_000) throw new Error('Invalid training array');
  return raw.flatMap(row => {
    if (typeof row.output !== 'string') throw new Error('Invalid training label');
    const target = label(row.output);
    if (target === undefined || !['Ke-多轮', 'Ke-EN'].includes(row.source)) return [];
    if (row.input !== '' || typeof row.instruction !== 'string') throw new Error('Unsupported training dialogue');
    const turns = [...row.instruction.matchAll(/^(Human|Agent)\[(?:历史|实时)\]:([\s\S]*?)(?=^(?:Human|Agent)\[(?:历史|实时)\]:|$(?![\s\S]))/gm)];
    const dialog: Message[] = turns.map(match => ({ role: match[1] === 'Human' ? 'user' : 'assistant', content: match[2].trim() }));
    return [convert(dialog, target, digestText(JSON.stringify(dialog)), row.lang === 'en' ? 'en' : 'zh')];
  });
}
export function parseTest(raw: unknown): TrainingRow[] {
  if (!Array.isArray(raw) || raw.length > 10_000) throw new Error('Invalid test array');
  return raw.flatMap(row => {
    const target = label(row.label);
    if (target === undefined) return [];
    const input = row.dialog.filter((item: { speaker: string }) => item.speaker !== 'VAD');
    const dialog: Message[] = input.map((item: { speaker: string; text: string }) => {
      if (!['Human', 'Agent'].includes(item.speaker) || typeof item.text !== 'string') throw new Error('Unsupported test speaker');
      return { role: item.speaker === 'Human' ? 'user' : 'assistant', content: item.text.trim() };
    });
    return [convert(dialog, target, digestText(JSON.stringify(input)), row.lang === 'en' ? 'en' : 'zh')];
  });
}
export function parseEasyTurn(raw: string, target: 0 | 1): TrainingRow[] {
  return raw.trim().split('\n').map(line => {
    const row = JSON.parse(line), tag = target ? '<COMPLETE>' : '<INCOMPLETE>';
    if (typeof row.txt !== 'string' || !row.txt.endsWith(tag) || row.lang !== '<CN>') throw new Error('Unexpected Easy Turn metadata');
    const text = row.txt.slice(0, -tag.length).trim();
    if (/<[^>]*>/.test(text)) throw new Error('Unremoved dataset control token');
    return { ...convert([{ role: 'user', content: text }], target, digestText(`easy-turn:${row.key}`), 'zh'),
      sourceKind: row.extra.dataset.endsWith('_real') ? 'real' as const : 'synthetic' as const };
  });
}
function keys(row: TrainingRow): string[] {
  const text = normalizedTurn(row.text), context = normalizedTurn(row.context);
  return [text.length >= 4 ? `text:${text}` : `short:${context}:${text}`,
    ...(text.length >= 24 ? [`prefix:${text.slice(0, 24)}`] : []),
    ...(context.length >= 8 ? [`conversation:${context}`] : [])];
}
/** Conservative connected groups: repeated context, exact input, or shared long prefix stay together. */
export function splitTurnCorpus(training: TrainingRow[], officialTest: TrainingRow[], previouslySeen: Set<string>) {
  const all = [...training, ...officialTest], parents = all.map((_, i) => i), byKey = new Map<string, number>();
  function root(i: number): number { while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i]; } return i; }
  for (let i = 0; i < all.length; i++) for (const key of keys(all[i])) {
    const previous = byKey.get(key);
    if (previous === undefined) byKey.set(key, i); else parents[root(i)] = root(previous);
  }
  const ids = new Map<number, string>();
  for (let i = 0; i < all.length; i++) { const r = root(i), id = all[i].id; if (!ids.has(r) || ids.get(r)! > id) ids.set(r, id); }
  for (let i = 0; i < all.length; i++) all[i] = { ...all[i], group: ids.get(root(i))! };
  const tests = all.slice(training.length), testGroups = new Set(tests.map(row => row.group));
  const seenGroups = new Set(tests.filter(row => previouslySeen.has(row.id)).map(row => row.group));
  let overlap = 0, seen = 0, duplicates = 0, conflicts = 0;
  function dedupe(rows: TrainingRow[]) {
    const unique = new Map<string, TrainingRow>(), ambiguous = new Set<string>();
    for (const row of rows) {
      const key = digestText(normalizedTurn(row.context) + '\n' + normalizedTurn(row.text));
      if (unique.has(key)) { duplicates++; if (unique.get(key)!.label !== row.label) ambiguous.add(key); }
      else unique.set(key, row);
    }
    conflicts += ambiguous.size; return [...unique].filter(([key]) => !ambiguous.has(key)).map(([, row]) => row);
  }
  const fitDev = dedupe(all.slice(0, training.length).filter(row => { if (testGroups.has(row.group)) { overlap++; return false; } return true; }));
  const holdout = dedupe(tests.filter(row => { if (seenGroups.has(row.group)) { seen++; return false; } return true; }));
  const isDev = (row: TrainingRow) => parseInt(digestText(`split-v1:${row.group}`).slice(0, 8), 16) % 5 === 0;
  return { train: fitDev.filter(row => !isDev(row)), dev: fitDev.filter(isDev), holdout,
    excluded: { trainTestOverlap: overlap, previouslySeenAndRelated: seen, duplicates, conflictingInputs: conflicts },
    caveat: 'Exact/context/24-character prefix grouping, not proof of absence of semantic paraphrases across splits.' };
}
