/**
 * Editorial Markdown reader stylesheet for the bundled Tiptap surface.
 *
 * Follows TermBridge's calm light/dark native surfaces (#fbfbfd / #161618) with
 * restrained hierarchy, hairline rules, readable measure, and crisp syntax &
 * gallery styling. No CDN fonts, no decorative clutter.
 */
export const MARKDOWN_PREVIEW_CSS = `
:root {
  color-scheme: light dark;
  --tb-bg: #fbfbfd;
  --tb-surface: #f4f4f7;
  --tb-surface-raised: #ffffff;
  --tb-border: #e3e3e8;
  --tb-border-subtle: #ececf0;
  --tb-text: #18181b;
  --tb-text-secondary: #52525b;
  --tb-muted: #71717a;
  --tb-accent: #2563eb;
  --tb-accent-soft: rgba(37, 99, 235, 0.08);
  --tb-heading: #111114;
  --tb-inline-code-bg: #f1f1f5;
  --tb-inline-code-border: #e2e2e9;
  --tb-inline-code-text: #27272a;
  --tb-check-bg: #15803d;
  --tb-note: #2563eb;
  --tb-note-bg: rgba(37, 99, 235, 0.055);
  --tb-tip: #15803d;
  --tb-tip-bg: rgba(21, 128, 61, 0.055);
  --tb-important: #7c3aed;
  --tb-important-bg: rgba(124, 58, 237, 0.055);
  --tb-warning: #b45309;
  --tb-warning-bg: rgba(180, 83, 9, 0.065);
  --tb-caution: #dc2626;
  --tb-caution-bg: rgba(220, 38, 38, 0.055);
  --tb-find-bg: rgba(245, 158, 11, 0.28);
  --tb-find-active-bg: #f59e0b;
  --tb-find-active-text: #111114;
  --tb-hl-keyword: #9a3412;
  --tb-hl-string: #15803d;
  --tb-hl-number: #1d4ed8;
  --tb-hl-title: #6d28d9;
  --tb-hl-attr: #0f766e;
  --tb-hl-comment: #71717a;
  --tb-hl-addition: #15803d;
  --tb-hl-deletion: #b91c1c;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --tb-bg: #161618;
    --tb-surface: #1d1d21;
    --tb-surface-raised: #222227;
    --tb-border: #2c2c33;
    --tb-border-subtle: #24242a;
    --tb-text: #e9e9ee;
    --tb-text-secondary: #a1a1aa;
    --tb-muted: #787882;
    --tb-accent: #7aa2ff;
    --tb-accent-soft: rgba(122, 162, 255, 0.12);
    --tb-heading: #f4f4f6;
    --tb-inline-code-bg: #23232a;
    --tb-inline-code-border: #32323c;
    --tb-inline-code-text: #e4e4e7;
    --tb-check-bg: #34d399;
    --tb-note: #60a5fa;
    --tb-note-bg: rgba(96, 165, 250, 0.08);
    --tb-tip: #4ade80;
    --tb-tip-bg: rgba(74, 222, 128, 0.08);
    --tb-important: #c084fc;
    --tb-important-bg: rgba(192, 132, 252, 0.08);
    --tb-warning: #fbbf24;
    --tb-warning-bg: rgba(251, 191, 36, 0.09);
    --tb-caution: #f87171;
    --tb-caution-bg: rgba(248, 113, 113, 0.09);
    --tb-find-bg: rgba(251, 191, 36, 0.25);
    --tb-find-active-bg: #fbbf24;
    --tb-find-active-text: #111114;
    --tb-hl-keyword: #f97316;
    --tb-hl-string: #86efac;
    --tb-hl-number: #93c5fd;
    --tb-hl-title: #d8b4fe;
    --tb-hl-attr: #5eead4;
    --tb-hl-comment: #7c7c88;
    --tb-hl-addition: #4ade80;
    --tb-hl-deletion: #f87171;
  }
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --tb-bg: #161618;
  --tb-surface: #1d1d21;
  --tb-surface-raised: #222227;
  --tb-border: #2c2c33;
  --tb-border-subtle: #24242a;
  --tb-text: #e9e9ee;
  --tb-text-secondary: #a1a1aa;
  --tb-muted: #787882;
  --tb-accent: #7aa2ff;
  --tb-accent-soft: rgba(122, 162, 255, 0.12);
  --tb-heading: #f4f4f6;
  --tb-inline-code-bg: #23232a;
  --tb-inline-code-border: #32323c;
  --tb-inline-code-text: #e4e4e7;
  --tb-check-bg: #34d399;
  --tb-note: #60a5fa;
  --tb-note-bg: rgba(96, 165, 250, 0.08);
  --tb-tip: #4ade80;
  --tb-tip-bg: rgba(74, 222, 128, 0.08);
  --tb-important: #c084fc;
  --tb-important-bg: rgba(192, 132, 252, 0.08);
  --tb-warning: #fbbf24;
  --tb-warning-bg: rgba(251, 191, 36, 0.09);
  --tb-caution: #f87171;
  --tb-caution-bg: rgba(248, 113, 113, 0.09);
  --tb-find-bg: rgba(251, 191, 36, 0.25);
  --tb-find-active-bg: #fbbf24;
  --tb-find-active-text: #111114;
  --tb-hl-keyword: #f97316;
  --tb-hl-string: #86efac;
  --tb-hl-number: #93c5fd;
  --tb-hl-title: #d8b4fe;
  --tb-hl-attr: #5eead4;
  --tb-hl-comment: #7c7c88;
  --tb-hl-addition: #4ade80;
  --tb-hl-deletion: #f87171;
}

:root[data-theme="light"] {
  color-scheme: light;
}

* {
  box-sizing: border-box;
}

html, body {
  height: 100%;
  margin: 0;
  padding: 0;
  background: var(--tb-bg);
  color: var(--tb-text);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", system-ui, sans-serif;
  font-size: 14.5px;
  line-height: 1.72;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

#markdown-scroll {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
}

#markdown-root {
  max-width: 840px;
  margin: 0 auto;
  padding: 28px 36px 72px;
}

@media (max-width: 640px) {
  #markdown-root {
    padding: 20px 18px 56px;
  }
}

.tb-md-editor.ProseMirror {
  outline: none;
  word-wrap: break-word;
  overflow-wrap: break-word;
}

.tb-md-editor.ProseMirror > :first-child {
  margin-top: 0;
}

.tb-md-editor.ProseMirror > :last-child {
  margin-bottom: 0;
}

/* Frontmatter metadata strip */
.tb-md-frontmatter {
  margin: 0 0 22px;
  padding: 10px 14px;
  border: 1px solid var(--tb-border);
  border-radius: 8px;
  background: var(--tb-surface);
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 5px 14px;
  font-size: 12.5px;
  line-height: 1.5;
}

.tb-md-fm-key {
  color: var(--tb-muted);
  font-family: "SF Mono", ui-monospace, Menlo, monospace;
  font-size: 11.5px;
  white-space: nowrap;
}

.tb-md-fm-val {
  color: var(--tb-text-secondary);
  overflow-wrap: anywhere;
}

/* Headings */
.tb-md-editor h1,
.tb-md-editor h2,
.tb-md-editor h3,
.tb-md-editor h4,
.tb-md-editor h5,
.tb-md-editor h6 {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", system-ui, sans-serif;
  color: var(--tb-heading);
  font-weight: 650;
  letter-spacing: -0.015em;
  line-height: 1.32;
  margin: 1.55em 0 0.6em;
  scroll-margin-top: 20px;
}

.tb-md-editor h1 {
  font-size: 1.75em;
  font-weight: 700;
  padding-bottom: 0.35em;
  border-bottom: 1px solid var(--tb-border);
  margin-top: 0.2em;
}

.tb-md-editor h2 {
  font-size: 1.34em;
  padding-bottom: 0.28em;
  border-bottom: 1px solid var(--tb-border-subtle);
}

.tb-md-editor h3 {
  font-size: 1.12em;
}

.tb-md-editor h4 {
  font-size: 1em;
}

.tb-md-editor h5,
.tb-md-editor h6 {
  font-size: 0.92em;
  color: var(--tb-text-secondary);
}

/* Paragraphs & emphasis */
.tb-md-editor p {
  margin: 0 0 0.95em;
}

.tb-md-editor strong {
  font-weight: 650;
  color: var(--tb-heading);
}

.tb-md-editor a {
  color: var(--tb-accent);
  text-decoration: none;
  border-bottom: 1px solid color-mix(in srgb, var(--tb-accent) 35%, transparent);
  transition: border-color 120ms ease;
  cursor: pointer;
}

.tb-md-editor a:hover {
  border-bottom-color: var(--tb-accent);
}

.tb-md-editor hr {
  border: 0;
  border-top: 1px solid var(--tb-border);
  margin: 26px 0;
}

/* Inline code */
.tb-md-editor :not(pre) > code {
  font-family: "SF Mono", ui-monospace, Menlo, monospace;
  font-size: 0.87em;
  padding: 1.5px 5.5px;
  border-radius: 5px;
  background: var(--tb-inline-code-bg);
  border: 1px solid var(--tb-inline-code-border);
  color: var(--tb-inline-code-text);
  overflow-wrap: anywhere;
}

/* Lists & GFM task lists */
.tb-md-editor ul,
.tb-md-editor ol {
  margin: 0 0 1em;
  padding-left: 1.6em;
}

.tb-md-editor li {
  margin: 0.3em 0;
}

.tb-md-editor li > p {
  margin: 0 0 0.35em;
}

.tb-md-editor li > p:last-child {
  margin-bottom: 0;
}

.tb-md-editor li > ul,
.tb-md-editor li > ol {
  margin-top: 0.3em;
  margin-bottom: 0.35em;
}

.tb-md-editor ul[data-type="taskList"] {
  list-style: none;
  padding-left: 0.25em;
}

.tb-md-editor ul[data-type="taskList"] li {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  margin: 0.42em 0;
}

.tb-md-editor ul[data-type="taskList"] li > label {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  margin-top: 4px;
  user-select: none;
}

.tb-md-editor ul[data-type="taskList"] li > label input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  width: 15px;
  height: 15px;
  margin: 0;
  border-radius: 4px;
  border: 1.5px solid var(--tb-border);
  background: var(--tb-surface-raised);
  position: relative;
  pointer-events: none;
}

.tb-md-editor ul[data-type="taskList"] li > label input[type="checkbox"]:checked {
  border-color: var(--tb-check-bg);
  background: var(--tb-check-bg);
}

.tb-md-editor ul[data-type="taskList"] li > label input[type="checkbox"]:checked::after {
  content: "";
  position: absolute;
  left: 4px;
  top: 1px;
  width: 4px;
  height: 8px;
  border: solid #ffffff;
  border-width: 0 1.8px 1.8px 0;
  transform: rotate(45deg);
}

.tb-md-editor ul[data-type="taskList"] li > div {
  flex: 1 1 auto;
  min-width: 0;
}

.tb-md-editor ul[data-type="taskList"] li[data-checked="true"] > div {
  color: var(--tb-text-secondary);
}

/* Blockquotes & GFM Callouts */
.tb-md-editor blockquote {
  margin: 0 0 1.1em;
  padding: 4px 0 4px 14px;
  border-left: 3px solid var(--tb-border);
  color: var(--tb-text-secondary);
}

.tb-md-editor blockquote > :last-child {
  margin-bottom: 0;
}

.tb-md-callout {
  margin: 0 0 1.2em;
  padding: 11px 15px;
  border-radius: 8px;
  border: 1px solid var(--tb-border);
  border-left-width: 3px;
}

.tb-md-callout-title {
  font-size: 11.5px;
  font-weight: 650;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  margin: 0 0 6px;
}

.tb-md-callout-body > :first-child { margin-top: 0; }
.tb-md-callout-body > :last-child { margin-bottom: 0; }

.tb-md-callout[data-kind="note"] { border-left-color: var(--tb-note); background: var(--tb-note-bg); }
.tb-md-callout[data-kind="note"] .tb-md-callout-title { color: var(--tb-note); }

.tb-md-callout[data-kind="tip"] { border-left-color: var(--tb-tip); background: var(--tb-tip-bg); }
.tb-md-callout[data-kind="tip"] .tb-md-callout-title { color: var(--tb-tip); }

.tb-md-callout[data-kind="important"] { border-left-color: var(--tb-important); background: var(--tb-important-bg); }
.tb-md-callout[data-kind="important"] .tb-md-callout-title { color: var(--tb-important); }

.tb-md-callout[data-kind="warning"] { border-left-color: var(--tb-warning); background: var(--tb-warning-bg); }
.tb-md-callout[data-kind="warning"] .tb-md-callout-title { color: var(--tb-warning); }

.tb-md-callout[data-kind="caution"] { border-left-color: var(--tb-caution); background: var(--tb-caution-bg); }
.tb-md-callout[data-kind="caution"] .tb-md-callout-title { color: var(--tb-caution); }

/* Code blocks (Tiptap CodeBlockLowlight NodeView) */
.tb-md-codeblock {
  margin: 0 0 1.2em;
  border: 1px solid var(--tb-border);
  border-radius: 8px;
  background: var(--tb-surface);
  overflow: hidden;
}

.tb-md-codeblock-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 10px 5px 12px;
  border-bottom: 1px solid var(--tb-border-subtle);
  background: color-mix(in srgb, var(--tb-surface) 80%, var(--tb-bg));
  user-select: none;
}

.tb-md-codeblock-lang {
  font-family: "SF Mono", ui-monospace, Menlo, monospace;
  font-size: 11px;
  color: var(--tb-muted);
  text-transform: lowercase;
}

.tb-md-codeblock-copy {
  appearance: none;
  border: 1px solid transparent;
  background: transparent;
  color: var(--tb-muted);
  font-family: inherit;
  font-size: 11.5px;
  padding: 2px 7px;
  border-radius: 5px;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}

.tb-md-codeblock-copy:hover {
  background: var(--tb-border-subtle);
  color: var(--tb-text);
}

.tb-md-codeblock pre {
  margin: 0;
  padding: 12px 14px;
  overflow-x: auto;
  font-family: "SF Mono", ui-monospace, Menlo, monospace;
  font-size: 12.5px;
  line-height: 1.6;
  tab-size: 2;
}

.tb-md-codeblock pre code {
  font-family: inherit;
  font-size: inherit;
  background: none;
  border: 0;
  padding: 0;
  color: var(--tb-text);
}

/* Lowlight / highlight.js token colours */
.hljs-keyword, .hljs-selector-tag, .hljs-meta-keyword { color: var(--tb-hl-keyword); }
.hljs-string, .hljs-regexp, .hljs-template-tag { color: var(--tb-hl-string); }
.hljs-number, .hljs-literal, .hljs-symbol { color: var(--tb-hl-number); }
.hljs-title, .hljs-section, .hljs-type, .hljs-class .hljs-title { color: var(--tb-hl-title); }
.hljs-attr, .hljs-attribute, .hljs-property, .hljs-variable, .hljs-built_in { color: var(--tb-hl-attr); }
.hljs-comment, .hljs-quote, .hljs-doctag { color: var(--tb-hl-comment); font-style: italic; }
.hljs-addition { color: var(--tb-hl-addition); }
.hljs-deletion { color: var(--tb-hl-deletion); }

/* Tables */
.tb-md-editor .tableWrapper {
  margin: 0 0 1.25em;
  overflow-x: auto;
  border: 1px solid var(--tb-border);
  border-radius: 8px;
}

.tb-md-editor table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13.5px;
  line-height: 1.55;
  font-variant-numeric: tabular-nums;
}

.tb-md-editor th,
.tb-md-editor td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--tb-border-subtle);
  border-right: 1px solid var(--tb-border-subtle);
  vertical-align: top;
  text-align: left;
}

.tb-md-editor th:last-child,
.tb-md-editor td:last-child {
  border-right: 0;
}

.tb-md-editor tr:last-child td {
  border-bottom: 0;
}

.tb-md-editor th {
  background: var(--tb-surface);
  font-weight: 600;
  color: var(--tb-heading);
}

.tb-md-editor th > p,
.tb-md-editor td > p {
  margin: 0;
}

.tb-md-editor [data-align="center"] { text-align: center; }
.tb-md-editor [data-align="right"] { text-align: right; }

/* Standalone Figure Images */
.tb-md-figure {
  margin: 1.15em 0 1.35em;
  padding: 0;
  border: 1px solid var(--tb-border);
  border-radius: 8px;
  background: var(--tb-surface);
  overflow: hidden;
}

.tb-md-figure-stage {
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--tb-bg) 50%, var(--tb-surface));
  min-height: 80px;
}

.tb-md-figure img {
  display: block;
  max-width: 100%;
  max-height: 540px;
  width: auto;
  height: auto;
  object-fit: contain;
  cursor: zoom-in;
}

.tb-md-figure figcaption {
  padding: 8px 12px;
  border-top: 1px solid var(--tb-border-subtle);
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--tb-text-secondary);
}

.tb-md-img-error {
  padding: 20px 16px;
  font-size: 12.5px;
  color: var(--tb-muted);
  text-align: center;
  font-family: "SF Mono", ui-monospace, Menlo, monospace;
}

/* Inline images (badges etc.) */
.tb-md-editor p img {
  max-width: 100%;
  height: auto;
  vertical-align: middle;
  border-radius: 4px;
}

/* Carousel NodeView */
.tb-md-carousel {
  margin: 1.15em 0 1.45em;
  border: 1px solid var(--tb-border);
  border-radius: 10px;
  background: var(--tb-surface);
  overflow: hidden;
  outline: none;
}

.tb-md-carousel:focus-visible {
  box-shadow: 0 0 0 2px var(--tb-accent);
}

.tb-md-carousel-stage {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 220px;
  background: color-mix(in srgb, var(--tb-bg) 55%, var(--tb-surface));
  padding: 12px;
}

.tb-md-carousel-stage img {
  display: block;
  max-width: 100%;
  max-height: 520px;
  width: auto;
  height: auto;
  object-fit: contain;
  border-radius: 5px;
  cursor: zoom-in;
}

.tb-md-carousel-rich {
  width: 100%;
  padding: 6px 8px;
}

.tb-md-carousel-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border-top: 1px solid var(--tb-border-subtle);
  background: var(--tb-surface);
}

.tb-md-carousel-caption {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--tb-text-secondary);
}

.tb-md-carousel-controls {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  user-select: none;
}

.tb-md-carousel-btn {
  appearance: none;
  width: 26px;
  height: 26px;
  border: 1px solid var(--tb-border);
  border-radius: 6px;
  background: var(--tb-surface-raised);
  color: var(--tb-text);
  font-size: 14px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}

.tb-md-carousel-btn:hover:not(:disabled) {
  border-color: var(--tb-accent);
  color: var(--tb-accent);
}

.tb-md-carousel-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.tb-md-carousel-counter {
  font-family: "SF Mono", ui-monospace, Menlo, monospace;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  color: var(--tb-muted);
  min-width: 38px;
  text-align: center;
}

/* Lightbox overlay for full-resolution image inspection */
.tb-md-lightbox {
  position: fixed;
  inset: 0;
  z-index: 999;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(12, 12, 16, 0.84);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}

.tb-md-lightbox[hidden] {
  display: none;
}

.tb-md-lightbox img {
  max-width: 94vw;
  max-height: 84vh;
  object-fit: contain;
  border-radius: 6px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
  cursor: zoom-out;
}

.tb-md-lightbox-caption {
  margin-top: 12px;
  max-width: 780px;
  font-size: 13px;
  color: #e4e4e7;
  text-align: center;
}

/* In-document search highlights (Tiptap ProseMirror Decoration) */
.tb-find-match {
  background: var(--tb-find-bg);
  border-radius: 2px;
}

.tb-find-match-active {
  background: var(--tb-find-active-bg);
  color: var(--tb-find-active-text);
  border-radius: 2px;
}
`;
