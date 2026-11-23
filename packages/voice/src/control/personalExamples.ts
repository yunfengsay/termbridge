/** Case-based learning of explicitly reviewed text. Not ASR, speaker identity, or authorization. */
export type PersonalExample = {
  id: string; group: string; head: 'addressed' | 'finished'; label: 0 | 1;
  text: string; context?: string;
};
export type ExampleHint = Pick<PersonalExample, 'head' | 'label' | 'text' | 'context'>;
export type ExampleEvaluation = { groups: number; tested: number; matched: number; correct: number };
function terms(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ' ').trim();
  const result = normalized.split(/\s+/).filter(Boolean);
  // CJK has no word spaces. Bigrams also tolerate ASR spacing and inflected technical names.
  const compact = normalized.replace(/\s/g, '');
  for (let i = 0; i + 1 < compact.length; i++) result.push(compact.slice(i, i + 2));
  return [...new Set(result)];
}
function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0, aa = 0, bb = 0;
  for (const [key, value] of a) { dot += value * (b.get(key) ?? 0); aa += value * value; }
  for (const value of b.values()) bb += value * value;
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

/** Bounded TF-IDF index trained only from this peer's confirmed examples. */
export class PersonalExamples {
  private readonly idf = new Map<string, number>();
  private readonly entries: { row: PersonalExample; text: Map<string, number>; context: Map<string, number> }[];
  constructor(readonly rows: readonly PersonalExample[]) {
    if (rows.length > 500) throw new Error('Too many personal examples');
    for (const row of rows) for (const term of terms(row.text)) this.idf.set(term, (this.idf.get(term) ?? 0) + 1);
    for (const [term, count] of this.idf) this.idf.set(term, 1 + Math.log((rows.length + 1) / (count + 1)));
    this.entries = rows.map(row => ({ row, text: this.vector(row.text), context: this.vector(row.context ?? '') }));
  }
  private vector(text: string) { return new Map(terms(text).map(term => [term, this.idf.get(term) ?? 1])); }
  rank(text: string, context = '', excludeGroup?: string) {
    const query = this.vector(text), previous = this.vector(context);
    return this.entries.filter(entry => entry.row.group !== excludeGroup).map(entry => ({
      row: entry.row, score: cosine(query, entry.text) * (0.8 + 0.2 * cosine(previous, entry.context)),
    })).filter(entry => entry.score >= 0.22).sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));
  }
  hints(text: string, context = ''): ExampleHint[] {
    return this.rank(text, context).slice(0, 4).map(({ row }) => ({
      head: row.head, label: row.label, text: row.text, context: row.context,
    }));
  }
  /** Conservative personal rules, not inferred speaker identity: three independent reviewed calls,
   * exact text AND nonempty previous context, unanimous negative labels. Never auto-authorize. */
  rule(text: string, context: string): 'ignore' | 'wait' | undefined {
    const key = (value: string) => value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!context.trim()) return;
    const matches = this.rows.filter(row => key(row.text) === key(text) && key(row.context ?? '') === key(context));
    for (const head of ['addressed', 'finished'] as const) {
      const rows = matches.filter(row => row.head === head);
      if (rows.length && rows.every(row => row.label === 0) && new Set(rows.map(row => row.group)).size >= 3)
        return head === 'addressed' ? 'ignore' : 'wait';
    }
  }
  get rules(): number {
    return new Set(this.rows.filter(row => this.rule(row.text, row.context ?? ''))
      .map(row => JSON.stringify([row.text, row.context]))).size;
  }
  /** Leave-one-conversation-out; neither index weights nor neighbors see the held-out group.
   * This measures retrieval-label agreement, NOT end-to-end intent accuracy. */
  evaluate(): ExampleEvaluation {
    const groups = [...new Set(this.rows.map(row => row.group))];
    const result = { groups: groups.length, tested: 0, matched: 0, correct: 0 };
    // Deterministic, bounded validation: at most 20 groups / 100 examples per update.
    for (const group of groups.sort().slice(0, 20)) {
      const training = new PersonalExamples(this.rows.filter(row => row.group !== group));
      for (const row of this.rows.filter(row => row.group === group)) {
        if (result.tested >= 100) return result;
        result.tested++;
        const neighbor = training.rank(row.text, row.context).find(entry => entry.row.head === row.head);
        if (neighbor) { result.matched++; if (neighbor.row.label === row.label) result.correct++; }
      }
    }
    return result;
  }
}
