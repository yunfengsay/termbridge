/**
 * WKWebView entrypoint for TermBridge's Tiptap Markdown preview surface.
 *
 * Mounts a single read-only Tiptap `Editor`, receives render / theme / find
 * commands from Swift (`window.termbridgeMarkdown.receive`), and posts link
 * clicks, clipboard copies, and search match counts back over `webkit.messageHandlers`.
 */

import { Editor } from '@tiptap/core';
import { readShellMessage, type SurfaceMessage } from './bridge.js';
import { createMarkdownExtensions } from './extensions.js';
import { markdownToTiptapDocument } from './markdownToDoc.js';
import {
  SearchHighlightExtension,
  clearSearchQuery,
  setSearchQuery,
  stepSearchMatch,
} from './searchExtension.js';

interface WebViewHost {
  postMessage(message: SurfaceMessage): void;
}

export interface MarkdownSurfaceWindow {
  document: Document;
  webkit?: { messageHandlers?: { markdownPreview?: { postMessage(message: SurfaceMessage): void } } };
  termbridgeMarkdown?: { receive(message: unknown): void };
}

export function startMarkdownSurface(
  host: WebViewHost,
  root: HTMLElement,
  scope: MarkdownSurfaceWindow = window,
): void {
  if (scope.termbridgeMarkdown) return;
  const doc = scope.document;
  const scrollContainer = doc.getElementById('markdown-scroll') ?? root;

  // Shared full-window image lightbox overlay
  const lightbox = doc.createElement('div');
  lightbox.className = 'tb-md-lightbox';
  lightbox.hidden = true;
  const lightboxImg = doc.createElement('img');
  const lightboxCaption = doc.createElement('div');
  lightboxCaption.className = 'tb-md-lightbox-caption';
  lightbox.append(lightboxImg, lightboxCaption);
  doc.body.append(lightbox);

  const closeLightbox = (): void => {
    lightbox.hidden = true;
    lightboxImg.removeAttribute('src');
    lightboxCaption.textContent = '';
  };

  const openLightbox = (src: string, caption: string): void => {
    lightboxImg.src = src;
    lightboxImg.alt = caption;
    lightboxCaption.textContent = caption;
    lightboxCaption.style.display = caption ? 'block' : 'none';
    lightbox.hidden = false;
  };

  lightbox.addEventListener('click', closeLightbox);
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !lightbox.hidden) {
      event.preventDefault();
      closeLightbox();
    }
  });

  const editor = new Editor({
    element: root,
    editable: false,
    extensions: createMarkdownExtensions(
      {
        onCopy: (data) => host.postMessage({ op: 'copy', data }),
        onZoom: (src, caption) => openLightbox(src, caption),
      },
      [SearchHighlightExtension],
    ),
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
    editorProps: {
      attributes: {
        class: 'tb-md-editor',
      },
    },
  });

  const receive = (raw: unknown): void => {
    const message = readShellMessage(raw);
    if (!message) return;
    switch (message.op) {
      case 'theme':
        doc.documentElement.dataset.theme = message.theme;
        break;
      case 'render': {
        if (message.theme) doc.documentElement.dataset.theme = message.theme;
        closeLightbox();
        const { doc: tiptapDoc, stats } = markdownToTiptapDocument(message.markdown);
        editor.commands.setContent(tiptapDoc, { emitUpdate: false });
        clearSearchQuery(editor);
        scrollContainer.scrollTop = 0;
        host.postMessage({
          op: 'rendered',
          headingCount: stats.headingCount,
          imageCount: stats.imageCount,
          carouselCount: stats.carouselCount,
        });
        break;
      }
      case 'find': {
        const result = setSearchQuery(editor, message.query, message.caseSensitive === true);
        host.postMessage({ op: 'findResult', index: result.index, total: result.total });
        break;
      }
      case 'findNext': {
        const result = stepSearchMatch(editor, 1);
        host.postMessage({ op: 'findResult', index: result.index, total: result.total });
        break;
      }
      case 'findPrevious': {
        const result = stepSearchMatch(editor, -1);
        host.postMessage({ op: 'findResult', index: result.index, total: result.total });
        break;
      }
      case 'clearFind': {
        const result = clearSearchQuery(editor);
        host.postMessage({ op: 'findResult', index: result.index, total: result.total });
        break;
      }
      case 'clear': {
        closeLightbox();
        editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph' }] }, { emitUpdate: false });
        clearSearchQuery(editor);
        scrollContainer.scrollTop = 0;
        break;
      }
    }
  };

  // Publish before `ready` so synchronous replies from WKWebView always find it.
  scope.termbridgeMarkdown = { receive };

  let suppressClickUntil = 0;
  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const anchor = target?.closest?.('a');
    const href = anchor?.getAttribute('href');
    if (!href) return;
    event.preventDefault();
    if (Date.now() < suppressClickUntil) return;
    if (href.startsWith('#')) {
      const id = decodeAnchor(href.slice(1));
      const heading = id ? doc.getElementById(id) : null;
      heading?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    host.postMessage({ op: 'open', url: href });
  });

  root.addEventListener('contextmenu', (event) => {
    const href = (event.target as HTMLElement | null)?.closest?.('a')?.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    event.preventDefault();
    suppressClickUntil = Date.now() + 500;
    host.postMessage({ op: 'copy', data: href });
  });

  host.postMessage({ op: 'ready' });
}

function decodeAnchor(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function initializeMarkdownSurface(scope: MarkdownSurfaceWindow): void {
  if (scope.termbridgeMarkdown) return;
  const mount = scope.document.getElementById('markdown-root');
  if (!mount) return;
  const apple = scope.webkit?.messageHandlers?.markdownPreview;
  const host: WebViewHost = apple
    ? { postMessage: (message) => apple.postMessage(message) }
    : { postMessage: () => {} };
  startMarkdownSurface(host, mount, scope);
}

if (typeof window !== 'undefined') initializeMarkdownSurface(window);
