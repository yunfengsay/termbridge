import { applyRevisionedTranscriptPatch, type TranscriptPatch } from './transcript-patch.js';
import { activateTranscriptSnapshot, updateTranscriptNodes } from './transcript-reconcile.js';
import {
  findFilePathLinks,
  looksLikeFilePath,
  safeExternalHttpUrl,
  safeSessionFilePath,
} from './external-links.js';

interface TranscriptSpan {
  text: string;
  style?: string;
  href?: string;
  file?: string;
}

interface TranscriptLine {
  spans: TranscriptSpan[];
}

interface SnapshotPayload {
  lines: TranscriptLine[];
}

type PatchPayload = TranscriptPatch<TranscriptLine>;

export interface MobileTranscriptController {
  readonly active: boolean;
  applySnapshot(revision: number, payloadBase64: string): void;
  applyPatch(baseRevision: number, revision: number, payloadBase64: string): void;
  reset(): void;
}

/** Owns the negotiated structured mobile transcript and revision recovery. */
export function createMobileTranscriptController(
  host: HTMLElement,
  transcript: HTMLElement,
  requestResync: (revision: number | undefined) => void,
  openExternalLink?: (href: string) => void,
  openFileLink?: (file: string) => void,
): MobileTranscriptController {
  let revision: number | undefined;
  let nodes: HTMLElement[] = [];
  let resyncRequested = false;

  const failClosed = (): void => {
    if (resyncRequested) return;
    resyncRequested = true;
    requestResync(revision);
  };

  return {
    get active(): boolean { return revision !== undefined; },

    applySnapshot(nextRevision, payloadBase64): void {
      const payload = decodePayload<SnapshotPayload>(payloadBase64);
      if (!validRevision(nextRevision) || !payload || !validLines(payload.lines)) {
        failClosed();
        return;
      }
      const linkedLines = linkWrappedUnderlinedFilePaths(payload.lines);
      const candidates = linkedLines.map((line) => createLineNode(line, openExternalLink, openFileLink));
      activateTranscriptSnapshot(host, transcript, candidates);
      nodes = Array.from(transcript.children) as HTMLElement[];
      revision = nextRevision;
      resyncRequested = false;
    },

    applyPatch(baseRevision, nextRevision, payloadBase64): void {
      if (!validRevision(nextRevision)) {
        failClosed();
        return;
      }
      const payload = decodePayload<PatchPayload>(payloadBase64);
      if (!payload || !validLines(payload.before) || !validLines(payload.after)) {
        failClosed();
        return;
      }
      const before = linkWrappedUnderlinedFilePaths(payload.before).map((line) =>
        createLineNode(line, openExternalLink, openFileLink),
      );
      const after = linkWrappedUnderlinedFilePaths(payload.after).map((line) =>
        createLineNode(line, openExternalLink, openFileLink),
      );
      const update = applyRevisionedTranscriptPatch(revision, nodes, baseRevision, nextRevision, {
        oldStart: payload.oldStart,
        newStart: payload.newStart,
        retainCount: payload.retainCount,
        before,
        after,
      });
      if (!update) {
        failClosed();
        return;
      }
      updateTranscriptNodes(transcript, update.lines);
      nodes = update.lines;
      revision = update.revision;
    },

    reset(): void {
      revision = undefined;
      nodes = [];
      resyncRequested = false;
      transcript.replaceChildren();
      host.classList.remove('mobile-reading');
    },
  };
}

/**
 * Reconstruct long file paths that Herdr/Codex/Claude wrapped across adjacent lines
 * with ANSI underline styling (works even when the Host is older and omits `span.file`).
 */
export function linkWrappedUnderlinedFilePaths(lines: readonly TranscriptLine[]): TranscriptLine[] {
  const cloned: TranscriptLine[] = lines.map((line) => ({
    spans: line.spans.map((span) => ({ ...span })),
  }));
  const isUnderlinedCandidate = (span: TranscriptSpan | undefined): boolean =>
    Boolean(span && !span.href && !span.file && span.style?.includes('text-decoration:underline') && span.text.length > 0);

  let lineIndex = 0;
  while (lineIndex < cloned.length) {
    const spans = cloned[lineIndex].spans;
    const lastIndex = spans.length - 1;
    if (lastIndex < 0 || !isUnderlinedCandidate(spans[lastIndex])) {
      lineIndex += 1;
      continue;
    }
    const run: Array<{ line: number; span: number }> = [{ line: lineIndex, span: lastIndex }];
    let joined = spans[lastIndex].text;
    let cursor = lineIndex + 1;
    while (cursor < cloned.length) {
      const nextSpans = cloned[cursor].spans;
      if (!nextSpans.length || !isUnderlinedCandidate(nextSpans[0])) break;
      run.push({ line: cursor, span: 0 });
      joined += nextSpans[0].text;
      // If this line has more spans after index 0, the wrapped underline ended on this line.
      if (nextSpans.length > 1) break;
      cursor += 1;
    }
    if (run.length > 1) {
      const candidate = joined.trim();
      const file = looksLikeFilePath(candidate) ? safeSessionFilePath(candidate) : undefined;
      if (file) {
        for (const ref of run) cloned[ref.line].spans[ref.span].file = file;
      }
      lineIndex = run[run.length - 1].line;
      // If the ending line has another underlined span at its tail, let the loop re-check that line.
      if (cloned[lineIndex].spans.length <= 1) lineIndex += 1;
    } else {
      lineIndex += 1;
    }
  }
  return cloned;
}

function createLineNode(
  line: TranscriptLine,
  openExternalLink?: (href: string) => void,
  openFileLink?: (file: string) => void,
): HTMLDivElement {
  const node = document.createElement('div');
  node.className = 'transcript-line';
  for (const segment of line.spans) {
    const href = segment.href && safeExternalHttpUrl(segment.href);
    const file = !href && segment.file ? safeSessionFilePath(segment.file) : undefined;
    if (href) {
      node.appendChild(createLinkElement(segment.text, segment.style, href, () => openExternalLink?.(href)));
      continue;
    }
    if (file && openFileLink) {
      node.appendChild(createFileLinkElement(segment.text, segment.style, file, openFileLink));
      continue;
    }
    if (openFileLink) {
      const matches = findFilePathLinks(segment.text);
      if (matches.length > 0) {
        let cursor = 0;
        for (const match of matches) {
          if (match.start > cursor) {
            node.appendChild(createPlainSpan(segment.text.slice(cursor, match.start), segment.style));
          }
          node.appendChild(createFileLinkElement(match.text, segment.style, match.file, openFileLink));
          cursor = match.end;
        }
        if (cursor < segment.text.length) {
          node.appendChild(createPlainSpan(segment.text.slice(cursor), segment.style));
        }
        continue;
      }
    }
    node.appendChild(createPlainSpan(segment.text, segment.style));
  }
  node.dataset.transcriptKey = JSON.stringify(line.spans);
  return node;
}

function createPlainSpan(text: string, style?: string): HTMLSpanElement {
  const span = document.createElement('span');
  if (style) span.setAttribute('style', style);
  span.textContent = text;
  return span;
}

function createLinkElement(
  text: string,
  style: string | undefined,
  href: string,
  onClick: () => void,
): HTMLAnchorElement {
  const anchor = document.createElement('a');
  if (style) anchor.setAttribute('style', style);
  anchor.textContent = text;
  anchor.href = href;
  anchor.rel = 'noopener noreferrer';
  anchor.addEventListener('click', (event) => {
    event.preventDefault();
    onClick();
  });
  return anchor;
}

function createFileLinkElement(
  text: string,
  style: string | undefined,
  file: string,
  openFileLink: (file: string) => void,
): HTMLAnchorElement {
  const anchor = document.createElement('a');
  if (style) anchor.setAttribute('style', style);
  anchor.className = 'tb-file-link';
  anchor.textContent = text;
  anchor.href = '#';
  anchor.dataset.tbFile = file;
  anchor.addEventListener('click', (event) => {
    event.preventDefault();
    openFileLink(file);
  });
  return anchor;
}

function validRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validLines(value: unknown): value is TranscriptLine[] {
  if (!Array.isArray(value) || value.length > 2_000) return false;
  let characters = 0;
  for (const line of value) {
    if (!line || typeof line !== 'object' || !Array.isArray((line as TranscriptLine).spans)) return false;
    const spans = (line as TranscriptLine).spans;
    if (spans.length > 1_024) return false;
    for (const span of spans) {
      if (!span || typeof span.text !== 'string') return false;
      if (span.style !== undefined && (typeof span.style !== 'string' || span.style.length > 256)) return false;
      if (span.href !== undefined && (typeof span.href !== 'string' || !safeExternalHttpUrl(span.href))) return false;
      if (span.file !== undefined && (typeof span.file !== 'string' || !safeSessionFilePath(span.file))) return false;
      characters += span.text.length;
      if (characters > 1_000_000) return false;
    }
  }
  return true;
}

function decodePayload<T>(base64: string): T | undefined {
  if (!base64 || base64.length > 2_000_000) return undefined;
  try {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return undefined;
  }
}
