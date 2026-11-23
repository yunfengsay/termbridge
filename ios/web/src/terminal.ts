import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { createMobileTranscriptController } from '../../../packages/mobile-terminal/src/mobile-transcript';
import {
  createKineticScroller,
  dispatchWheelDelta,
} from '../../../packages/mobile-terminal/src/touch-scroll';
import { installBareHttpLinkProvider, openSafeExternalLink } from '../../../packages/mobile-terminal/src/terminal-links';

declare global {
  interface Window {
    TermbridgeNative?: {
      onReady(cols: number, rows: number): void;
      onData(data: string): void;
      onBinary(base64: string): void;
      onResize(cols: number, rows: number): void;
      onTitle(title: string): void;
      onCopy(text: string): void;
      onBell(): void;
      onTranscriptResync(revision: number): void;
      onOpenLink(url: string): void;
      onInputMode(bracketedPaste: boolean): void;
    };
    Termbridge?: {
      writeBase64(base64: string): void;
      applyMobileSnapshot(revision: number, payloadBase64: string): void;
      applyMobilePatch(baseRevision: number, revision: number, payloadBase64: string): void;
      focus(): void;
      fit(): void;
      reset(): void;
      copySelection(): void;
      paste(text: string): void;
      beginScroll(clientX: number, clientY: number): void;
      scrollByPixels(deltaY: number, clientX: number, clientY: number): void;
      endScroll(velocityY: number): void;
      cancelScroll(): void;
    };
  }
}

const openExternalLink = (href: string): void => window.TermbridgeNative?.onOpenLink(href);

const terminal = new Terminal({
  allowProposedApi: false,
  convertEol: false,
  cursorBlink: true,
  cursorStyle: 'block',
  drawBoldTextInBrightColors: true,
  fontFamily: "'Roboto Mono', 'Noto Sans Mono CJK SC', monospace",
  fontSize: 14,
  fontWeight: '400',
  fontWeightBold: '700',
  letterSpacing: 0,
  lineHeight: 1.08,
  linkHandler: {
    activate: (_event, href) => openSafeExternalLink(href, openExternalLink),
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

const fitAddon = new FitAddon();
terminal.onWriteParsed(() => window.TermbridgeNative?.onInputMode(terminal.modes.bracketedPasteMode));
terminal.loadAddon(fitAddon);
installBareHttpLinkProvider(terminal, openExternalLink);

const host = document.getElementById('terminal');
if (!host) throw new Error('terminal mount is missing');
const transcript = document.getElementById('mobile-transcript');
if (!transcript) throw new Error('mobile transcript mount is missing');
terminal.open(host);
const wheelTarget = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
if (!wheelTarget) throw new Error('terminal wheel target is missing');
let scrollCoordinates = { clientX: 0, clientY: 0 };
const structuredTranscript = createMobileTranscriptController(host, transcript, (revision) => {
  window.TermbridgeNative?.onTranscriptResync(revision ?? -1);
}, openExternalLink);
const kineticScroller = createKineticScroller((deltaY) => {
  if (structuredTranscript.active) transcript.scrollTop += deltaY;
  else dispatchWheelDelta(wheelTarget, { ...scrollCoordinates, deltaY });
});

terminal.onData((data) => window.TermbridgeNative?.onData(data));
terminal.onBinary((data) => {
  const bytes = Uint8Array.from(data, (char) => char.charCodeAt(0) & 0xff);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  window.TermbridgeNative?.onBinary(btoa(binary));
});
terminal.onResize(({ cols, rows }) => window.TermbridgeNative?.onResize(cols, rows));
terminal.onTitleChange((title) => window.TermbridgeNative?.onTitle(title));
terminal.onBell(() => window.TermbridgeNative?.onBell());

let resizeTimer: number | undefined;
function fit(): void {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    try {
      fitAddon.fit();
    } catch {
      // A transient zero-sized viewport while the mobile keyboard animates.
    }
  }, 40);
}

new ResizeObserver(fit).observe(host);
window.visualViewport?.addEventListener('resize', fit);
window.addEventListener('resize', fit);

window.Termbridge = {
  writeBase64(base64: string): void {
    const binary = atob(base64);
    if (structuredTranscript.active && binary.startsWith('\x1b[3J\x1b[2J\x1b[H')) {
      structuredTranscript.reset();
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    terminal.write(bytes);
  },
  applyMobileSnapshot(revision, payloadBase64): void {
    structuredTranscript.applySnapshot(revision, payloadBase64);
  },
  applyMobilePatch(baseRevision, revision, payloadBase64): void {
    structuredTranscript.applyPatch(baseRevision, revision, payloadBase64);
  },
  focus(): void {
    terminal.focus();
  },
  fit,
  reset(): void {
    kineticScroller.cancel();
    structuredTranscript.reset();
    terminal.reset();
    terminal.clear();
  },
  copySelection(): void {
    const selection = structuredTranscript.active ? window.getSelection()?.toString() : terminal.getSelection();
    if (selection) window.TermbridgeNative?.onCopy(selection);
  },
  paste(text: string): void {
    terminal.paste(text);
    terminal.focus();
  },
  beginScroll(clientX: number, clientY: number): void {
    scrollCoordinates = { clientX, clientY };
    kineticScroller.begin();
  },
  scrollByPixels(deltaY: number, clientX: number, clientY: number): void {
    scrollCoordinates = { clientX, clientY };
    kineticScroller.move(deltaY);
  },
  endScroll(velocityY: number): void {
    kineticScroller.fling(velocityY);
  },
  cancelScroll(): void {
    kineticScroller.cancel();
  },
};

requestAnimationFrame(() => {
  fitAddon.fit();
  terminal.focus();
  window.TermbridgeNative?.onReady(terminal.cols, terminal.rows);
});
