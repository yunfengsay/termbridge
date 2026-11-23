export interface HttpLinkRange {
  text: string;
  href: string;
  start: number;
  end: number;
}

const WEB_URL = /https?:\/\/[^\s<>"'`]+/giu;
const SIMPLE_TRAILING_PUNCTUATION = /[.,;:!?，。；：！？、]$/u;
const CLOSING_TO_OPENING: Record<string, string> = {
  ')': '(',
  ']': '[',
  '}': '{',
  '）': '（',
  '】': '【',
};

export function safeExternalHttpUrl(value: string): string | undefined {
  if (!value || value.length > 4_096) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    if (parsed.username || parsed.password || !parsed.hostname) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export function findExternalHttpLinks(text: string): HttpLinkRange[] {
  const links: HttpLinkRange[] = [];
  for (const match of text.matchAll(WEB_URL)) {
    const start = match.index ?? 0;
    let candidate = match[0];
    while (candidate && shouldTrimLastCharacter(candidate)) candidate = candidate.slice(0, -1);
    const href = safeExternalHttpUrl(candidate);
    if (href) links.push({ text: candidate, href, start, end: start + candidate.length });
  }
  return links;
}

function shouldTrimLastCharacter(value: string): boolean {
  const last = value.at(-1);
  if (!last) return false;
  if (SIMPLE_TRAILING_PUNCTUATION.test(last)) return true;
  const opening = CLOSING_TO_OPENING[last];
  return opening ? occurrences(value, last) > occurrences(value, opening) : false;
}

function occurrences(value: string, character: string): number {
  return value.split(character).length - 1;
}
