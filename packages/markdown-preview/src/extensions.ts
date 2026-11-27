/**
 * Custom Tiptap extensions for TermBridge's editorial Markdown preview surface.
 *
 * Keeps the document tree 100% ProseMirror/Tiptap-native while adding:
 * - Heading anchor IDs (`id`)
 * - GFM table column alignment (`data-align`)
 * - YAML frontmatter metadata strip (`frontmatter`)
 * - GFM callout/alert boxes (`callout`)
 * - Syntax-highlighted code blocks with language badge & copy button (`codeBlock`)
 * - Full-width figure images with captions & lightbox trigger (`figureImage`)
 * - Interactive slide carousels (`carousel`) supporting images and rich Markdown
 */

import { Editor, Extension, Node, mergeAttributes, type Extensions, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { common, createLowlight } from 'lowlight';
import type { CalloutKind, CarouselSlideData, FrontmatterEntry } from './markdownToDoc.js';

export interface ExtensionCallbacks {
  onCopy(text: string): void;
  onZoom(src: string, caption: string): void;
}

const CALLOUT_LABELS: Record<CalloutKind, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
};

const lowlight = createLowlight(common);

export const HeadingAnchorExtension = Extension.create({
  name: 'headingAnchor',
  addGlobalAttributes() {
    return [
      {
        types: ['heading'],
        attributes: {
          id: {
            default: null,
            renderHTML: (attrs) => (attrs.id ? { id: String(attrs.id) } : {}),
          },
        },
      },
    ];
  },
});

export const TableAlignExtension = Extension.create({
  name: 'tableAlign',
  addGlobalAttributes() {
    return [
      {
        types: ['tableHeader', 'tableCell'],
        attributes: {
          align: {
            default: null,
            renderHTML: (attrs) => (attrs.align ? { 'data-align': String(attrs.align) } : {}),
          },
        },
      },
    ];
  },
});

export const FrontmatterNode = Node.create({
  name: 'frontmatter',
  group: 'block',
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      entries: {
        default: [] as FrontmatterEntry[],
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="frontmatter"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'frontmatter', class: 'tb-md-frontmatter' })];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div');
      dom.className = 'tb-md-frontmatter';
      dom.setAttribute('data-type', 'frontmatter');
      const entries = Array.isArray(node.attrs.entries) ? (node.attrs.entries as FrontmatterEntry[]) : [];
      for (const entry of entries) {
        const keyEl = document.createElement('span');
        keyEl.className = 'tb-md-fm-key';
        keyEl.textContent = entry.key;
        const valEl = document.createElement('span');
        valEl.className = 'tb-md-fm-val';
        valEl.textContent = entry.value;
        dom.append(keyEl, valEl);
      }
      return { dom };
    };
  },
});

export const CalloutNode = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',

  addAttributes() {
    return {
      kind: {
        default: 'note' as CalloutKind,
      },
    };
  },

  parseHTML() {
    return [{ tag: 'aside[data-callout]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const kind = normalizeCalloutKind(node.attrs.kind);
    return [
      'aside',
      mergeAttributes(HTMLAttributes, { class: 'tb-md-callout', 'data-callout': '', 'data-kind': kind }),
      ['div', { class: 'tb-md-callout-title', contenteditable: 'false' }, CALLOUT_LABELS[kind]],
      ['div', { class: 'tb-md-callout-body' }, 0],
    ];
  },
});

function normalizeCalloutKind(raw: unknown): CalloutKind {
  if (raw === 'tip' || raw === 'important' || raw === 'warning' || raw === 'caution') return raw;
  return 'note';
}

function createCodeBlockExtension(callbacks: ExtensionCallbacks) {
  return CodeBlockLowlight.extend({
    addNodeView() {
      return ({ node }) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'tb-md-codeblock';

        const header = document.createElement('div');
        header.className = 'tb-md-codeblock-head';
        header.contentEditable = 'false';

        const langLabel = document.createElement('span');
        langLabel.className = 'tb-md-codeblock-lang';
        langLabel.textContent = typeof node.attrs.language === 'string' && node.attrs.language
          ? node.attrs.language
          : 'text';

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'tb-md-codeblock-copy';
        copyBtn.textContent = '复制';
        let resetTimer: number | undefined;
        let latestText = node.textContent;

        copyBtn.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          callbacks.onCopy(latestText);
          copyBtn.textContent = '已复制';
          if (resetTimer !== undefined) window.clearTimeout(resetTimer);
          resetTimer = window.setTimeout(() => {
            copyBtn.textContent = '复制';
            resetTimer = undefined;
          }, 1400);
        });

        header.append(langLabel, copyBtn);

        const pre = document.createElement('pre');
        const code = document.createElement('code');
        if (typeof node.attrs.language === 'string' && node.attrs.language) {
          code.className = `language-${node.attrs.language}`;
        }
        pre.append(code);
        wrapper.append(header, pre);

        return {
          dom: wrapper,
          contentDOM: code,
          update(updated) {
            if (updated.type !== node.type) return false;
            latestText = updated.textContent;
            const nextLang = typeof updated.attrs.language === 'string' && updated.attrs.language
              ? updated.attrs.language
              : 'text';
            langLabel.textContent = nextLang;
            return true;
          },
          destroy() {
            if (resetTimer !== undefined) window.clearTimeout(resetTimer);
          },
        };
      };
    },
  }).configure({ lowlight });
}

function createFigureImageNode(callbacks: ExtensionCallbacks) {
  return Node.create({
    name: 'figureImage',
    group: 'block',
    atom: true,
    selectable: false,

    addAttributes() {
      return {
        src: { default: '' },
        rawSrc: { default: '' },
        alt: { default: '' },
        title: { default: '' },
        href: { default: null },
      };
    },

    parseHTML() {
      return [{ tag: 'figure[data-type="figureImage"]' }];
    },

    renderHTML({ HTMLAttributes }) {
      return ['figure', mergeAttributes(HTMLAttributes, { 'data-type': 'figureImage', class: 'tb-md-figure' })];
    },

    addNodeView() {
      return ({ node }) => {
        const figure = document.createElement('figure');
        figure.className = 'tb-md-figure';
        figure.setAttribute('data-type', 'figureImage');

        const stage = document.createElement('div');
        stage.className = 'tb-md-figure-stage';

        const src = String(node.attrs.src ?? '');
        const rawSrc = String(node.attrs.rawSrc ?? src);
        const alt = String(node.attrs.alt ?? '');
        const title = String(node.attrs.title ?? '');
        const caption = alt || title;

        const img = document.createElement('img');
        img.src = src;
        img.alt = alt;
        if (title) img.title = title;
        img.loading = 'lazy';
        img.decoding = 'async';

        img.addEventListener('click', () => {
          callbacks.onZoom(src, caption);
        });

        img.addEventListener('error', () => {
          img.remove();
          const err = document.createElement('div');
          err.className = 'tb-md-img-error';
          err.textContent = `无法加载图片：${shortPathLabel(rawSrc)}`;
          stage.append(err);
        });

        stage.append(img);
        figure.append(stage);

        if (caption) {
          const cap = document.createElement('figcaption');
          cap.textContent = caption;
          figure.append(cap);
        }

        return { dom: figure };
      };
    },
  });
}

function createCarouselNode(callbacks: ExtensionCallbacks, buildSubExtensions: () => Extensions) {
  return Node.create({
    name: 'carousel',
    group: 'block',
    atom: true,
    selectable: false,

    addAttributes() {
      return {
        slides: { default: [] as CarouselSlideData[] },
      };
    },

    parseHTML() {
      return [{ tag: 'section[data-type="carousel"]' }];
    },

    renderHTML({ HTMLAttributes }) {
      return ['section', mergeAttributes(HTMLAttributes, { 'data-type': 'carousel', class: 'tb-md-carousel' })];
    },

    addNodeView() {
      return ({ node }) => {
        const slides = Array.isArray(node.attrs.slides) ? (node.attrs.slides as CarouselSlideData[]) : [];
        let activeIndex = 0;
        let subEditor: Editor | null = null;

        const root = document.createElement('section');
        root.className = 'tb-md-carousel';
        root.setAttribute('data-type', 'carousel');
        root.tabIndex = 0;

        const stage = document.createElement('div');
        stage.className = 'tb-md-carousel-stage';

        const bar = document.createElement('div');
        bar.className = 'tb-md-carousel-bar';

        const captionEl = document.createElement('div');
        captionEl.className = 'tb-md-carousel-caption';

        const controls = document.createElement('div');
        controls.className = 'tb-md-carousel-controls';

        const prevBtn = document.createElement('button');
        prevBtn.type = 'button';
        prevBtn.className = 'tb-md-carousel-btn';
        prevBtn.textContent = '‹';
        prevBtn.title = '上一张';
        prevBtn.setAttribute('aria-label', '上一张');

        const counter = document.createElement('span');
        counter.className = 'tb-md-carousel-counter';

        const nextBtn = document.createElement('button');
        nextBtn.type = 'button';
        nextBtn.className = 'tb-md-carousel-btn';
        nextBtn.textContent = '›';
        nextBtn.title = '下一张';
        nextBtn.setAttribute('aria-label', '下一张');

        controls.append(prevBtn, counter, nextBtn);
        bar.append(captionEl, controls);
        root.append(stage, bar);

        const cleanupSubEditor = () => {
          if (subEditor) {
            subEditor.destroy();
            subEditor = null;
          }
        };

        const renderSlide = (index: number) => {
          cleanupSubEditor();
          stage.replaceChildren();
          if (slides.length === 0) return;
          activeIndex = ((index % slides.length) + slides.length) % slides.length;
          const slide = slides[activeIndex]!;

          if (slide.image) {
            const { src, rawSrc, alt, title } = slide.image;
            const caption = alt || title;
            const img = document.createElement('img');
            img.src = src;
            img.alt = alt;
            if (title) img.title = title;
            img.decoding = 'async';
            img.addEventListener('click', () => callbacks.onZoom(src, caption));
            img.addEventListener('error', () => {
              img.remove();
              const err = document.createElement('div');
              err.className = 'tb-md-img-error';
              err.textContent = `无法加载图片：${shortPathLabel(rawSrc)}`;
              stage.append(err);
            });
            stage.append(img);
            captionEl.textContent = caption || shortPathLabel(rawSrc);
          } else {
            const richHost = document.createElement('div');
            richHost.className = 'tb-md-carousel-rich';
            stage.append(richHost);
            const content: JSONContent = {
              type: 'doc',
              content: slide.blocks.length > 0 ? slide.blocks : [{ type: 'paragraph' }],
            };
            subEditor = new Editor({
              element: richHost,
              editable: false,
              extensions: buildSubExtensions(),
              content,
              editorProps: {
                attributes: { class: 'tb-md-editor' },
              },
            });
            captionEl.textContent = `幻灯片 ${activeIndex + 1}`;
          }

          counter.textContent = `${activeIndex + 1} / ${slides.length}`;
          controls.style.display = slides.length > 1 ? 'inline-flex' : 'none';
        };

        prevBtn.addEventListener('click', (event) => {
          event.preventDefault();
          renderSlide(activeIndex - 1);
        });
        nextBtn.addEventListener('click', (event) => {
          event.preventDefault();
          renderSlide(activeIndex + 1);
        });
        root.addEventListener('keydown', (event) => {
          if (slides.length <= 1) return;
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            renderSlide(activeIndex - 1);
          } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            renderSlide(activeIndex + 1);
          }
        });

        renderSlide(0);

        return {
          dom: root,
          destroy() {
            cleanupSubEditor();
          },
        };
      };
    },
  });
}

function shortPathLabel(rawPath: string): string {
  const parts = rawPath.split('/').filter(Boolean);
  if (parts.length <= 2) return rawPath;
  return parts.slice(-2).join('/');
}

function buildCoreExtensions(callbacks: ExtensionCallbacks): Extensions {
  return [
    StarterKit.configure({
      codeBlock: false,
      link: {
        openOnClick: false,
        autolink: false,
        linkOnPaste: false,
      },
    }),
    HeadingAnchorExtension,
    TableAlignExtension,
    FrontmatterNode,
    CalloutNode,
    createCodeBlockExtension(callbacks),
    createFigureImageNode(callbacks),
    Image.configure({ inline: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({ nested: true }),
  ];
}

export function createMarkdownExtensions(callbacks: ExtensionCallbacks, extra: Extensions = []): Extensions {
  const core = buildCoreExtensions(callbacks);
  const carousel = createCarouselNode(callbacks, () => buildCoreExtensions(callbacks));
  return [...core, carousel, ...extra];
}
