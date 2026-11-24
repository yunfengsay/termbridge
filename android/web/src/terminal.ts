import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { createMobileTranscriptController } from '../../../packages/mobile-terminal/src/mobile-transcript';
import { updateTranscriptLines } from '../../../packages/mobile-terminal/src/transcript-reconcile';
import { installTouchWheelBridge } from '../../../packages/mobile-terminal/src/touch-scroll';
import { installBareHttpLinkProvider, openSafeExternalLink } from '../../../packages/mobile-terminal/src/terminal-links';

const MOBILE_REDRAW = '\x1b[3J\x1b[2J\x1b[H';

declare global {
  interface Window {
    TermbridgeNative?: {
      onReady(cols: number, rows: number): void;
      onResize(cols: number, rows: number): void;
      onTitle(title: string): void;
      onCopy(text: string): void;
      onBell(): void;
      onTranscriptResync(revision: number): void;
      onOpenLink(url: string): void;
      onOpenFile?(path: string): void;
      onInputMode(bracketedPaste: boolean): void;
    };
    Termbridge?: {
      writeBase64(base64: string): void;
      applyMobileSnapshot(revision: number, payloadBase64: string): void;
      applyMobilePatch(baseRevision: number, revision: number, payloadBase64: string): void;
      fit(): void;
      reset(): void;
      copySelection(): void;
    };
  }
}

const openExternalLink = (href: string): void => window.TermbridgeNative?.onOpenLink(href);
const openFileLink = (path: string): void => window.TermbridgeNative?.onOpenFile?.(path);

const terminal = new Terminal({
  allowProposedApi: false,
  convertEol: false,
  cursorBlink: false,
  cursorStyle: 'block',
  disableStdin: true,
  drawBoldTextInBrightColors: true,
  fontFamily: "'Roboto Mono', 'Noto Sans Mono CJK SC', monospace",
  fontSize: 14,
  fontWeight: '400',
  fontWeightBold: '700',
  letterSpacing: 0,
  lineHeight: 1.16,
  linkHandler: {
    activate: (_event, href) => openSafeExternalLink(href, openExternalLink, openFileLink),
  },
  minimumContrastRatio: 2.5,
  rightClickSelectsWord: true,
  scrollback: 10_000,
  // Touch momentum is driven by the shared kinetic scroller one frame at a time.
  smoothScrollDuration: 0,
  theme: {
    background: '#0D100E',
    foreground: '#DDE5DB',
    cursor: '#91C39A',
    cursorAccent: '#0D100E',
    selectionBackground: '#45624B99',
    selectionInactiveBackground: '#34473A88',
    black: '#151A16',
    red: '#E06C65',
    green: '#91C39A',
    yellow: '#D8B26E',
    blue: '#79A8D8',
    magenta: '#C792C7',
    cyan: '#76C7C0',
    white: '#DDE5DB',
    brightBlack: '#657066',
    brightRed: '#F08A82',
    brightGreen: '#B0D9B6',
    brightYellow: '#E8CA8C',
    brightBlue: '#9ABFE4',
    brightMagenta: '#D9A8D8',
    brightCyan: '#9BDCD5',
    brightWhite: '#F6FAF5',
  },
});

terminal.onWriteParsed(() => window.TermbridgeNative?.onInputMode(terminal.modes.bracketedPasteMode));

const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
installBareHttpLinkProvider(terminal, openExternalLink, openFileLink);

const host = document.getElementById('terminal');
if (!host) throw new Error('terminal mount is missing');
const transcript = document.getElementById('mobile-transcript');
if (!transcript) throw new Error('mobile transcript mount is missing');
terminal.open(host);
if (terminal.textarea) {
  terminal.textarea.disabled = true;
  terminal.textarea.tabIndex = -1;
}
const wheelTarget = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
if (!wheelTarget) throw new Error('terminal wheel target is missing');
if (!terminal.element) throw new Error('terminal element is missing');
installTouchWheelBridge(terminal.element, wheelTarget);
terminal.onResize(({ cols, rows }) => window.TermbridgeNative?.onResize(cols, rows));
terminal.onTitleChange((title) => window.TermbridgeNative?.onTitle(title));
terminal.onBell(() => window.TermbridgeNative?.onBell());

let resizeTimer: number | undefined;
let mobileReading = false;
let transcriptFrame: number | undefined;
let transcriptIdleTimer: number | undefined;
let transcriptScrolling = false;
let transcriptDirty = false;
let renderingTranscript = false;
const structuredTranscript = createMobileTranscriptController(host, transcript, (revision) => {
  window.TermbridgeNative?.onTranscriptResync(revision ?? -1);
}, openExternalLink, openFileLink);

const markTranscriptScrolling = (): void => {
  if (renderingTranscript) return;
  transcriptScrolling = true;
  window.clearTimeout(transcriptIdleTimer);
  transcriptIdleTimer = window.setTimeout(() => {
    transcriptScrolling = false;
    if (transcriptDirty) scheduleTranscriptRender();
  }, 180);
};

transcript.addEventListener('touchstart', markTranscriptScrolling, { passive: true });
transcript.addEventListener('scroll', markTranscriptScrolling, { passive: true });
function fit(): void {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    try {
      fitAddon.fit();
    } catch {
      // A transient zero-sized viewport while the Android keyboard animates.
    }
  }, 40);
}

new ResizeObserver(fit).observe(host);
window.visualViewport?.addEventListener('resize', fit);
window.addEventListener('resize', fit);

window.Termbridge = {
  writeBase64(base64: string): void {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const nextMode = binary.startsWith(MOBILE_REDRAW)
      ? true
      : binary.startsWith('\x1b[2J\x1b[H')
        ? false
        : mobileReading;
    if (nextMode !== mobileReading) {
      if (nextMode && structuredTranscript.active) structuredTranscript.reset();
      mobileReading = nextMode;
      host.classList.toggle('mobile-reading', mobileReading);
    }
    terminal.write(bytes, () => {
      if (mobileReading) scheduleTranscriptRender();
    });
  },
  applyMobileSnapshot(revision, payloadBase64): void {
    mobileReading = false;
    structuredTranscript.applySnapshot(revision, payloadBase64);
  },
  applyMobilePatch(baseRevision, revision, payloadBase64): void {
    structuredTranscript.applyPatch(baseRevision, revision, payloadBase64);
  },
  fit,
  reset(): void {
    mobileReading = false;
    structuredTranscript.reset();
    if (transcriptFrame !== undefined) cancelAnimationFrame(transcriptFrame);
    window.clearTimeout(transcriptIdleTimer);
    transcriptFrame = undefined;
    transcriptIdleTimer = undefined;
    transcriptScrolling = false;
    transcriptDirty = false;
    terminal.reset();
    terminal.clear();
  },
  copySelection(): void {
    const selection = terminal.getSelection();
    if (selection) window.TermbridgeNative?.onCopy(selection);
  },
};

function scheduleTranscriptRender(): void {
  transcriptDirty = true;
  if (transcriptScrolling) return;
  if (transcriptFrame !== undefined) return;
  transcriptFrame = requestAnimationFrame(() => {
    transcriptFrame = undefined;
    transcriptDirty = false;
    renderTranscript();
  });
}

function renderTranscript(): void {
  const buffer = terminal.buffer.active;
  const lines: HTMLDivElement[] = [];
  let logicalLine: HTMLDivElement | undefined;
  const cell = buffer.getNullCell();

  for (let row = 0; row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    if (!line.isWrapped || !logicalLine) {
      logicalLine = document.createElement('div');
      logicalLine.className = 'transcript-line';
      lines.push(logicalLine);
    }

    let activeSpan: HTMLSpanElement | undefined;
    let activeStyle = '';
    for (let column = 0; column < Math.min(line.length, terminal.cols); column += 1) {
      const current = line.getCell(column, cell);
      if (!current || current.getWidth() === 0) continue;
      const style = cellStyle(current);
      if (!activeSpan || style !== activeStyle) {
        activeSpan = document.createElement('span');
        if (style) activeSpan.setAttribute('style', style);
        logicalLine.appendChild(activeSpan);
        activeStyle = style;
      }
      activeSpan.append(document.createTextNode(current.getChars() || ' '));
    }
    trimTrailingSpaces(logicalLine);
  }

  for (const line of lines) line.dataset.transcriptKey = line.innerHTML;
  renderingTranscript = true;
  updateTranscriptLines(transcript, lines);
  renderingTranscript = false;
}

function trimTrailingSpaces(line: HTMLElement): void {
  let child = line.lastChild;
  while (child) {
    const text = child.textContent?.replace(/\s+$/, '') ?? '';
    child.textContent = text;
    if (text) break;
    const previous = child.previousSibling;
    child.remove();
    child = previous;
  }
}

function cellStyle(cell: import('@xterm/xterm').IBufferCell): string {
  let foreground = cell.isFgDefault() ? undefined : terminalColor(cell.getFgColor(), cell.isFgRGB());
  let background = cell.isBgDefault() ? undefined : terminalColor(cell.getBgColor(), cell.isBgRGB());
  if (cell.isInverse()) [foreground, background] = [background ?? '#0D100E', foreground ?? '#DDE5DB'];
  const styles: string[] = [];
  if (foreground) styles.push(`color:${foreground}`);
  if (background) styles.push(`background-color:${background}`);
  if (cell.isBold()) styles.push('font-weight:700');
  if (cell.isItalic()) styles.push('font-style:italic');
  if (cell.isDim()) styles.push('opacity:.68');
  if (cell.isUnderline()) styles.push('text-decoration:underline');
  if (cell.isStrikethrough()) styles.push('text-decoration:line-through');
  if (cell.isInvisible()) styles.push('visibility:hidden');
  return styles.join(';');
}

function terminalColor(value: number, rgb: boolean): string {
  if (rgb) return `#${value.toString(16).padStart(6, '0')}`;
  return ansiPaletteColor(value);
}

function ansiPaletteColor(index: number): string {
  const base = [
    '#151A16', '#E06C65', '#91C39A', '#D8B26E', '#79A8D8', '#C792C7', '#76C7C0', '#DDE5DB',
    '#657066', '#F08A82', '#B0D9B6', '#E8CA8C', '#9ABFE4', '#D9A8D8', '#9BDCD5', '#F6FAF5',
  ];
  if (index < base.length) return base[index];
  if (index < 232) {
    const value = index - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    const red = levels[Math.floor(value / 36)];
    const green = levels[Math.floor((value % 36) / 6)];
    const blue = levels[value % 6];
    return `rgb(${red} ${green} ${blue})`;
  }
  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray} ${gray} ${gray})`;
}

requestAnimationFrame(() => {
  fitAddon.fit();
  window.TermbridgeNative?.onReady(terminal.cols, terminal.rows);
});
