import { findExternalHttpLinks, safeExternalHttpUrl } from './httpLinks.js';
import type { TranscriptLink } from './agentTranscriptLinks.js';

const ANSI_SEQUENCE_SOURCE = String.raw`\x1b(?:\[([0-?]*)([ -/]*)([@-~])|\][^\x07]*(?:\x07|\x1b\\))`;
const CONTROL_CHARACTER = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

const ANSI_COLORS = [
  '#151A16', '#E06C65', '#91C39A', '#D8B26E', '#79A8D8', '#C792C7', '#76C7C0', '#DDE5DB',
  '#657066', '#F08A82', '#B0D9B6', '#E8CA8C', '#9ABFE4', '#D9A8D8', '#9BDCD5', '#F6FAF5',
];

export interface MobileTranscriptSpan {
  text: string;
  style?: string;
  href?: string;
}

export interface MobileTranscriptLine {
  spans: MobileTranscriptSpan[];
}

export interface MobileTranscriptSnapshot {
  revision: number;
  lines: MobileTranscriptLine[];
}

export interface MobileTranscriptPatch {
  oldStart: number;
  newStart: number;
  retainCount: number;
  before: MobileTranscriptLine[];
  after: MobileTranscriptLine[];
}

interface AnsiStyle {
  foreground?: string;
  background?: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  invisible: boolean;
  strike: boolean;
}

interface ParserState {
  style: AnsiStyle;
  href?: string;
}

function defaultStyle(): AnsiStyle {
  return {
    foreground: undefined,
    background: undefined,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
    invisible: false,
    strike: false,
  };
}

/** Convert a full Herdr ANSI snapshot into safe, client-renderable logical lines. */
export function parseMobileTranscript(
  text: string,
  knownLinks: readonly TranscriptLink[] = [],
): MobileTranscriptLine[] {
  const state: ParserState = { style: defaultStyle() };
  return compactMobilePaneLines(text).map((line) => applyKnownLinks(parseAnsiLine(line, state), knownLinks));
}

/** Keep the same mobile compaction rules for legacy redraw and structured patches. */
export function compactMobilePaneLines(text: string): string[] {
  const escape = new RegExp(ANSI_SEQUENCE_SOURCE, 'g');
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      const withoutLongRules = line.replace(/[─━═┄┈┉╌╍]{8,}/g, '');
      const trailingAnsi = withoutLongRules.match(new RegExp(`(?:${ANSI_SEQUENCE_SOURCE})+$`))?.[0] || '';
      const body = trailingAnsi ? withoutLongRules.slice(0, -trailingAnsi.length) : withoutLongRules;
      return body.replace(/[ \t]+$/g, '').replace(/[ \t]{8,}/g, '    ') + trailingAnsi;
    });
  const compact: string[] = [];
  for (const line of lines) {
    const visible = line.replace(escape, '');
    if (/^[\s─━═┄┈┉╌╍│┃┌┐└┘├┤┬┴┼]+$/.test(visible) && visible.trim()) continue;
    if (!visible.trim()) {
      const previous = compact.at(-1)?.replace(new RegExp(ANSI_SEQUENCE_SOURCE, 'g'), '').trim();
      if (previous === '') continue;
      compact.push('');
      continue;
    }
    compact.push(line);
  }
  while (compact[0]?.replace(new RegExp(ANSI_SEQUENCE_SOURCE, 'g'), '').trim() === '') compact.shift();
  while (compact.at(-1)?.replace(new RegExp(ANSI_SEQUENCE_SOURCE, 'g'), '').trim() === '') compact.pop();
  return compact;
}

/** Describe one update around the largest stable contiguous block. */
export function createMobileTranscriptPatch(
  previous: readonly MobileTranscriptLine[],
  next: readonly MobileTranscriptLine[],
): MobileTranscriptPatch {
  const retained = largestRetainedBlock(previous, next);
  return {
    oldStart: retained.oldStart,
    newStart: retained.newStart,
    retainCount: retained.count,
    before: next.slice(0, retained.newStart),
    after: next.slice(retained.newStart + retained.count),
  };
}

function parseAnsiLine(raw: string, state: ParserState): MobileTranscriptLine {
  const spans: MobileTranscriptSpan[] = [];
  let cursor = 0;
  for (const match of raw.matchAll(new RegExp(ANSI_SEQUENCE_SOURCE, 'g'))) {
    const index = match.index ?? cursor;
    appendSpan(spans, raw.slice(cursor, index), state);
    if (match[3] === 'm' && !match[2]) applySgr(state.style, match[1] || '0');
    else if (match[0].startsWith('\x1b]8;')) state.href = osc8Href(match[0]);
    cursor = index + match[0].length;
  }
  appendSpan(spans, raw.slice(cursor), state);
  return { spans };
}

function appendSpan(spans: MobileTranscriptSpan[], rawText: string, state: ParserState): void {
  const text = rawText.replace(CONTROL_CHARACTER, '');
  if (!text) return;
  const style = cssStyle(state.style);
  const links = state.href
    ? [{ text, href: state.href, start: 0, end: text.length }]
    : findExternalHttpLinks(text);
  let cursor = 0;
  for (const link of links) {
    appendStyledSpan(spans, text.slice(cursor, link.start), style);
    appendStyledSpan(spans, link.text, style, link.href);
    cursor = link.end;
  }
  appendStyledSpan(spans, text.slice(cursor), style);
}

function appendStyledSpan(
  spans: MobileTranscriptSpan[],
  text: string,
  style?: string,
  href?: string,
): void {
  if (!text) return;
  const previous = spans.at(-1);
  if (previous && previous.style === style && previous.href === href) {
    previous.text += text;
    return;
  }
  spans.push({ text, ...(style ? { style } : {}), ...(href ? { href } : {}) });
}

function osc8Href(sequence: string): string | undefined {
  const match = /^\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)$/.exec(sequence);
  return match ? safeExternalHttpUrl(match[1]) : undefined;
}

function applyKnownLinks(
  line: MobileTranscriptLine,
  knownLinks: readonly TranscriptLink[],
): MobileTranscriptLine {
  if (!knownLinks.length || !line.spans.length) return line;
  const text = line.spans.map((span) => span.text).join('');
  const ranges: Array<{ start: number; end: number; href: string }> = [];
  let offset = 0;
  for (const span of line.spans) {
    if (span.href) ranges.push({ start: offset, end: offset + span.text.length, href: span.href });
    offset += span.text.length;
  }
  for (const link of knownLinks) {
    const href = safeExternalHttpUrl(link.href);
    if (!href || !link.text || link.text.length > 256) continue;
    let start = text.indexOf(link.text);
    while (start >= 0) {
      const candidate = { start, end: start + link.text.length, href };
      if (!ranges.some((range) => overlaps(range, candidate))) ranges.push(candidate);
      start = text.indexOf(link.text, start + link.text.length);
    }
  }
  if (!ranges.length) return line;
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);

  const linked: MobileTranscriptSpan[] = [];
  offset = 0;
  for (const span of line.spans) {
    const spanStart = offset;
    const spanEnd = spanStart + span.text.length;
    const cuts = new Set([spanStart, spanEnd]);
    for (const range of ranges) {
      if (range.start > spanStart && range.start < spanEnd) cuts.add(range.start);
      if (range.end > spanStart && range.end < spanEnd) cuts.add(range.end);
    }
    const boundaries = [...cuts].sort((left, right) => left - right);
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const start = boundaries[index];
      const end = boundaries[index + 1];
      const range = ranges.find((candidate) => candidate.start <= start && candidate.end >= end);
      appendStyledSpan(linked, span.text.slice(start - spanStart, end - spanStart), span.style, span.href ?? range?.href);
    }
    offset = spanEnd;
  }
  return { spans: linked };
}

function overlaps(
  left: { start: number; end: number },
  right: { start: number; end: number },
): boolean {
  return left.start < right.end && right.start < left.end;
}

function applySgr(state: AnsiStyle, encoded: string): void {
  const params = encoded.split(/[;:]/).filter((value) => value !== '').map(Number);
  if (params.length === 0) params.push(0);
  for (let index = 0; index < params.length; index += 1) {
    const code = params[index];
    if (code === 0) Object.assign(state, defaultStyle());
    else if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (code === 3) state.italic = true;
    else if (code === 4) state.underline = true;
    else if (code === 7) state.inverse = true;
    else if (code === 8) state.invisible = true;
    else if (code === 9) state.strike = true;
    else if (code === 22) { state.bold = false; state.dim = false; }
    else if (code === 23) state.italic = false;
    else if (code === 24) state.underline = false;
    else if (code === 27) state.inverse = false;
    else if (code === 28) state.invisible = false;
    else if (code === 29) state.strike = false;
    else if (code >= 30 && code <= 37) state.foreground = ANSI_COLORS[code - 30];
    else if (code >= 90 && code <= 97) state.foreground = ANSI_COLORS[code - 90 + 8];
    else if (code === 39) state.foreground = undefined;
    else if (code >= 40 && code <= 47) state.background = ANSI_COLORS[code - 40];
    else if (code >= 100 && code <= 107) state.background = ANSI_COLORS[code - 100 + 8];
    else if (code === 49) state.background = undefined;
    else if (code === 38 || code === 48) {
      const color = extendedColor(params, index + 1);
      if (!color) continue;
      if (code === 38) state.foreground = color.value;
      else state.background = color.value;
      index += color.consumed;
    }
  }
}

function extendedColor(params: number[], start: number): { value: string; consumed: number } | undefined {
  if (params[start] === 5 && Number.isInteger(params[start + 1])) {
    return { value: ansiColor(params[start + 1]), consumed: 2 };
  }
  if (params[start] === 2 && params.slice(start + 1, start + 4).every(Number.isFinite)) {
    const [red, green, blue] = params.slice(start + 1, start + 4).map((value) => clamp(value, 0, 255));
    return { value: `#${hex(red)}${hex(green)}${hex(blue)}`, consumed: 4 };
  }
  return undefined;
}

function ansiColor(index: number): string {
  const safe = clamp(index, 0, 255);
  if (safe < ANSI_COLORS.length) return ANSI_COLORS[safe];
  if (safe < 232) {
    const value = safe - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    return `rgb(${levels[Math.floor(value / 36)]} ${levels[Math.floor((value % 36) / 6)]} ${levels[value % 6]})`;
  }
  const gray = 8 + (safe - 232) * 10;
  return `rgb(${gray} ${gray} ${gray})`;
}

function cssStyle(state: AnsiStyle): string | undefined {
  let foreground = state.foreground;
  let background = state.background;
  if (state.inverse) [foreground, background] = [background ?? '#0D100E', foreground ?? '#DDE5DB'];
  const styles: string[] = [];
  if (foreground) styles.push(`color:${foreground}`);
  if (background) styles.push(`background-color:${background}`);
  if (state.bold) styles.push('font-weight:700');
  if (state.italic) styles.push('font-style:italic');
  if (state.dim) styles.push('opacity:.68');
  if (state.underline) styles.push('text-decoration:underline');
  if (state.strike) styles.push('text-decoration:line-through');
  if (state.invisible) styles.push('visibility:hidden');
  return styles.join(';') || undefined;
}

function largestRetainedBlock(
  previous: readonly MobileTranscriptLine[],
  next: readonly MobileTranscriptLine[],
): { oldStart: number; newStart: number; count: number } {
  const oldKeys = previous.map(lineKey);
  const newKeys = next.map(lineKey);
  let prior = new Uint16Array(newKeys.length + 1);
  let best = { oldStart: 0, newStart: 0, count: 0 };
  for (let oldIndex = 0; oldIndex < oldKeys.length; oldIndex += 1) {
    const current = new Uint16Array(newKeys.length + 1);
    for (let newIndex = 0; newIndex < newKeys.length; newIndex += 1) {
      if (oldKeys[oldIndex] !== newKeys[newIndex]) continue;
      const count = prior[newIndex] + 1;
      current[newIndex + 1] = count;
      const candidate = { oldStart: oldIndex - count + 1, newStart: newIndex - count + 1, count };
      if (betterRetainedBlock(candidate, best, previous.length, next.length)) best = candidate;
    }
    prior = current;
  }
  return best;
}

function betterRetainedBlock(
  candidate: { oldStart: number; newStart: number; count: number },
  current: { oldStart: number; newStart: number; count: number },
  oldLength: number,
  newLength: number,
): boolean {
  if (candidate.count !== current.count) return candidate.count > current.count;
  const edgeScore = (block: typeof candidate) =>
    (block.oldStart + block.count === oldLength && block.newStart === 0 ? 4 : 0) +
    (block.oldStart === 0 && block.newStart === 0 ? 3 : 0) +
    (block.oldStart + block.count === oldLength ? 2 : 0) +
    (block.newStart + block.count === newLength ? 1 : 0);
  const scoreDifference = edgeScore(candidate) - edgeScore(current);
  if (scoreDifference !== 0) return scoreDifference > 0;
  return candidate.oldStart + candidate.newStart < current.oldStart + current.newStart;
}

function lineKey(line: MobileTranscriptLine): string {
  return JSON.stringify(line.spans);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function hex(value: number): string {
  return value.toString(16).padStart(2, '0');
}
