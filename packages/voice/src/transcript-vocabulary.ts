interface TokenSpan {
  start: number;
  end: number;
  value: string;
}

const latinToken = /[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*/gu;

/**
 * Reconcile only a term that the streaming ASR already surfaced in this exact
 * utterance. This keeps the vocabulary a correction hint, never a global text
 * replacement rule.
 */
export function reconcileTechnicalTranscript(
  finalTranscript: string,
  previews: readonly string[],
  technicalTerms: readonly string[] = [],
): string {
  let result = finalTranscript.trim();
  if (!result || previews.length === 0 || technicalTerms.length === 0) return result;

  const terms = [...new Set(technicalTerms.map((term) => term.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .slice(0, 10);
  for (const term of terms) {
    const evidence = [...previews].reverse().find((preview) => findTerm(preview, term) >= 0);
    if (!evidence) continue;
    const evidenceStart = findTerm(evidence, term);
    const exactStart = findTerm(result, term);
    if (exactStart >= 0) {
      result = `${result.slice(0, exactStart)}${term}${result.slice(exactStart + term.length)}`;
      continue;
    }

    const termWords = tokens(term);
    if (termWords.length === 0) continue;
    const candidates = tokenWindows(result, termWords.length)
      .filter((candidate) => isPhoneticallyClose(candidate.value, term));
    if (candidates.length === 0) continue;
    const expectedPosition = evidenceStart / Math.max(1, evidence.length);
    const candidate = candidates
      .map((span) => ({
        span,
        distance: Math.abs(span.start / Math.max(1, result.length) - expectedPosition),
      }))
      .filter(({ distance }) => distance <= 0.3)
      .sort((a, b) => a.distance - b.distance)[0]?.span;
    if (!candidate) continue;
    result = `${result.slice(0, candidate.start)}${term}${result.slice(candidate.end)}`;
  }
  return result;
}

function findTerm(text: string, term: string): number {
  const source = text.toLocaleLowerCase('en-US');
  const target = term.toLocaleLowerCase('en-US');
  let offset = source.indexOf(target);
  while (offset >= 0) {
    const before = source[offset - 1];
    const after = source[offset + target.length];
    if (!isLatinWord(before) && !isLatinWord(after)) return offset;
    offset = source.indexOf(target, offset + 1);
  }
  return -1;
}

function isLatinWord(value: string | undefined): boolean {
  return value != null && /[a-z0-9]/iu.test(value);
}

function tokens(text: string): TokenSpan[] {
  return [...text.matchAll(latinToken)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    value: match[0],
  }));
}

function tokenWindows(text: string, size: number): TokenSpan[] {
  const found = tokens(text);
  const windows: TokenSpan[] = [];
  for (let index = 0; index + size <= found.length; index += 1) {
    const first = found[index];
    const last = found[index + size - 1];
    const separatedOnlyByWordGaps = found
      .slice(index, index + size - 1)
      .every((token, offset) => !/[^\s._-]/u.test(text.slice(token.end, found[index + offset + 1].start)));
    if (!separatedOnlyByWordGaps) continue;
    windows.push({ start: first.start, end: last.end, value: text.slice(first.start, last.end) });
  }
  return windows;
}

function isPhoneticallyClose(value: string, term: string): boolean {
  const actual = tokens(value).map((token) => token.value);
  const expected = tokens(term).map((token) => token.value);
  return actual.length === expected.length && actual.every((word, index) => {
    const left = latinLetters(word);
    const right = latinLetters(expected[index]);
    if (!left || !right) return false;
    if (left === right) return true;
    return soundex(left) === soundex(right) && Math.abs(left.length - right.length) <= 2;
  });
}

function latinLetters(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/[^a-z]/gu, '');
}

function soundex(value: string): string {
  const letters = value.toUpperCase().replace(/[^A-Z]/gu, '');
  if (!letters) return '';
  const first = letters[0];
  let previous = soundexDigit(first);
  let digits = '';
  for (const letter of letters.slice(1)) {
    const digit = soundexDigit(letter);
    if (!digit) {
      previous = '';
    } else if (digit !== previous) {
      digits += digit;
      previous = digit;
    }
  }
  return `${first}${digits}000`.slice(0, 4);
}

function soundexDigit(letter: string): string {
  if ('BFPV'.includes(letter)) return '1';
  if ('CGJKQSXZ'.includes(letter)) return '2';
  if ('DT'.includes(letter)) return '3';
  if (letter === 'L') return '4';
  if ('MN'.includes(letter)) return '5';
  if (letter === 'R') return '6';
  return '';
}
