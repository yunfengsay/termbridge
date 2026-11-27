/**
 * ProseMirror/Tiptap in-document find & highlight extension.
 *
 * Scans all text nodes in the read-only Tiptap document, applies subtle match
 * decorations + an active match highlight, scrolls the active match into view,
 * and reports `(index, total)` back to Swift's `MacFindBarView`.
 */

import { Extension, type Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface SearchMatch {
  from: number;
  to: number;
}

export interface SearchState {
  query: string;
  caseSensitive: boolean;
  matches: SearchMatch[];
  activeIndex: number;
  decorations: DecorationSet;
}

export interface SearchReport {
  index: number;
  total: number;
}

const searchPluginKey = new PluginKey<SearchState>('tbMarkdownSearch');

function computeMatches(doc: ProseMirrorNode, query: string, caseSensitive: boolean): SearchMatch[] {
  if (!query) return [];
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: SearchMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const haystack = caseSensitive ? node.text : node.text.toLowerCase();
    let offset = 0;
    while (offset <= haystack.length - needle.length) {
      const idx = haystack.indexOf(needle, offset);
      if (idx === -1) break;
      matches.push({ from: pos + idx, to: pos + idx + needle.length });
      offset = idx + Math.max(1, needle.length);
    }
  });
  return matches;
}

function buildDecorations(doc: ProseMirrorNode, matches: readonly SearchMatch[], activeIndex: number): DecorationSet {
  if (matches.length === 0) return DecorationSet.empty;
  const decorations = matches.map((match, idx) =>
    Decoration.inline(match.from, match.to, {
      class: idx === activeIndex ? 'tb-find-match tb-find-match-active' : 'tb-find-match',
    }),
  );
  return DecorationSet.create(doc, decorations);
}

const EMPTY_STATE: SearchState = {
  query: '',
  caseSensitive: false,
  matches: [],
  activeIndex: -1,
  decorations: DecorationSet.empty,
};

export const SearchHighlightExtension = Extension.create({
  name: 'tbSearchHighlight',

  addProseMirrorPlugins() {
    return [
      new Plugin<SearchState>({
        key: searchPluginKey,
        state: {
          init: () => EMPTY_STATE,
          apply(tr, prev, _oldState, newState) {
            const meta = tr.getMeta(searchPluginKey) as
              | { op: 'set'; query: string; caseSensitive: boolean }
              | { op: 'step'; delta: number }
              | { op: 'clear' }
              | undefined;

            if (meta?.op === 'clear') return EMPTY_STATE;

            if (meta?.op === 'set') {
              if (!meta.query) return EMPTY_STATE;
              const matches = computeMatches(newState.doc, meta.query, meta.caseSensitive);
              const activeIndex = matches.length > 0 ? 0 : -1;
              return {
                query: meta.query,
                caseSensitive: meta.caseSensitive,
                matches,
                activeIndex,
                decorations: buildDecorations(newState.doc, matches, activeIndex),
              };
            }

            if (meta?.op === 'step') {
              if (prev.matches.length === 0) return prev;
              const count = prev.matches.length;
              const base = prev.activeIndex < 0 ? 0 : prev.activeIndex;
              const activeIndex = ((base + meta.delta) % count + count) % count;
              return {
                ...prev,
                activeIndex,
                decorations: buildDecorations(newState.doc, prev.matches, activeIndex),
              };
            }

            if (tr.docChanged && prev.query) {
              const matches = computeMatches(newState.doc, prev.query, prev.caseSensitive);
              const activeIndex = matches.length > 0 ? Math.min(Math.max(0, prev.activeIndex), matches.length - 1) : -1;
              return {
                ...prev,
                matches,
                activeIndex,
                decorations: buildDecorations(newState.doc, matches, activeIndex),
              };
            }

            return prev;
          },
        },
        props: {
          decorations(state) {
            return searchPluginKey.getState(state)?.decorations ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

function scrollActiveMatchIntoView(editor: Editor): void {
  const active = editor.view.dom.querySelector('.tb-find-match-active');
  if (active && typeof active.scrollIntoView === 'function') {
    active.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function reportFrom(editor: Editor): SearchReport {
  const state = searchPluginKey.getState(editor.state);
  if (!state || state.matches.length === 0) return { index: 0, total: 0 };
  return { index: state.activeIndex + 1, total: state.matches.length };
}

export function setSearchQuery(editor: Editor, query: string, caseSensitive: boolean): SearchReport {
  editor.view.dispatch(editor.state.tr.setMeta(searchPluginKey, { op: 'set', query, caseSensitive }));
  const report = reportFrom(editor);
  if (report.total > 0) scrollActiveMatchIntoView(editor);
  return report;
}

export function stepSearchMatch(editor: Editor, delta: number): SearchReport {
  editor.view.dispatch(editor.state.tr.setMeta(searchPluginKey, { op: 'step', delta }));
  const report = reportFrom(editor);
  if (report.total > 0) scrollActiveMatchIntoView(editor);
  return report;
}

export function clearSearchQuery(editor: Editor): SearchReport {
  editor.view.dispatch(editor.state.tr.setMeta(searchPluginKey, { op: 'clear' }));
  return { index: 0, total: 0 };
}
