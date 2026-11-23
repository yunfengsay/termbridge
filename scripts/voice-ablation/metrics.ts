export function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export function errorRate(reference: string, actual: string): number {
  const a = [...normalize(reference)];
  const b = [...normalize(actual)];
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) {
      next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + Number(a[i] !== b[j])));
    }
    row = next;
  }
  return row[b.length] / Math.max(1, a.length);
}

export function score(reference: string, text: string, expected: string[], forbidden: string[]) {
  const normalized = normalize(text);
  return {
    characterErrorRate: errorRate(reference, text),
    missingTerms: expected.filter(term => !normalized.includes(normalize(term))),
    inventedTerms: forbidden.filter(term => normalized.includes(normalize(term))),
  };
}
