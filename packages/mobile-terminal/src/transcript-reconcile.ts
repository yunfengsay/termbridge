const FOLLOW_BOTTOM_THRESHOLD_PX = 48;

interface ScrollAnchor {
  node: HTMLElement;
  viewportOffset: number;
}

/** Reveal a new transcript before measuring it so the first snapshot can follow the real bottom. */
export function activateTranscriptSnapshot(
  host: HTMLElement,
  transcript: HTMLElement,
  candidates: readonly HTMLElement[],
): void {
  host.classList.add('mobile-reading');
  updateTranscriptLines(transcript, candidates);
}

/**
 * Apply a fresh terminal snapshot without replacing the whole transcript DOM.
 *
 * Herdr mobile panes arrive as overlapping windows of recent output. Reusing
 * equal line nodes prevents Android WebView from briefly painting an empty
 * transcript, while a surviving visible node keeps manual scrolling stable as
 * old lines fall off the head of that window.
 */
export function updateTranscriptLines(
  transcript: HTMLElement,
  candidates: readonly HTMLElement[],
): void {
  const oldLines = Array.from(transcript.children) as HTMLElement[];
  const availableByKey = new Map<string, HTMLElement[]>();
  for (const line of oldLines) {
    const key = transcriptKey(line);
    const available = availableByKey.get(key);
    if (available) available.push(line);
    else availableByKey.set(key, [line]);
  }

  const retained = new Set<HTMLElement>();
  const desired = candidates.map((candidate) => {
    const available = availableByKey.get(transcriptKey(candidate));
    const existing = available?.shift();
    const line = existing ?? candidate;
    if (existing) retained.add(existing);
    return line;
  });
  reconcileTranscriptNodes(transcript, desired, oldLines, retained);
}

/** Apply an exact patch result whose retained node identities are authoritative. */
export function updateTranscriptNodes(
  transcript: HTMLElement,
  desired: readonly HTMLElement[],
): void {
  const oldLines = Array.from(transcript.children) as HTMLElement[];
  const oldSet = new Set(oldLines);
  const retained = new Set(desired.filter((line) => oldSet.has(line)));
  reconcileTranscriptNodes(transcript, desired, oldLines, retained);
}

function reconcileTranscriptNodes(
  transcript: HTMLElement,
  desired: readonly HTMLElement[],
  oldLines: readonly HTMLElement[],
  retained: ReadonlySet<HTMLElement>,
): void {
  const previousScrollTop = transcript.scrollTop;
  const distanceFromBottom = transcript.scrollHeight - previousScrollTop - transcript.clientHeight;
  const wasNearBottom = distanceFromBottom < FOLLOW_BOTTOM_THRESHOLD_PX;
  const anchors = visibleAnchors(oldLines, previousScrollTop);
  const followBottom = oldLines.length === 0 ||
    (wasNearBottom && isMonotonicTailUpdate(oldLines, desired, retained));

  // Remove expired lines first. For the common sliding-window update this
  // leaves the retained nodes in exactly the desired order, so only the new
  // tail needs inserting.
  for (const line of oldLines) {
    if (!retained.has(line)) line.remove();
  }
  for (let index = 0; index < desired.length; index += 1) {
    const current = transcript.children[index] as HTMLElement | undefined;
    if (current !== desired[index]) transcript.insertBefore(desired[index], current ?? null);
  }

  if (followBottom) {
    transcript.scrollTop = Math.max(0, transcript.scrollHeight - transcript.clientHeight);
    return;
  }

  const anchor = anchors.find(({ node }) => retained.has(node) && node.parentElement === transcript);
  const maxScrollTop = Math.max(0, transcript.scrollHeight - transcript.clientHeight);
  transcript.scrollTop = anchor
    ? clamp(anchor.node.offsetTop - anchor.viewportOffset, 0, maxScrollTop)
    : clamp(previousScrollTop, 0, maxScrollTop);
}

/**
 * A genuine stream update preserves a suffix of the old snapshot as the
 * prefix of the next one, then appends new output. A mutable Codex status line
 * instead replaces the old tail; snapping that replacement to the bottom
 * makes Android bounce whenever the line wraps to a different height.
 */
function isMonotonicTailUpdate(
  oldLines: readonly HTMLElement[],
  desired: readonly HTMLElement[],
  retained: ReadonlySet<HTMLElement>,
): boolean {
  const oldOverlapStart = oldLines.findIndex((line) => retained.has(line));
  if (oldOverlapStart < 0) return false;
  const overlap = oldLines.slice(oldOverlapStart);
  if (overlap.some((line) => !retained.has(line))) return false;
  if (desired.length < overlap.length) return false;
  return overlap.every((line, index) => desired[index] === line);
}

function transcriptKey(line: HTMLElement): string {
  return line.dataset.transcriptKey ?? line.textContent ?? "";
}

function visibleAnchors(lines: readonly HTMLElement[], scrollTop: number): ScrollAnchor[] {
  return lines
    .filter((line) => line.offsetTop + line.offsetHeight > scrollTop)
    .map((node) => ({ node, viewportOffset: node.offsetTop - scrollTop }));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
