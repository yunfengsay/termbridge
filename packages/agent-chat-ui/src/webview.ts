/**
 * The WebView entry point for a native shell.
 *
 * It is deliberately thin: receive conversation events from the shell, render
 * them, and ask the shell for more history. The composer, the clipboard, IME,
 * attachments and every network call stay on the native side, which is what
 * keeps Chinese input and Enter-to-send behaving like the rest of the app.
 */

import { createTranscriptView, type ViewDocument, type ViewElement } from './transcriptView.js';
import { readShellMessage, type ShellMessage, type SurfaceMessage } from './bridge.js';
import { isOpenableHref } from './markdown.js';

interface WebViewHost {
  postMessage(message: SurfaceMessage): void;
  addEventListener?(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/** Native shells all deliver JSON objects through termbridgeChat.receive. */
export interface ChatSurfaceWindow {
  document: Document;
  chrome?: { webview?: WebViewHost };
  webkit?: { messageHandlers?: { agentChat?: { postMessage(message: SurfaceMessage): void } } };
  TermBridgeChat?: { postMessage(message: string): void };
  termbridgeChat?: { receive(message: unknown): void };
}

export function startChatSurface(host: WebViewHost, root: HTMLElement, scope: ChatSurfaceWindow = window): void {
  // Also survives the native shell evaluating the bundle twice in one document.
  if (scope.termbridgeChat) return;
  const document = scope.document;
  let generation = -1;
  // The real DOM satisfies the renderer's narrow contract at runtime; TypeScript
  // cannot see that through `Node`'s wider signatures, so it is asserted once here
  // rather than widening the contract the tests rely on.
  const view = createTranscriptView({
    document: document as unknown as ViewDocument,
    root: root as unknown as ViewElement,
    onLoadEarlier: (cursor) => host.postMessage({ op: 'earlier', generation, cursor }),
  });

  // A size change is not a scroll: the keyboard opening, a rotation, a font
  // scale, or the first layout of a surface that was created with no height all
  // move the numbers without the reader having touched anything. The view
  // re-applies whatever intent they already had.
  const reflow = (): void => view.reflow();
  const Observer = (scope as unknown as { ResizeObserver?: new (cb: () => void) => { observe(target: unknown): void } }).ResizeObserver;
  if (Observer) {
    const observer = new Observer(reflow);
    observer.observe(root);
    if (document.body) observer.observe(document.body);
  }
  const viewport = (scope as unknown as { visualViewport?: { addEventListener(type: string, listener: () => void): void } }).visualViewport;
  viewport?.addEventListener('resize', reflow);
  // A hidden page does not animate; the indicator is paused rather than left
  // spinning behind a locked screen.
  document.addEventListener?.('visibilitychange', () => {
    document.documentElement.dataset.hidden = document.hidden ? '1' : '';
    if (!document.hidden) reflow();
  });

  const receive = (data: unknown): void => {
    const message: ShellMessage | undefined = readShellMessage(data);
    if (!message) return;
    switch (message.op) {
      case 'snapshot':
        generation = message.generation;
        view.snapshot(message);
        break;
      case 'pending':
        // No state means the shell has nothing outstanding any more.
        view.setPendingSend(message.state
          ? {
            id: message.id, text: message.text, state: message.state,
            ...(message.error ? { error: message.error } : {}),
            ...(message.messageId ? { messageId: message.messageId } : {}),
          }
          : undefined);
        break;
      case 'load-earlier':
        view.revealHistory();
        break;
      case 'append':
        view.append(message);
        break;
      case 'earlier':
        view.prepend(message);
        break;
      case 'theme':
        document.documentElement.dataset.theme = message.theme;
        break;
      case 'clear':
        generation = -1;
        view.clear();
        break;
    }
  };
  // Publish before ready: WK/Android may answer ready synchronously.
  scope.termbridgeChat = { receive };
  host.addEventListener?.('message', ({ data }) => receive(data));

  // A link inside a transcript opens in the user's browser through the shell;
  // the surface itself never navigates.
  let copiedLinkUntil = 0;
  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const anchor = target?.closest?.('a');
    const href = anchor?.getAttribute('href');
    if (!href) return;
    event.preventDefault();
    if (Date.now() < copiedLinkUntil) return;
    if (isOpenableHref(href)) host.postMessage({ op: 'open', url: href });
  });

  root.addEventListener('contextmenu', (event) => {
    const href = (event.target as HTMLElement | null)?.closest?.('a')?.getAttribute('href');
    if (!href || !isOpenableHref(href)) return;
    event.preventDefault();
    copiedLinkUntil = Date.now() + 500;
    host.postMessage({ op: 'copy', data: href });
  });

  host.postMessage({ op: 'ready' });
}

export function initializeChatSurface(scope: ChatSurfaceWindow): void {
  if (scope.termbridgeChat) return;
  const mount = scope.document.getElementById('chat');
  if (!mount) return;
  const windows = scope.chrome?.webview;
  const apple = scope.webkit?.messageHandlers?.agentChat;
  const android = scope.TermBridgeChat;
  const host: WebViewHost | undefined = windows
    ?? (apple ? { postMessage: message => apple.postMessage(message) } : undefined)
    ?? (android ? { postMessage: message => android.postMessage(JSON.stringify(message)) } : undefined);
  if (host) startChatSurface(host, mount, scope);
}

if (typeof window !== 'undefined') initializeChatSurface(window);
