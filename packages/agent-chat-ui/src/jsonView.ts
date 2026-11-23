/**
 * Pretty-prints and highlights a tool's arguments.
 *
 * Tool input arrives as an already-bounded preview string, usually JSON. Shown
 * raw it is a wall of braces; shown as markup it would be an injection point.
 * So it is parsed, re-emitted as a token list, and the renderer builds one
 * element per token with the text in `textContent`.
 *
 * Anything that is not valid JSON stays exactly as it arrived, in a plain code
 * block. Guessing at broken input would misrepresent what the Agent actually
 * sent.
 */

export type JsonToken =
  | { type: 'key'; text: string }
  | { type: 'string'; text: string }
  | { type: 'number'; text: string }
  | { type: 'boolean'; text: string }
  | { type: 'null'; text: string }
  | { type: 'punct'; text: string };

export interface JsonRender {
  /** Tokens to draw, or undefined when the input was not JSON. */
  tokens?: JsonToken[];
  /** The exact characters to put on the clipboard. Always the original. */
  copyText: string;
}

const INDENT = '  ';

export function renderJson(source: string): JsonRender {
  const trimmed = source.trim();
  if (!trimmed || !/^[[{]/.test(trimmed)) return { copyText: source };
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    // Not JSON after all: the raw preview is what gets shown.
    return { copyText: source };
  }
  const tokens: JsonToken[] = [];
  write(tokens, value, 0);
  return { tokens, copyText: source };
}

function write(out: JsonToken[], value: unknown, depth: number): void {
  if (value === null) { out.push({ type: 'null', text: 'null' }); return; }
  if (typeof value === 'string') { out.push({ type: 'string', text: JSON.stringify(value) }); return; }
  if (typeof value === 'number') { out.push({ type: 'number', text: String(value) }); return; }
  if (typeof value === 'boolean') { out.push({ type: 'boolean', text: String(value) }); return; }
  if (Array.isArray(value)) {
    if (!value.length) { out.push({ type: 'punct', text: '[]' }); return; }
    out.push({ type: 'punct', text: '[\n' });
    value.forEach((entry, index) => {
      out.push({ type: 'punct', text: INDENT.repeat(depth + 1) });
      write(out, entry, depth + 1);
      out.push({ type: 'punct', text: index === value.length - 1 ? '\n' : ',\n' });
    });
    out.push({ type: 'punct', text: `${INDENT.repeat(depth)}]` });
    return;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) { out.push({ type: 'punct', text: '{}' }); return; }
    out.push({ type: 'punct', text: '{\n' });
    entries.forEach(([key, entry], index) => {
      out.push({ type: 'punct', text: INDENT.repeat(depth + 1) });
      out.push({ type: 'key', text: JSON.stringify(key) });
      out.push({ type: 'punct', text: ': ' });
      write(out, entry, depth + 1);
      out.push({ type: 'punct', text: index === entries.length - 1 ? '\n' : ',\n' });
    });
    out.push({ type: 'punct', text: `${INDENT.repeat(depth)}}` });
    return;
  }
  out.push({ type: 'string', text: String(value) });
}
