import { applyRevisionedTranscriptPatch, type TranscriptPatch } from './transcript-patch.js';
import { activateTranscriptSnapshot, updateTranscriptNodes } from './transcript-reconcile.js';
import { safeExternalHttpUrl } from './external-links.js';

interface TranscriptSpan {
  text: string;
  style?: string;
  href?: string;
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
      const candidates = payload.lines.map((line) => createLineNode(line, openExternalLink));
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
      const before = payload.before.map((line) => createLineNode(line, openExternalLink));
      const after = payload.after.map((line) => createLineNode(line, openExternalLink));
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

function createLineNode(
  line: TranscriptLine,
  openExternalLink?: (href: string) => void,
): HTMLDivElement {
  const node = document.createElement('div');
  node.className = 'transcript-line';
  for (const segment of line.spans) {
    const href = segment.href && safeExternalHttpUrl(segment.href);
    const span = href ? document.createElement('a') : document.createElement('span');
    if (segment.style) span.setAttribute('style', segment.style);
    span.textContent = segment.text;
    if (href && span instanceof HTMLAnchorElement) {
      span.href = href;
      span.rel = 'noopener noreferrer';
      span.addEventListener('click', (event) => {
        event.preventDefault();
        openExternalLink?.(href);
      });
    }
    node.appendChild(span);
  }
  node.dataset.transcriptKey = JSON.stringify(line.spans);
  return node;
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
