/**
 * Deterministic, XSS-safe Markdown -> Tiptap JSONContent converter.
 *
 * Uses `marked.lexer` (GFM) to tokenize untrusted Markdown files and produces
 * a strict ProseMirror/Tiptap JSON document without ever feeding raw HTML
 * strings into DOM parsing. Supports:
 * - YAML frontmatter metadata strips
 * - Headings with stable anchor slugs
 * - GFM tables (with column alignment), task lists, strikethrough, fenced code
 * - GFM Callout/Alert blocks (`> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION]`)
 * - Antigravity `carousel` fenced blocks (`<!-- slide -->` separators)
 * - Safe image URL rewriting to `tb-md-asset://asset?path=...` for remote Host reads
 */

import { marked, type Token, type Tokens } from 'marked';
import type { JSONContent } from '@tiptap/core';

export type CalloutKind = 'note' | 'tip' | 'important' | 'warning' | 'caution';

export interface FrontmatterEntry {
  key: string;
  value: string;
}

export interface CarouselSlideData {
  /** Parsed Tiptap block nodes for rich slides (code, text, lists, etc.). */
  blocks: JSONContent[];
  /** Extracted single-image slide fast-path for clean gallery display. */
  image?: {
    src: string;
    rawSrc: string;
    alt: string;
    title: string;
  };
}

export interface MarkdownDocumentResult {
  doc: JSONContent;
  stats: {
    headingCount: number;
    imageCount: number;
    carouselCount: number;
  };
}

interface BuildContext {
  slugCounts: Map<string, number>;
  headingCount: number;
  imageCount: number;
  carouselCount: number;
}

const CALLOUT_HEADER_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]*\n|[ \t]+|$)/i;
const SLIDE_SEPARATOR_RE = /^[ \t]*<!--[ \t]*slide[ \t]*-->[ \t]*$/im;
const HTML_COMMENT_ONLY_RE = /^<!--[\s\S]*?-->$/;
const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|jpg|gif|webp|avif|bmp|svg\+xml);base64,[a-z0-9+/=\s]+$/i;
const DANGEROUS_SCHEME_RE = /^(?:javascript|vbscript|data|blob|about|file):/i;
const FILE_URL_RE = /^file:\/\/(?:localhost)?(\/.*)$/i;
const IMG_TAG_RE = /^<img\b([^>]*?)\/?>$/i;
const BR_TAG_RE = /^<br\s*\/?>$/i;

export const ASSET_SCHEME_PREFIX = 'tb-md-asset://asset?path=';

/**
 * Rewrite an image source from Markdown into a safe URL for our locked-down WKWebView.
 * Local/relative/file paths become `tb-md-asset://asset?path=...` so Swift fetches
 * bytes over the connected Host's `session_file_read` channel.
 */
export function rewriteImageSrc(raw: string): string | undefined {
  const value = raw.trim();
  if (!value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return undefined;
  if (/^https:\/\//i.test(value)) return value;
  if (SAFE_DATA_IMAGE_RE.test(value)) return value;

  const fileMatch = FILE_URL_RE.exec(value);
  if (fileMatch) {
    const decoded = safeDecodeURIComponent(fileMatch[1]!);
    if (!decoded || /[\x00-\x1f\x7f]/.test(decoded)) return undefined;
    return `${ASSET_SCHEME_PREFIX}${encodeURIComponent(decoded)}`;
  }

  // Reject other explicit schemes (http:, javascript:, data:text/html, ssh:, etc.)
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) return undefined;

  // Strip surrounding angle brackets sometimes used in Markdown image destinations: `![a](<path with space.png>)`
  const unwrapped = value.startsWith('<') && value.endsWith('>') ? value.slice(1, -1).trim() : value;
  if (!unwrapped || unwrapped.startsWith('//')) return undefined;
  return `${ASSET_SCHEME_PREFIX}${encodeURIComponent(unwrapped)}`;
}

/** Validate a hyperlink href before attaching a Tiptap Link mark. */
export function sanitizeLinkHref(raw: string): string | undefined {
  const value = raw.trim();
  if (!value || value.length > 4096 || /[\x00-\x1f\x7f\\]/.test(value)) return undefined;
  if (value.startsWith('#')) return value;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(value)) return value;
  if (FILE_URL_RE.test(value)) return value;
  if (value.startsWith('//')) return undefined;
  if (DANGEROUS_SCHEME_RE.test(value)) return undefined;
  // Reject unknown URI schemes while allowing Windows-free relative/absolute paths with `:line` suffixes.
  const withoutLine = value.replace(/(?::\d+(?::\d+)?(?:-\d+(?::\d+)?)?|#L?\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/i, '');
  if (/^[a-z][a-z\d+.-]*:/i.test(withoutLine)) return undefined;
  return value;
}

function safeDecodeURIComponent(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

export function slugifyHeading(text: string, counts: Map<string, number>): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]+/gu, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';
  const seen = counts.get(base) ?? 0;
  counts.set(base, seen + 1);
  return seen === 0 ? base : `${base}-${seen + 1}`;
}

/**
 * Extract simple YAML frontmatter at byte 0 (`---\nkey: value\n---`).
 * Returns extracted entries and the remaining Markdown body.
 */
export function extractFrontmatter(source: string): { entries: FrontmatterEntry[]; body: string } {
  const normalized = source.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { entries: [], body: normalized };
  const closeIdx = normalized.indexOf('\n---', 4);
  if (closeIdx === -1) return { entries: [], body: normalized };
  const afterClose = closeIdx + 4;
  if (afterClose < normalized.length && normalized[afterClose] !== '\n') {
    return { entries: [], body: normalized };
  }
  const block = normalized.slice(4, closeIdx);
  const lines = block.split('\n');
  if (lines.length === 0 || lines.length > 40) return { entries: [], body: normalized };

  const entries: FrontmatterEntry[] = [];
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(trimmed);
    if (!match) {
      // Allow indented YAML list items appended to the previous key.
      if (/^-\s+/.test(trimmed) && entries.length > 0) {
        const item = trimmed.replace(/^-\s+/, '').replace(/^['"]|['"]$/g, '');
        const last = entries[entries.length - 1]!;
        last.value = last.value ? `${last.value}, ${item}` : item;
        continue;
      }
      return { entries: [], body: normalized };
    }
    const key = match[1]!;
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else if (value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
        .join(', ');
    }
    entries.push({ key, value });
  }
  if (entries.length === 0) return { entries: [], body: normalized };
  const body = normalized.slice(afterClose).replace(/^\n+/, '');
  return { entries, body };
}

export function markdownToTiptapDocument(source: string): MarkdownDocumentResult {
  const ctx: BuildContext = {
    slugCounts: new Map(),
    headingCount: 0,
    imageCount: 0,
    carouselCount: 0,
  };
  const { entries, body } = extractFrontmatter(source);
  const blocks: JSONContent[] = [];

  if (entries.length > 0) {
    blocks.push({
      type: 'frontmatter',
      attrs: { entries },
    });
  }

  const tokens = marked.lexer(body, { gfm: true, breaks: false });
  blocks.push(...tokensToBlocks(tokens, ctx));

  if (blocks.length === 0) {
    blocks.push({ type: 'paragraph' });
  }

  return {
    doc: { type: 'doc', content: blocks },
    stats: {
      headingCount: ctx.headingCount,
      imageCount: ctx.imageCount,
      carouselCount: ctx.carouselCount,
    },
  };
}

function tokensToBlocks(tokens: readonly Token[], ctx: BuildContext): JSONContent[] {
  const out: JSONContent[] = [];
  for (const token of tokens) {
    const converted = tokenToBlocks(token, ctx);
    if (converted.length > 0) out.push(...converted);
  }
  return out;
}

function tokenToBlocks(token: Token, ctx: BuildContext): JSONContent[] {
  switch (token.type) {
    case 'space':
    case 'checkbox':
    case 'def':
      return [];

    case 'heading': {
      const node = token as Tokens.Heading;
      const level = Math.max(1, Math.min(6, node.depth));
      const content = tokensToInline(node.tokens ?? [], [], ctx);
      const plain = plainTextFromInline(content);
      const id = slugifyHeading(plain, ctx.slugCounts);
      ctx.headingCount += 1;
      return [{
        type: 'heading',
        attrs: { level, id },
        ...(content.length > 0 ? { content } : {}),
      }];
    }

    case 'paragraph': {
      const node = token as Tokens.Paragraph;
      const standalone = extractStandaloneImage(node.tokens ?? [], ctx);
      if (standalone) return [standalone];
      const content = tokensToInline(node.tokens ?? [], [], ctx);
      return content.length > 0 ? [{ type: 'paragraph', content }] : [];
    }

    case 'text': {
      const node = token as Tokens.Text;
      if (node.tokens?.length) {
        const standalone = extractStandaloneImage(node.tokens, ctx);
        if (standalone) return [standalone];
        const content = tokensToInline(node.tokens, [], ctx);
        return content.length > 0 ? [{ type: 'paragraph', content }] : [];
      }
      const text = decodeEntities(node.text);
      return text ? [{ type: 'paragraph', content: [{ type: 'text', text }] }] : [];
    }

    case 'code': {
      const node = token as Tokens.Code;
      const language = (node.lang ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
      if (language === 'carousel') {
        const carousel = buildCarouselNode(node.text, ctx);
        if (carousel) return [carousel];
      }
      return [{
        type: 'codeBlock',
        attrs: { language: language || null },
        ...(node.text.length > 0 ? { content: [{ type: 'text', text: node.text }] } : {}),
      }];
    }

    case 'blockquote': {
      const node = token as Tokens.Blockquote;
      const children = tokensToBlocks(node.tokens ?? [], ctx);
      const callout = maybePromoteToCallout(children);
      if (callout) return [callout];
      return [{
        type: 'blockquote',
        content: children.length > 0 ? children : [{ type: 'paragraph' }],
      }];
    }

    case 'list': {
      const node = token as Tokens.List;
      const isTaskList = node.items.some((item) => item.task);
      if (isTaskList) {
        const items: JSONContent[] = node.items.map((item) => {
          const itemBlocks = listItemBlocks(item, ctx);
          return {
            type: 'taskItem',
            attrs: { checked: item.checked === true },
            content: itemBlocks,
          };
        });
        return [{ type: 'taskList', content: items }];
      }

      const items: JSONContent[] = node.items.map((item) => ({
        type: 'listItem',
        content: listItemBlocks(item, ctx),
      }));

      if (node.ordered) {
        const start = typeof node.start === 'number' && Number.isFinite(node.start) ? node.start : 1;
        return [{ type: 'orderedList', attrs: { start }, content: items }];
      }
      return [{ type: 'bulletList', content: items }];
    }

    case 'table': {
      const node = token as Tokens.Table;
      const rows: JSONContent[] = [];

      const headerCells: JSONContent[] = node.header.map((cell, colIndex) => {
        const align = node.align[colIndex] ?? null;
        const inline = tokensToInline(cell.tokens ?? [], [], ctx);
        return {
          type: 'tableHeader',
          attrs: { colspan: 1, rowspan: 1, colwidth: null, align },
          content: [{ type: 'paragraph', ...(inline.length > 0 ? { content: inline } : {}) }],
        };
      });
      rows.push({ type: 'tableRow', content: headerCells });

      for (const row of node.rows) {
        const cells: JSONContent[] = row.map((cell, colIndex) => {
          const align = node.align[colIndex] ?? null;
          const inline = tokensToInline(cell.tokens ?? [], [], ctx);
          return {
            type: 'tableCell',
            attrs: { colspan: 1, rowspan: 1, colwidth: null, align },
            content: [{ type: 'paragraph', ...(inline.length > 0 ? { content: inline } : {}) }],
          };
        });
        rows.push({ type: 'tableRow', content: cells });
      }
      return [{ type: 'table', content: rows }];
    }

    case 'hr':
      return [{ type: 'horizontalRule' }];

    case 'html': {
      const raw = (token as Tokens.HTML).raw.trim();
      if (!raw || HTML_COMMENT_ONLY_RE.test(raw)) return [];
      const img = parseBenignImgTag(raw, ctx);
      if (img) return [img];
      // Never execute untrusted raw HTML; show literal text for transparency.
      return [{ type: 'paragraph', content: [{ type: 'text', text: raw }] }];
    }

    default: {
      const raw = (token as { raw?: string }).raw ?? '';
      return raw.trim() ? [{ type: 'paragraph', content: [{ type: 'text', text: raw }] }] : [];
    }
  }
}

function listItemBlocks(item: Tokens.ListItem, ctx: BuildContext): JSONContent[] {
  const blocks = tokensToBlocks(item.tokens ?? [], ctx);
  if (blocks.length === 0) return [{ type: 'paragraph' }];
  // ProseMirror listItem/taskItem content expects `paragraph block*` — guarantee first child is a paragraph.
  if (blocks[0]!.type !== 'paragraph') {
    return [{ type: 'paragraph' }, ...blocks];
  }
  return blocks;
}

function maybePromoteToCallout(children: JSONContent[]): JSONContent | undefined {
  if (children.length === 0) return undefined;
  const first = children[0]!;
  if (first.type !== 'paragraph' || !first.content?.length) return undefined;
  const firstInline = first.content[0]!;
  if (firstInline.type !== 'text' || typeof firstInline.text !== 'string') return undefined;
  const match = CALLOUT_HEADER_RE.exec(firstInline.text);
  if (!match) return undefined;

  const kind = match[1]!.toLowerCase() as CalloutKind;
  const remainder = firstInline.text.slice(match[0]!.length);
  const nextFirstInline = [...first.content];
  if (remainder.length > 0) {
    nextFirstInline[0] = { ...firstInline, text: remainder };
  } else {
    nextFirstInline.shift();
    if (nextFirstInline[0]?.type === 'hardBreak') nextFirstInline.shift();
  }

  const nextChildren = [...children];
  if (nextFirstInline.length > 0) {
    nextChildren[0] = { ...first, content: nextFirstInline };
  } else {
    nextChildren.shift();
  }

  return {
    type: 'callout',
    attrs: { kind },
    content: nextChildren.length > 0 ? nextChildren : [{ type: 'paragraph' }],
  };
}

function buildCarouselNode(rawContent: string, ctx: BuildContext): JSONContent | undefined {
  const parts = rawContent
    .replace(/\r\n/g, '\n')
    .split(SLIDE_SEPARATOR_RE)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;

  const slides: CarouselSlideData[] = parts.map((part) => {
    const slideTokens = marked.lexer(part, { gfm: true, breaks: false });
    const blocks = tokensToBlocks(slideTokens, ctx);
    if (blocks.length === 1 && blocks[0]!.type === 'figureImage' && blocks[0]!.attrs) {
      const attrs = blocks[0]!.attrs as { src: string; rawSrc?: string; alt?: string; title?: string };
      return {
        blocks,
        image: {
          src: attrs.src,
          rawSrc: attrs.rawSrc ?? attrs.src,
          alt: attrs.alt ?? '',
          title: attrs.title ?? '',
        },
      };
    }
    return {
      blocks: blocks.length > 0 ? blocks : [{ type: 'paragraph' }],
    };
  });

  ctx.carouselCount += 1;
  return {
    type: 'carousel',
    attrs: { slides },
  };
}

/**
 * Detect a paragraph whose only meaningful child is a single image (or linked image),
 * promoting it to a full-width `figureImage` block node.
 */
function extractStandaloneImage(tokens: readonly Token[], ctx: BuildContext): JSONContent | undefined {
  const meaningful = tokens.filter((t) => !(t.type === 'text' && !(t as Tokens.Text).text.trim()));
  if (meaningful.length !== 1) return undefined;
  const only = meaningful[0]!;

  if (only.type === 'image') {
    const img = only as Tokens.Image;
    const src = rewriteImageSrc(img.href);
    if (!src) return undefined;
    ctx.imageCount += 1;
    return {
      type: 'figureImage',
      attrs: {
        src,
        rawSrc: img.href.trim(),
        alt: decodeEntities(img.text ?? ''),
        title: decodeEntities(img.title ?? ''),
        href: null,
      },
    };
  }

  if (only.type === 'link') {
    const link = only as Tokens.Link;
    const inner = (link.tokens ?? []).filter((t) => !(t.type === 'text' && !(t as Tokens.Text).text.trim()));
    if (inner.length === 1 && inner[0]!.type === 'image') {
      const img = inner[0] as Tokens.Image;
      const src = rewriteImageSrc(img.href);
      if (!src) return undefined;
      ctx.imageCount += 1;
      return {
        type: 'figureImage',
        attrs: {
          src,
          rawSrc: img.href.trim(),
          alt: decodeEntities(img.text ?? ''),
          title: decodeEntities(img.title ?? ''),
          href: sanitizeLinkHref(link.href) ?? null,
        },
      };
    }
  }

  if (only.type === 'html') {
    return parseBenignImgTag((only as Tokens.HTML).raw.trim(), ctx);
  }
  return undefined;
}

function parseBenignImgTag(raw: string, ctx: BuildContext): JSONContent | undefined {
  const match = IMG_TAG_RE.exec(raw);
  if (!match) return undefined;
  const attrsStr = match[1] ?? '';
  const srcRaw = extractHtmlAttr(attrsStr, 'src');
  if (!srcRaw) return undefined;
  const src = rewriteImageSrc(srcRaw);
  if (!src) return undefined;
  ctx.imageCount += 1;
  return {
    type: 'figureImage',
    attrs: {
      src,
      rawSrc: srcRaw.trim(),
      alt: decodeEntities(extractHtmlAttr(attrsStr, 'alt') ?? ''),
      title: decodeEntities(extractHtmlAttr(attrsStr, 'title') ?? ''),
      href: null,
    },
  };
}

function extractHtmlAttr(attrsStr: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const match = re.exec(attrsStr);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

interface MarkSpec {
  type: string;
  attrs?: Record<string, unknown>;
}

function tokensToInline(tokens: readonly Token[], marks: readonly MarkSpec[], ctx: BuildContext): JSONContent[] {
  const out: JSONContent[] = [];

  const pushText = (text: string, activeMarks: readonly MarkSpec[]): void => {
    if (!text) return;
    const prev = out[out.length - 1];
    if (prev?.type === 'text' && marksEqual(prev.marks, activeMarks)) {
      prev.text = (prev.text ?? '') + text;
      return;
    }
    out.push({
      type: 'text',
      text,
      ...(activeMarks.length > 0 ? { marks: activeMarks.map((m) => (m.attrs ? { type: m.type, attrs: m.attrs } : { type: m.type })) } : {}),
    });
  };

  for (const token of tokens) {
    switch (token.type) {
      case 'text': {
        const node = token as Tokens.Text;
        if (node.tokens?.length) {
          out.push(...tokensToInline(node.tokens, marks, ctx));
        } else {
          pushText(decodeEntities(node.text), marks);
        }
        break;
      }

      case 'escape':
        pushText((token as Tokens.Escape).text, marks);
        break;

      case 'codespan': {
        const node = token as Tokens.Codespan;
        const inner = /^(`+)([\s\S]*?)\1$/.exec(node.raw);
        const text = inner ? inner[2]! : decodeEntities(node.text);
        pushText(text, addMark(marks, { type: 'code' }));
        break;
      }

      case 'strong':
        out.push(...tokensToInline((token as Tokens.Strong).tokens ?? [], addMark(marks, { type: 'bold' }), ctx));
        break;

      case 'em':
        out.push(...tokensToInline((token as Tokens.Em).tokens ?? [], addMark(marks, { type: 'italic' }), ctx));
        break;

      case 'del':
        out.push(...tokensToInline((token as Tokens.Del).tokens ?? [], addMark(marks, { type: 'strike' }), ctx));
        break;

      case 'br':
        out.push({ type: 'hardBreak' });
        break;

      case 'checkbox':
        break;

      case 'link': {
        const node = token as Tokens.Link;
        const safeHref = sanitizeLinkHref(node.href);
        const nextMarks = safeHref
          ? addMark(marks, { type: 'link', attrs: { href: safeHref, target: null, rel: 'noopener noreferrer' } })
          : marks;
        const children = tokensToInline(node.tokens ?? [], nextMarks, ctx);
        if (children.length > 0) {
          out.push(...children);
        } else if (node.href) {
          pushText(node.href, nextMarks);
        }
        break;
      }

      case 'image': {
        const node = token as Tokens.Image;
        const src = rewriteImageSrc(node.href);
        if (src) {
          ctx.imageCount += 1;
          out.push({
            type: 'image',
            attrs: {
              src,
              alt: decodeEntities(node.text ?? ''),
              title: decodeEntities(node.title ?? '') || null,
            },
          });
        } else {
          pushText(decodeEntities(node.text || node.title || node.href), marks);
        }
        break;
      }

      case 'html': {
        const raw = (token as Tokens.HTML).raw;
        const trimmed = raw.trim();
        if (BR_TAG_RE.test(trimmed)) {
          out.push({ type: 'hardBreak' });
        } else if (HTML_COMMENT_ONLY_RE.test(trimmed)) {
          // Ignore inline HTML comments cleanly.
        } else {
          pushText(raw, marks);
        }
        break;
      }

      default: {
        const raw = (token as { raw?: string }).raw ?? '';
        if (raw) pushText(decodeEntities(raw), marks);
        break;
      }
    }
  }

  return out;
}

function addMark(marks: readonly MarkSpec[], mark: MarkSpec): MarkSpec[] {
  if (marks.some((existing) => existing.type === mark.type)) return [...marks];
  return [...marks, mark];
}

function marksEqual(a: JSONContent['marks'], b: readonly MarkSpec[]): boolean {
  const left = a ?? [];
  if (left.length !== b.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i]!.type !== b[i]!.type) return false;
    if (JSON.stringify(left[i]!.attrs ?? null) !== JSON.stringify(b[i]!.attrs ?? null)) return false;
  }
  return true;
}

function plainTextFromInline(nodes: readonly JSONContent[]): string {
  return nodes
    .map((node) => {
      if (node.type === 'text') return node.text ?? '';
      if (node.type === 'hardBreak') return ' ';
      return '';
    })
    .join('');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
