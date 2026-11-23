/**
 * Builds DOM from a parsed Markdown tree.
 *
 * Every element is created here and every Agent-authored string lands in
 * `textContent`. The parser supplies structure; nothing it returns is ever
 * interpreted as markup, so a transcript full of HTML, script tags or odd URL
 * schemes renders as the characters the model actually wrote.
 */

import type { MarkdownBlock, MarkdownInline } from './markdown.js';
import { parseMarkdown } from './markdown.js';
import type { ViewDocument, ViewElement } from './transcriptView.js';

export function renderMarkdown(doc: ViewDocument, source: string): ViewElement[] {
  return parseMarkdown(source).map((block) => renderBlock(doc, block));
}

function renderBlock(doc: ViewDocument, block: MarkdownBlock): ViewElement {
  switch (block.type) {
    case 'paragraph': {
      const node = element(doc, 'p', 'tb-md-p');
      appendInline(doc, node, block.children);
      return node;
    }
    case 'heading': {
      const level = Math.min(Math.max(block.level, 1), 6);
      const node = element(doc, `h${level}`, 'tb-md-h');
      appendInline(doc, node, block.children);
      return node;
    }
    case 'code': {
      // The wrapper scrolls, not the page: a long line inside a fence must not
      // widen the conversation.
      const wrapper = element(doc, 'div', 'tb-md-codewrap');
      const pre = element(doc, 'pre', 'tb-md-code');
      const code = element(doc, 'code');
      if (block.language) code.setAttribute('data-language', block.language);
      // One text node, so copying a block gives back exactly the source.
      code.textContent = block.text;
      pre.appendChild(code);
      wrapper.appendChild(pre);
      return wrapper;
    }
    case 'list': {
      const node = element(doc, block.ordered ? 'ol' : 'ul', 'tb-md-list');
      if (block.ordered && block.start !== 1) node.setAttribute('start', String(block.start));
      for (const item of block.items) {
        const li = element(doc, 'li', item.checked === undefined ? '' : 'tb-md-task');
        if (item.checked !== undefined) {
          // Rendered as state, not as a control: nothing here can change a
          // checkbox the Agent wrote into its own transcript.
          const mark = element(doc, 'span', 'tb-md-check');
          mark.textContent = item.checked ? '☑' : '☐';
          li.appendChild(mark);
        }
        // A one-paragraph item is inline content: wrapping it in a block would
        // push the text below its own bullet or checkbox.
        const [only] = item.children;
        if (item.children.length === 1 && only?.type === 'paragraph') appendInline(doc, li, only.children);
        else for (const child of item.children) li.appendChild(renderBlock(doc, child));
        node.appendChild(li);
      }
      return node;
    }
    case 'table': {
      const wrapper = element(doc, 'div', 'tb-md-tablewrap');
      const table = element(doc, 'table', 'tb-md-table');
      const head = element(doc, 'thead');
      const headRow = element(doc, 'tr');
      block.header.forEach((cell, index) => {
        const th = element(doc, 'th');
        const align = block.align[index];
        if (align) th.setAttribute('data-align', align);
        appendInline(doc, th, cell);
        headRow.appendChild(th);
      });
      head.appendChild(headRow);
      table.appendChild(head);
      const body = element(doc, 'tbody');
      for (const row of block.rows) {
        const tr = element(doc, 'tr');
        row.forEach((cell, index) => {
          const td = element(doc, 'td');
          const align = block.align[index];
          if (align) td.setAttribute('data-align', align);
          appendInline(doc, td, cell);
          tr.appendChild(td);
        });
        body.appendChild(tr);
      }
      table.appendChild(body);
      wrapper.appendChild(table);
      return wrapper;
    }
    case 'quote': {
      const node = element(doc, 'blockquote', 'tb-md-quote');
      for (const child of block.children) node.appendChild(renderBlock(doc, child));
      return node;
    }
    case 'rule':
      return element(doc, 'hr', 'tb-md-rule');
  }
}

function appendInline(doc: ViewDocument, parent: ViewElement, nodes: readonly MarkdownInline[]): void {
  for (const node of nodes) parent.appendChild(renderInline(doc, node));
}

function renderInline(doc: ViewDocument, node: MarkdownInline): ViewElement {
  switch (node.type) {
    case 'text': {
      const span = element(doc, 'span');
      span.textContent = node.text;
      return span;
    }
    case 'code': {
      const code = element(doc, 'code', 'tb-md-inline-code');
      code.textContent = node.text;
      return code;
    }
    case 'strong': {
      const strong = element(doc, 'strong');
      appendInline(doc, strong, node.children);
      return strong;
    }
    case 'emphasis': {
      const em = element(doc, 'em');
      appendInline(doc, em, node.children);
      return em;
    }
    case 'strike': {
      const del = element(doc, 's');
      appendInline(doc, del, node.children);
      return del;
    }
    case 'break':
      return element(doc, 'br');
    case 'link': {
      // The shell owns navigation: it intercepts the click, re-checks the
      // scheme and opens it outside the WebView.
      const anchor = element(doc, 'a', 'tb-md-link');
      anchor.setAttribute('href', node.href);
      anchor.setAttribute('rel', 'noreferrer noopener');
      appendInline(doc, anchor, node.children);
      return anchor;
    }
  }
}

function element(doc: ViewDocument, tag: string, className = ''): ViewElement {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  return node;
}
