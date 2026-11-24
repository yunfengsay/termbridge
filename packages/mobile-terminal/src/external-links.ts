export interface ExternalHttpLink {
  text: string;
  href: string;
  start: number;
  end: number;
}

export interface FilePathLink {
  text: string;
  file: string;
  start: number;
  end: number;
}

const WEB_URL = /https?:\/\/[^\s<>"'`]+/giu;
// Matches ~/path, /abs/path, ./rel/path, ../rel/path, or dir/sub/file.ext (with optional :line[:col] or #Lline(-Lline)).
const FILE_PATH_TOKEN = /(?:(?:~\/|\.{1,2}\/|\/)(?:[A-Za-z0-9._+-]+\/)*|(?:[A-Za-z0-9._+-]+\/)+)[A-Za-z0-9._+-]+(?::\d+(?::\d+)?|#L\d+(?:-L\d+)?)?/gu;
const KNOWN_FILE_EXTENSION = /\.(?:png|jpe?g|webp|gif|bmp|svg|pdf|md|markdown|txt|log|json|ya?ml|toml|xml|html?|css|scss|less|ts|tsx|js|jsx|mjs|cjs|kt|kts|java|swift|m|mm|h|hpp|c|cc|cpp|rs|go|py|rb|sh|zsh|bash|gradle|plist|ini|conf|cfg|sql|csv|apk|ipa|dmg|zip|tar|gz|lock|env|proto|d2|wgsl|metal|glsl)$/i;
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

/**
 * Normalize an explicit OSC-8 `file://` URI or Host file path into a safe path string
 * suitable for Host `session_file_read`. Rejects non-file URI schemes, control chars, and backslashes.
 */
export function safeSessionFilePath(value: string): string | undefined {
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
  // Reject protocol-relative paths and other URI schemes (http:, javascript:, data:, content:, intent:, etc.).
  if (trimmed.startsWith('//') || trimmed.startsWith('#')) return undefined;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) return undefined;
  return trimmed;
}

/** Whether a string looks like a clickable file path (used for wrapped-span and bare-text detection). */
export function looksLikeFilePath(value: string): boolean {
  const safe = safeSessionFilePath(value);
  if (!safe) return false;
  const clean = safe.replace(/(?::\d+(?::\d+)?|#L\d+(?:-L\d+)?)$/u, '');
  if (!clean.includes('/')) return false;
  if (clean.endsWith('/')) return false;
  if (clean.startsWith('~/') || clean.startsWith('./') || clean.startsWith('../')) {
    return KNOWN_FILE_EXTENSION.test(clean) || clean.split('/').filter(Boolean).length >= 2;
  }
  if (clean.startsWith('/')) {
    return KNOWN_FILE_EXTENSION.test(clean) && clean.split('/').filter(Boolean).length >= 2;
  }
  return KNOWN_FILE_EXTENSION.test(clean);
}

export function findExternalHttpLinks(text: string): ExternalHttpLink[] {
  const links: ExternalHttpLink[] = [];
  for (const match of text.matchAll(WEB_URL)) {
    const start = match.index ?? 0;
    let candidate = match[0];
    while (candidate && shouldTrimLastCharacter(candidate)) candidate = candidate.slice(0, -1);
    const href = safeExternalHttpUrl(candidate);
    if (!href) continue;
    links.push({ text: candidate, href, start, end: start + candidate.length });
  }
  return links;
}

export function findFilePathLinks(text: string): FilePathLink[] {
  const httpRanges = findExternalHttpLinks(text);
  const links: FilePathLink[] = [];
  for (const match of text.matchAll(FILE_PATH_TOKEN)) {
    const start = match.index ?? 0;
    let candidate = match[0];
    while (candidate && shouldTrimLastCharacter(candidate)) candidate = candidate.slice(0, -1);
    const end = start + candidate.length;
    if (!candidate) continue;
    if (start > 0 && /[A-Za-z0-9_@:]/.test(text[start - 1])) continue;
    if (httpRanges.some((range) => start < range.end && range.start < end)) continue;
    if (!looksLikeFilePath(candidate)) continue;
    const file = safeSessionFilePath(candidate);
    if (!file) continue;
    links.push({ text: candidate, file, start, end });
  }
  return links;
}

function shouldTrimLastCharacter(value: string): boolean {
  const last = value.at(-1);
  if (!last) return false;
  if (SIMPLE_TRAILING_PUNCTUATION.test(last)) return true;
  const opening = CLOSING_TO_OPENING[last];
  if (!opening) return false;
  return occurrences(value, last) > occurrences(value, opening);
}

function occurrences(value: string, character: string): number {
  return value.split(character).length - 1;
}
