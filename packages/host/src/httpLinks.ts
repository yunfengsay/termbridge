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

/** Normalize an explicit `file://` URI or local path into a safe session-file target. */
export function safeSessionFileTarget(value: string): string | undefined {
  if (!value || value.length > 4_096) return undefined;
  const trimmed = value.trim();
  if (!trimmed || /[\x00-\x1f\x7f\\]/.test(trimmed)) return undefined;
  if (/^file:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'file:') return undefined;
      if (parsed.hostname && parsed.hostname.toLowerCase() !== 'localhost') return undefined;
      const decoded = decodeURIComponent(parsed.pathname);
      if (!decoded || decoded.startsWith('//') || /[\x00-\x1f\x7f\\]/.test(decoded)) return undefined;
      return decoded;
    } catch {
      return undefined;
    }
  }
  if (trimmed.startsWith('//') || trimmed.startsWith('#')) return undefined;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) return undefined;
  return trimmed;
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
