import { findExternalHttpLinks, safeExternalHttpUrl } from './external-links.js';

interface TerminalCell {
  getChars(): string;
  getWidth(): number;
}

interface TerminalLine {
  readonly length: number;
  getCell(column: number, cell?: TerminalCell): TerminalCell | undefined;
  translateToString(trimRight?: boolean): string;
}

interface LinkTerminal {
  readonly buffer: { readonly active: { getLine(line: number): TerminalLine | undefined } };
  registerLinkProvider(provider: {
    provideLinks(lineNumber: number, callback: (links: Array<{
      range: { start: { x: number; y: number }; end: { x: number; y: number } };
      text: string;
      activate(event: MouseEvent, text: string): void;
    }> | undefined) => void): void;
  }): { dispose(): void };
}

/** Add tap targets for plain http(s) text. OSC 8 links are handled by xterm itself. */
export function installBareHttpLinkProvider(
  terminal: LinkTerminal,
  openExternalLink: (href: string) => void,
): { dispose(): void } {
  return terminal.registerLinkProvider({
    provideLinks(lineNumber, callback): void {
      const line = terminal.buffer.active.getLine(lineNumber - 1);
      if (!line) return callback(undefined);
      const links = findExternalHttpLinks(line.translateToString(true)).map((link) => ({
        range: {
          start: { x: stringIndexToColumn(line, link.start) + 1, y: lineNumber },
          end: { x: stringIndexToColumn(line, link.end - 1) + 1, y: lineNumber },
        },
        text: link.text,
        activate: () => openExternalLink(link.href),
      }));
      callback(links.length ? links : undefined);
    },
  });
}

export function openSafeExternalLink(
  value: string,
  openExternalLink: (href: string) => void,
): void {
  const href = safeExternalHttpUrl(value);
  if (href) openExternalLink(href);
}

function stringIndexToColumn(line: TerminalLine, index: number): number {
  let stringOffset = 0;
  for (let column = 0; column < line.length; column += 1) {
    const cell = line.getCell(column);
    if (!cell || cell.getWidth() === 0) continue;
    const characters = cell.getChars() || ' ';
    if (stringOffset + characters.length > index) return column;
    stringOffset += characters.length;
  }
  return Math.max(0, line.length - 1);
}
