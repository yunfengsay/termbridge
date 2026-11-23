/**
 * Assistant prose, as a typed tree the renderer can build DOM from.
 *
 * Syntax comes from `marked` (MIT, no runtime dependencies), pinned so the
 * grammar cannot drift under us. This file is only the adapter: it walks
 * marked's token AST and produces the small node set the renderer knows how to
 * build. Nothing here ever emits markup, and the renderer puts Agent text only
 * in `textContent` — a transcript is untrusted input, so the parser gives us
 * structure and we build every element ourselves.
 *
 * Raw HTML in a transcript is therefore never executed: an `html` token becomes
 * literal text, which is what a user needs to see anyway when a model writes a
 * tag.
 */

import { marked, type Token, type Tokens } from 'marked';

export type MarkdownInline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: MarkdownInline[] }
  | { type: 'emphasis'; children: MarkdownInline[] }
  | { type: 'strike'; children: MarkdownInline[] }
  | { type: 'break' }
  | { type: 'link'; href: string; children: MarkdownInline[] };

export interface MarkdownListItem {
  children: MarkdownBlock[];
  /** Present only for a GFM task item, so an ordinary bullet stays a bullet. */
  checked?: boolean;
}

export type MarkdownBlock =
  | { type: 'paragraph'; children: MarkdownInline[] }
  | { type: 'heading'; level: number; children: MarkdownInline[] }
  | { type: 'code'; language?: string; text: string }
  | { type: 'list'; ordered: boolean; start: number; items: MarkdownListItem[] }
  | { type: 'table'; header: MarkdownInline[][]; rows: MarkdownInline[][][]; align: Array<'left' | 'center' | 'right' | null> }
  | { type: 'quote'; children: MarkdownBlock[] }
  | { type: 'rule' };

/**
 * Product-internal metadata elements that reach recorded text.
 *
 * Named exactly, never by prefix: a wildcard would delete `<claude-widget>` and
 * anything else that merely looks internal, and the rule is to leave an
 * unrecognised tag as the literal text the model wrote. Add a name here once it
 * has actually been observed.
 */
const METADATA_ELEMENTS = ['oai-mem-citation'];

/**
 * Removes whole metadata elements — opening tag, content and closing tag —
 * from the source, leaving every code region untouched.
 *
 * Content matters: the outer tag alone would leave `citation_entries` and
 * rollout ids sitting in the prose. Completeness matters too: a half-arrived
 * element during streaming stays literal until its closing tag shows up, so
 * text never flickers between hidden and visible.
 */
export function stripMetadataElements(source: string): string {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const region = codeRegionAt(source, index);
    if (region) {
      // Code is content. Nothing inside a fence or a code span is touched.
      out += source.slice(index, region.end);
      index = region.end;
      continue;
    }
    const removed = metadataElementAt(source, index);
    if (removed) { index = removed; continue; }
    out += source[index];
    index += 1;
  }
  return out;
}

/** @returns the end offset of a fenced block or code span starting here. */
function codeRegionAt(source: string, index: number): { end: number } | undefined {
  if (source[index] !== '`' && source[index] !== '~') return undefined;
  const atLineStart = index === 0 || source[index - 1] === '\n';
  const fence = atLineStart ? /^(`{3,}|~{3,})/.exec(source.slice(index)) : null;
  if (fence) {
    const marker = fence[1]!;
    const closing = source.indexOf(`\n${marker[0]!.repeat(marker.length)}`, index + marker.length);
    // An unclosed fence runs to the end, which is what a streaming one does.
    return { end: closing === -1 ? source.length : Math.min(source.length, closing + 1 + marker.length) };
  }
  if (source[index] !== '`') return undefined;
  const ticks = /^`+/.exec(source.slice(index))![0]!;
  const closing = source.indexOf(ticks, index + ticks.length);
  if (closing === -1) return undefined;
  return { end: closing + ticks.length };
}

/** @returns the offset just past a complete metadata element starting here. */
function metadataElementAt(source: string, index: number): number | undefined {
  if (source[index] !== '<') return undefined;
  for (const name of METADATA_ELEMENTS) {
    const open = new RegExp(`^<${name}(\\s[^<>]*?)?(/?)>`, 'i').exec(source.slice(index));
    if (!open) continue;
    if (open[2] === '/') return index + open[0]!.length;
    const closing = `</${name}>`;
    const end = source.toLowerCase().indexOf(closing, index + open[0]!.length);
    // Only a closed element is hidden; an unterminated one stays visible.
    if (end === -1) return undefined;
    return end + closing.length;
  }
  return undefined;
}

/** Only a scheme the shell will actually open becomes a link. */
export function isOpenableHref(href: string): boolean {
  const value = href.trim();
  if (!value || value.length > 4096 || /[\x00-\x1f\x7f\\]/.test(value) || value.startsWith('//')) return false;
  if (/^https?:\/\//i.test(value)) return /^https?:\/\/[^\s@/]+(?:[/?#][^\s]*)?$/i.test(value);
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('#')) return false;
  return /^(?:\.?\.?\/|~\/)/.test(value) || /\.(?:md|markdown|txt|png|jpe?g|webp|gif|bmp)(?:#.*)?$/i.test(value);
}

const lexer = (source: string): Token[] =>
  marked.lexer(source, { gfm: true, breaks: false });

export function parseMarkdown(source: string): MarkdownBlock[] {
  return blocksFrom(lexer(stripMetadataElements(source)));
}

function blocksFrom(tokens: readonly Token[]): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  for (const token of tokens) {
    const block = blockFrom(token);
    if (block) blocks.push(...block);
  }
  return blocks;
}

function blockFrom(token: Token): MarkdownBlock[] | undefined {
  switch (token.type) {
    case 'space':
    case 'checkbox':
      return undefined;
    case 'paragraph':
    case 'text': {
      const node = token as Tokens.Paragraph | Tokens.Text;
      const children = inlineFrom(node.tokens ?? [{ type: 'text', raw: node.raw, text: node.text } as Token]);
      return children.length ? [{ type: 'paragraph', children }] : undefined;
    }
    case 'heading': {
      const node = token as Tokens.Heading;
      return [{ type: 'heading', level: node.depth, children: inlineFrom(node.tokens ?? []) }];
    }
    case 'code': {
      const node = token as Tokens.Code;
      const language = (node.lang ?? '').split(/\s+/)[0] ?? '';
      return [{ type: 'code', text: node.text, ...(language ? { language } : {}) }];
    }
    case 'blockquote': {
      const node = token as Tokens.Blockquote;
      return [{ type: 'quote', children: blocksFrom(node.tokens ?? []) }];
    }
    case 'list': {
      const node = token as Tokens.List;
      return [{
        type: 'list',
        ordered: node.ordered,
        start: typeof node.start === 'number' && Number.isFinite(node.start) ? node.start : 1,
        items: node.items.map((item) => ({
          // Nested lists come through as child tokens, so depth is preserved
          // rather than flattened into the parent.
          children: blocksFrom(item.tokens ?? []),
          ...(item.task ? { checked: item.checked === true } : {}),
        })),
      }];
    }
    case 'table': {
      const node = token as Tokens.Table;
      return [{
        type: 'table',
        align: node.align.map((value) => value ?? null),
        header: node.header.map((cell) => inlineFrom(cell.tokens ?? [])),
        rows: node.rows.map((row) => row.map((cell) => inlineFrom(cell.tokens ?? []))),
      }];
    }
    case 'hr':
      return [{ type: 'rule' }];
    case 'html': {
      // Never executed, never dropped: the model wrote these characters and the
      // user is entitled to see them.
      const node = token as Tokens.HTML;
      const text = node.raw;
      return text.trim() ? [{ type: 'paragraph', children: [{ type: 'text', text }] }] : undefined;
    }
    default: {
      const raw = (token as { raw?: string }).raw ?? '';
      return raw.trim() ? [{ type: 'paragraph', children: [{ type: 'text', text: raw }] }] : undefined;
    }
  }
}

function inlineFrom(tokens: readonly Token[]): MarkdownInline[] {
  return coalesce(collectInline(tokens));
}

/**
 * Adjacent text runs become one node. Removing a citation marker splits a
 * sentence into two tokens, and leaving them separate means two elements where
 * the Agent wrote one phrase — which copies and reads worse for no reason.
 */
function coalesce(nodes: readonly MarkdownInline[]): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  for (const node of nodes) {
    const previous = out.at(-1);
    if (node.type === 'text' && previous?.type === 'text') out[out.length - 1] = { type: 'text', text: previous.text + node.text };
    else out.push(node);
  }
  return out;
}

function collectInline(tokens: readonly Token[]): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'text': {
        const node = token as Tokens.Text;
        // A `text` token can itself carry inline children (a table cell does).
        if (node.tokens?.length) { out.push(...collectInline(node.tokens)); break; }
        const text = decodeEntities(node.text);
        if (text) out.push({ type: 'text', text });
        break;
      }
      case 'escape': {
        const node = token as Tokens.Escape;
        out.push({ type: 'text', text: node.text });
        break;
      }
      case 'codespan': {
        // Read from the original source, not the escaped token text: marked maps
        // both a real `<` and a literal `&lt;` onto the same escaped form, so
        // decoding it would rewrite what the user copies.
        const node = token as Tokens.Codespan;
        const inner = /^(`+)([\s\S]*?)\1$/.exec(node.raw);
        out.push({ type: 'code', text: inner ? inner[2]! : decodeEntities(node.text) });
        break;
      }
      case 'strong':
        out.push({ type: 'strong', children: inlineFrom((token as Tokens.Strong).tokens ?? []) });
        break;
      case 'em':
        out.push({ type: 'emphasis', children: inlineFrom((token as Tokens.Em).tokens ?? []) });
        break;
      case 'del':
        out.push({ type: 'strike', children: inlineFrom((token as Tokens.Del).tokens ?? []) });
        break;
      case 'br':
        out.push({ type: 'break' });
        break;
      case 'checkbox':
        // Drawn from the item's own `checked` flag, not from its marker text.
        break;
      case 'link': {
        const node = token as Tokens.Link;
        const children = inlineFrom(node.tokens ?? []);
        const label = children.length ? children : [{ type: 'text', text: node.href } as MarkdownInline];
        // A label pointing somewhere the shell will not open keeps its words
        // instead of becoming a control that does nothing when tapped.
        if (isOpenableHref(node.href)) out.push({ type: 'link', href: node.href, children: label });
        else out.push(...label);
        break;
      }
      case 'image': {
        const node = token as Tokens.Image;
        const label = node.text || node.title || node.href;
        if (isOpenableHref(node.href)) out.push({ type: 'link', href: node.href, children: [{ type: 'text', text: label }] });
        else if (label) out.push({ type: 'text', text: label });
        break;
      }
      case 'html': {
        // An unrecognised tag is the literal text the model wrote, not markup.
        const text = (token as Tokens.HTML).raw;
        if (text) out.push({ type: 'text', text });
        break;
      }
      default: {
        const raw = (token as { raw?: string }).raw ?? '';
        if (raw) out.push({ type: 'text', text: decodeEntities(raw) });
        break;
      }
    }
  }
  return out;
}

/**
 * marked escapes prose for HTML output. We build DOM nodes instead, so the
 * entities have to come back or a user sees `&amp;` where the Agent wrote `&`.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** The plain reading of a parsed run, for previews and accessibility labels. */
export function inlineText(nodes: readonly MarkdownInline[]): string {
  return nodes
    .map((node) => {
      if (node.type === 'text' || node.type === 'code') return node.text;
      if (node.type === 'break') return '\n';
      return inlineText(node.children);
    })
    .join('');
}
