/**
 * Typed bridge messages between the macOS MarkdownPreviewView (Swift) and the
 * bundled Tiptap surface inside WKWebView.
 */

export type ThemeMode = 'light' | 'dark';

export type ShellMessage =
  | { op: 'render'; markdown: string; path?: string; theme?: ThemeMode }
  | { op: 'theme'; theme: ThemeMode }
  | { op: 'find'; query: string; caseSensitive?: boolean }
  | { op: 'findNext' }
  | { op: 'findPrevious' }
  | { op: 'clearFind' }
  | { op: 'clear' };

export type SurfaceMessage =
  | { op: 'ready' }
  | { op: 'open'; url: string }
  | { op: 'copy'; data: string }
  | { op: 'findResult'; index: number; total: number }
  | { op: 'rendered'; headingCount: number; imageCount: number; carouselCount: number };

export function readShellMessage(raw: unknown): ShellMessage | undefined {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  switch (obj.op) {
    case 'render':
      if (typeof obj.markdown !== 'string') return undefined;
      return {
        op: 'render',
        markdown: obj.markdown,
        ...(typeof obj.path === 'string' ? { path: obj.path } : {}),
        ...(obj.theme === 'light' || obj.theme === 'dark' ? { theme: obj.theme } : {}),
      };
    case 'theme':
      if (obj.theme !== 'light' && obj.theme !== 'dark') return undefined;
      return { op: 'theme', theme: obj.theme };
    case 'find':
      if (typeof obj.query !== 'string') return undefined;
      return {
        op: 'find',
        query: obj.query,
        caseSensitive: obj.caseSensitive === true,
      };
    case 'findNext':
      return { op: 'findNext' };
    case 'findPrevious':
      return { op: 'findPrevious' };
    case 'clearFind':
      return { op: 'clearFind' };
    case 'clear':
      return { op: 'clear' };
    default:
      return undefined;
  }
}
