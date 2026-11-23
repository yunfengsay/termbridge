import { textVerdict, type TextThresholds } from '@termbridge/voice';
export type ScoredTurn = { id: string; label: 0 | 1; lang: string; score: number | undefined; hasContext?: boolean; sourceKind?: string; routingLanguage?: 'zh' | 'en' };
export type TurnThresholds = TextThresholds | { zh: TextThresholds; en: TextThresholds };
export const TURN_GATES = Object.freeze({ early: .02, late: .05, coverage: .3, minDirection: 50, p95Ms: 10, bytes: 2 * 1024 * 1024 });
function divide(n: number, d: number) { return d ? n / d : 0; }
function wilson(n: number, d: number): [number, number] | null {
  if (!d) return null;
  const z = 1.96, p = n / d, norm = 1 + z * z / d;
  const center = (p + z * z / (2 * d)) / norm;
  const half = z * Math.sqrt(p * (1 - p) / d + z * z / (4 * d * d)) / norm;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}
export function turnMetrics(rows: ScoredTurn[], thresholds: TurnThresholds) {
  let respond = 0, wait = 0, early = 0, late = 0;
  const unfinished = rows.filter(row => row.label === 0).length, finished = rows.length - unfinished;
  for (const row of rows) {
    const selected = 'wait' in thresholds ? thresholds : thresholds[row.routingLanguage ?? (row.lang === 'zh' ? 'zh' : 'en')];
    const verdict = textVerdict(row.score, selected);
    if (verdict === 'respond') { respond++; if (!row.label) early++; }
    if (verdict === 'wait') { wait++; if (row.label) late++; }
  }
  return { total: rows.length, finished, unfinished, respond, wait, fallback: rows.length - respond - wait, early, late,
    coverage: divide(respond + wait, rows.length), earlyRate: divide(early, unfinished), lateRate: divide(late, finished),
    respondError: divide(early, respond), waitError: divide(late, wait),
    ci95: { earlyRate: wilson(early, unfinished), lateRate: wilson(late, finished),
      respondError: wilson(early, respond), waitError: wilson(late, wait) } };
}
export function calibrateLanguages(rows: ScoredTurn[]): TurnThresholds {
  return { zh: calibrateTurn(rows.filter(row => row.routingLanguage === 'zh'), false, true),
    en: calibrateTurn(rows.filter(row => row.routingLanguage === 'en'), false, true) };
}
export function safetyPass(m: ReturnType<typeof turnMetrics>) {
  return m.finished > 0 && m.unfinished > 0 && m.earlyRate <= TURN_GATES.early && m.respondError <= TURN_GATES.early &&
    m.lateRate <= TURN_GATES.late && m.waitError <= TURN_GATES.late &&
    (m.respond === 0 || m.respond >= TURN_GATES.minDirection) && (m.wait === 0 || m.wait >= TURN_GATES.minDirection);
}
/** Calibrate on DEV ONLY. Disabled directions use -1/2 sentinel thresholds. */
export function calibrateTurn(rows: ScoredTurn[], conservative = false, domain = false): TextThresholds {
  let wait = -1, respond = 2;
  const slices = domain ? ['zh', 'en'].map(lang => rows.filter(row => row.lang === lang))
    .concat([rows.filter(row => !row.hasContext)]).filter(rows => rows.length >= 100) : [];
  const pass = (thresholds: TextThresholds) => slices.every(rows => safetyPass(turnMetrics(rows, thresholds)));
  for (let step = 0; step < 50; step++) {
    const t = step / 100, metrics = turnMetrics(rows, { wait: t, respond: 2 });
    if (metrics.wait >= TURN_GATES.minDirection && safetyPass(metrics) && pass({ wait: t, respond: 2 }) &&
        (!conservative || (metrics.ci95.waitError?.[1] ?? 1) <= TURN_GATES.late)) wait = t;
  }
  for (let step = 100; step > 50; step--) {
    const t = step / 100, metrics = turnMetrics(rows, { wait: -1, respond: t });
    if (metrics.respond >= TURN_GATES.minDirection && safetyPass(metrics) && pass({ wait: -1, respond: t }) &&
        (!conservative || (metrics.ci95.respondError?.[1] ?? 1) <= TURN_GATES.early)) respond = t;
  }
  return { wait, respond };
}
