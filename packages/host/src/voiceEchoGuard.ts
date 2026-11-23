const DEFAULT_ECHO_WINDOW_MS = 30_000;
const MIN_FRAGMENT_LENGTH = 5;
const SIMILARITY_THRESHOLD = 0.72;
const MAX_REFERENCE_LENGTH = 600;

interface EchoReference {
  text: string;
  at: number;
}

/** Rejects ASR fragments that are probably the phone replaying the Brain's own audio. */
export class VoiceEchoGuard {
  private current = '';
  private readonly history: EchoReference[] = [];

  constructor(private readonly windowMs = DEFAULT_ECHO_WINDOW_MS) {}

  startResponse(): void {
    this.current = '';
  }

  updateAssistant(text: string): void {
    this.current = normalizeEchoText(text).slice(-MAX_REFERENCE_LENGTH);
  }

  finishResponse(text: string, now = Date.now()): void {
    this.updateAssistant(text);
    if (this.current) this.history.push({ text: this.current, at: now });
    this.current = '';
    this.prune(now);
  }

  isLikelyEcho(transcript: string, now = Date.now()): boolean {
    const candidate = normalizeEchoText(transcript);
    if (candidate.length < MIN_FRAGMENT_LENGTH) return false;
    this.prune(now);
    return [this.current, ...this.history.map((item) => item.text)].some((reference) =>
      reference.includes(candidate) ||
      longestCommonSubstringLength(reference, candidate) / candidate.length >= SIMILARITY_THRESHOLD,
    );
  }

  private prune(now: number): void {
    while (this.history[0] && now - this.history[0].at > this.windowMs) this.history.shift();
  }
}

export function normalizeEchoText(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/[0-9零〇一二两三四五六七八九十百千万亿]+/gu, '#')
    .replace(/[^\p{L}\p{Script=Han}#]+/gu, '');
}

function longestCommonSubstringLength(left: string, right: string): number {
  if (!left || !right) return 0;
  let previous = new Uint16Array(right.length + 1);
  let longest = 0;
  for (let i = 1; i <= left.length; i += 1) {
    const current = new Uint16Array(right.length + 1);
    for (let j = 1; j <= right.length; j += 1) {
      if (left[i - 1] === right[j - 1]) {
        current[j] = previous[j - 1] + 1;
        if (current[j] > longest) longest = current[j];
      }
    }
    previous = current;
  }
  return longest;
}
