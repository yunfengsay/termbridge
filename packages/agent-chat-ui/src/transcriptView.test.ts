import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentChatCapabilities, AgentChatMessage, AgentChatBlock } from '@termbridge/agent-chat';
import { buildRows, canRetry, deliveryLabel, toolSummary } from './model.js';
import { createTranscriptView, type ViewDocument, type ViewElement } from './transcriptView.js';
import { readShellMessage } from './bridge.js';

// A minimal stand-in for the DOM, so the renderer's structure is checked without
// a browser. It records exactly what the real renderer would build.
interface StubElement extends ViewElement {
  tag: string;
  children: StubElement[];
  attributes: Record<string, string>;
  listeners: Record<string, Array<() => void>>;
  /** Fires what a browser would fire, so scroll intent can be expressed. */
  emit(type: string): void;
}

function stubDocument(): ViewDocument & { create(tag: string): StubElement } {
  const create = (tag: string): StubElement => {
    const node: StubElement = {
      tag,
      textContent: '',
      className: '',
      hidden: false,
      children: [],
      attributes: {},
      listeners: {},
      get childNodes() { return { length: node.children.length }; },
      appendChild(child) { node.children.push(child as StubElement); return child; },
      setAttribute(name, value) { node.attributes[name] = value; },
      replaceChildren(...children) { node.children = children as StubElement[]; },
      addEventListener(type, listener) { (node.listeners[type] ??= []).push(listener); },
      emit(type) { for (const listener of node.listeners[type] ?? []) listener(); },
      scrollTop: 0,
      scrollHeight: 1_000,
      clientHeight: 400,
    };
    return node;
  };
  return { createElement: create, create };
}

function text(node: StubElement): string {
  return [node.textContent ?? '', ...node.children.map(text)].join(' ').trim();
}

/** Every element the renderer built, so a test can assert what was never built. */
function tree(node: StubElement): StubElement[] {
  return [node, ...node.children.flatMap(tree)];
}

const capabilities: AgentChatCapabilities = {
  history: true, send: true, stop: false, attachments: false,
  approvals: false, questions: false, terminal: true,
};

const message = (id: string, role: AgentChatMessage['role'], blocks: AgentChatBlock[], seq = 1): AgentChatMessage =>
  ({ id, role, blocks, timestamp: null, source: 'transcript', seq });

test('a tool call and its result collapse into one card that reports the real outcome', () => {
  const rows = buildRows([
    message('m1', 'assistant', [{ type: 'tool-call', name: 'Bash', input: '{"command":"pnpm test"}', callId: 'c1' }], 1),
    message('m2', 'tool', [{ type: 'tool-result', output: '2 failing', isError: true, callId: 'c1' }], 2),
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    kind: 'tool', id: 'm1:0', name: 'Bash', summary: 'pnpm test',
    input: '{"command":"pnpm test"}', output: '2 failing', state: 'failed', truncated: false,
  });
});

test('a tool call with no recorded result is running only while the turn is', () => {
  const call = [message('m1', 'assistant', [{ type: 'tool-call', name: 'Read', input: '{"file_path":"a.ts"}', callId: 'c1' }])];

  const live = buildRows(call, { status: 'working' });
  assert.equal(live[0]!.kind === 'tool' && live[0]!.state, 'running');
  assert.equal(live[0]!.kind === 'tool' && live[0]!.summary, 'a.ts');

  // The turn is over and the provider never recorded a result. That is unknown,
  // not success, and not a spinner that outlives the turn it belonged to.
  const historic = buildRows(call, { status: 'ready' });
  assert.equal(historic[0]!.kind === 'tool' && historic[0]!.state, 'unknown');
});

test('an interruption is a quiet status row, and prose keeps its own bubble', () => {
  const rows = buildRows([
    message('m1', 'user', [{ type: 'text', text: '继续' }]),
    message('m2', 'system', [{ type: 'text', text: 'Conversation interrupted' }]),
    message('m3', 'assistant', [{ type: 'text', text: '好的' }, { type: 'text', text: '   ' }]),
  ]);
  assert.deepEqual(rows.map((row) => row.kind), ['prose', 'status', 'prose']);
  assert.equal(rows[0]!.kind === 'prose' && rows[0]!.role, 'user');
  assert.equal(rows[2]!.kind === 'prose' && rows[2]!.role, 'assistant');
});

test('markup an agent wrote is shown, never built', () => {
  const doc = stubDocument();
  const root = doc.create('div');
  const view = createTranscriptView({ document: doc, root });
  view.snapshot({
    generation: 1, status: 'ready', capabilities,
    messages: [message('m1', 'assistant', [{
      type: 'text',
      text: '<img src=x onerror=alert(1)>\n\n<script>alert(2)</script>\n\n[点这里](javascript:alert(3)) 和 [真链接](https://example.com/a)',
    }])],
  });
  const list = root.children[2] as StubElement;
  const nodes = tree(list);

  // Nothing dangerous was constructed. This is the property that matters: the
  // renderer only ever creates elements it chose itself.
  assert.equal(nodes.some((node) => node.tag === 'img' || node.tag === 'script'), false);
  assert.equal(nodes.some((node) => Object.keys(node.attributes).some((name) => name.startsWith('on'))), false);

  // The characters the model wrote are still readable rather than swallowed.
  const shown = text(list);
  assert.equal(shown.includes('<img src=x onerror=alert(1)>'), true);
  assert.equal(shown.includes('<script>alert(2)</script>'), true);

  // A javascript: target keeps its words and becomes no link at all; only the
  // openable one is an anchor, and the shell still re-checks it on click.
  const anchors = nodes.filter((node) => node.tag === 'a');
  assert.deepEqual(anchors.map((node) => node.attributes.href), ['https://example.com/a']);
  assert.equal(shown.includes('点这里'), true);
});

test('assistant markdown becomes real structure, and a user prompt stays literal', () => {
  const doc = stubDocument();
  const root = doc.create('div');
  const view = createTranscriptView({ document: doc, root });
  view.snapshot({
    generation: 1, status: 'ready', capabilities,
    messages: [
      message('m1', 'user', [{ type: 'text', text: '用 **星号** 的原样' }]),
      message('m2', 'assistant', [{
        type: 'text',
        text: [
          '## 标题',
          '',
          '- 一级',
          '  - 嵌套',
          '',
          '| 列 | 值 |',
          '| --- | ---: |',
          '| a | 1 |',
          '',
          '```py',
          'def f():',
          '    return 1',
          '```',
          '',
          '行内 `code` 与 **粗体**。',
        ].join('\n'),
      }], 2),
    ],
  });
  const nodes = tree(root.children[2] as StubElement);
  const tags = new Set(nodes.map((node) => node.tag));
  for (const tag of ['h2', 'ul', 'li', 'table', 'th', 'td', 'pre', 'code', 'strong']) {
    assert.equal(tags.has(tag), true, `expected the renderer to build <${tag}>`);
  }
  // Nested list really is nested, not flattened into one level.
  const lists = nodes.filter((node) => node.tag === 'ul');
  assert.equal(lists.length, 2);
  // The fence is one text node, so copying it returns the source verbatim.
  const code = nodes.find((node) => node.tag === 'code' && (node.textContent ?? '').includes('def f()'))!;
  assert.equal(code.textContent, 'def f():\n    return 1');
  // The user's own asterisks were not turned into emphasis.
  const userRow = (root.children[2] as StubElement).children[0]!;
  assert.equal(text(userRow), '用 **星号** 的原样');
});

test('a product-internal citation marker is hidden, and lookalike text in code is not', () => {
  const doc = stubDocument();
  const root = doc.create('div');
  const view = createTranscriptView({ document: doc, root });
  view.snapshot({
    generation: 1, status: 'ready', capabilities,
    messages: [message('m1', 'assistant', [{
      type: 'text',
      text: '结果<oai-mem-citation id="7"/>如上。\n\n```ts\nconst a: Array<oai-mem-citation> = [];\n```\n\n比较 a < b 与 `<T>`。',
    }])],
  });
  const shown = text(root.children[2] as StubElement);
  assert.equal(shown.includes('oai-mem-citation id'), false);
  assert.equal(shown.includes('结果如上。'), true);
  // Code is content: the same characters inside a fence survive untouched.
  assert.equal(shown.includes('Array<oai-mem-citation>'), true);
  // Ordinary prose that merely looks like a tag is not eaten either.
  assert.equal(shown.includes('a < b'), true);
  assert.equal(shown.includes('<T>'), true);
});

test('a late event from the previous conversation is discarded', () => {
  const doc = stubDocument();
  const root = doc.create('div');
  const view = createTranscriptView({ document: doc, root });
  view.snapshot({ generation: 2, status: 'ready', capabilities, messages: [message('m1', 'user', [{ type: 'text', text: '当前会话' }])] });
  view.append({ generation: 1, status: 'ready', capabilities, messages: [message('m9', 'assistant', [{ type: 'text', text: '旧订阅的事件' }])] });
  assert.equal(text(root.children[2] as StubElement).includes('旧订阅的事件'), false);
  view.append({ generation: 2, status: 'ready', capabilities, messages: [message('m2', 'assistant', [{ type: 'text', text: '当前事件' }], 2)] });
  assert.equal(text(root.children[2] as StubElement).includes('当前事件'), true);
});

test('a replayed message after a reconnect is not shown twice', () => {
  const doc = stubDocument();
  const root = doc.create('div');
  const view = createTranscriptView({ document: doc, root });
  const reply = message('m2', 'assistant', [{ type: 'text', text: '同一条回复' }], 2);
  view.snapshot({ generation: 1, status: 'ready', capabilities, messages: [message('m1', 'user', [{ type: 'text', text: '问题' }]), reply] });
  view.append({ generation: 1, status: 'ready', capabilities, messages: [reply] });
  assert.equal(view.rows.filter((row) => row.kind === 'prose' && row.text === '同一条回复').length, 1);
});

test('a disabled capability is explained instead of silently doing nothing', () => {
  const doc = stubDocument();
  const root = doc.create('div');
  const view = createTranscriptView({ document: doc, root });
  view.snapshot({
    generation: 1, status: 'ready',
    capabilities: { ...capabilities, send: false, degraded: '这个 Agent 正在终端里等待确认' },
    messages: [message('m1', 'user', [{ type: 'text', text: '嗨' }])],
  });
  const notice = root.children[0] as StubElement;
  assert.equal(notice.hidden, false);
  assert.equal(notice.textContent, '这个 Agent 正在终端里等待确认');
  view.clear();
  assert.equal(notice.hidden, true);
});

test('earlier history is offered only while more exists, and prepends in order', () => {
  const doc = stubDocument();
  const root = doc.create('div');
  const asked: number[] = [];
  const view = createTranscriptView({ document: doc, root, onLoadEarlier: (cursor) => asked.push(cursor) });
  view.snapshot({
    generation: 1, status: 'ready', capabilities, earlierCursor: 4_096, historyMenu: true,
    messages: [message('m5', 'user', [{ type: 'text', text: '最新' }], 5)],
  });
  const button = root.children[1] as StubElement;
  // The control lives at the top of the history, so the reader has to go
  // looking; it is not sitting on the opening screen.
  assert.equal(button.hidden, true);
  // Scrolling up off the end is the ask; arriving at the top then shows it.
  root.scrollTop = 500;
  root.emit('scroll');
  root.scrollTop = 0;
  root.emit('scroll');
  assert.equal(button.hidden, false);
  button.listeners.click?.forEach((listener) => listener());
  assert.deepEqual(asked, [4_096]);

  view.prepend({ generation: 1, messages: [message('m1', 'user', [{ type: 'text', text: '更早' }], 1)], atHead: true });
  assert.equal(button.hidden, true);
  assert.deepEqual(
    view.rows.map((row) => (row.kind === 'prose' ? row.text : row.kind)),
    ['更早', '最新'],
  );
});

test('the scroll position is kept when the reader scrolled up, and reset on a new conversation', () => {
  const doc = stubDocument();
  const root = doc.create('div');
  const view = createTranscriptView({ document: doc, root });
  view.snapshot({ generation: 1, status: 'ready', capabilities, messages: [message('m1', 'user', [{ type: 'text', text: 'a' }])] });
  // The end of a 1000px list in a 400px box, clamped the way a browser does.
  assert.equal(root.scrollTop, 600);

  // The reader scrolls up. That is an intent, and it is what the view follows.
  root.scrollTop = 10;
  root.emit('scroll');
  view.append({ generation: 1, status: 'working', capabilities, messages: [message('m2', 'assistant', [{ type: 'text', text: 'b' }], 2)] });
  assert.equal(root.scrollTop, 10);

  // A size change — a keyboard opening, a rotation — must not override it.
  view.reflow();
  assert.equal(root.scrollTop, 10);

  root.scrollTop = 600;
  root.emit('scroll');
  view.append({ generation: 1, status: 'working', capabilities, messages: [message('m3', 'assistant', [{ type: 'text', text: 'c' }], 3)] });
  assert.equal(root.scrollTop, 600);
});

test('a size change after the list was laid out at zero height still reaches the end', () => {
  const doc = stubDocument();
  const root = doc.create('div');
  // The surface was created hidden: no height, nothing scrollable yet.
  root.scrollHeight = 0; root.clientHeight = 0; root.scrollTop = 0;
  const view = createTranscriptView({ document: doc, root });
  view.snapshot({ generation: 1, status: 'ready', capabilities, messages: [message('m1', 'user', [{ type: 'text', text: 'a' }])] });
  assert.equal(root.scrollTop, 0);

  // Now it is shown and laid out for real. The follow intent from opening the
  // conversation is honoured then, rather than being lost to the first layout.
  root.scrollHeight = 1_000; root.clientHeight = 400;
  view.reflow();
  assert.equal(root.scrollTop, 600);
});

test('the earlier control appears at the top of the history, not on the first screen', () => {
  const doc = stubDocument();
  const root = doc.create('div');
  const view = createTranscriptView({ document: doc, root });
  view.snapshot({ generation: 1, status: 'ready', capabilities, earlierCursor: 7, historyMenu: true,
    messages: [message('m1', 'user', [{ type: 'text', text: 'a' }])] });
  const earlier = root.children[1]!;
  // Opening a conversation lands at its latest turn, so the control is not
  // sitting across the first thing the reader sees.
  assert.equal(earlier.hidden, true);

  root.scrollTop = 500;
  root.emit('scroll');
  root.scrollTop = 0;
  root.emit('scroll');
  assert.equal(earlier.hidden, false);

  // And nothing fetched on its own along the way.
  let asked = 0;
  const view2 = createTranscriptView({ document: doc, root: doc.create('div'), onLoadEarlier: () => { asked += 1; } });
  view2.snapshot({ generation: 1, status: 'ready', capabilities, earlierCursor: 7, historyMenu: true, messages: [] });
  assert.equal(asked, 0);
});

test('a page too short to scroll still reaches history, but only when asked', () => {
  const doc = stubDocument();
  const root = doc.create('div');
  // One short message: nothing to scroll, and the reader is already at the top.
  root.scrollHeight = 300; root.clientHeight = 400; root.scrollTop = 0;
  const asked: number[] = [];
  const view = createTranscriptView({ document: doc, root, onLoadEarlier: (cursor) => asked.push(cursor) });
  view.snapshot({ generation: 1, status: 'ready', capabilities, earlierCursor: 512, historyMenu: true,
    messages: [message('m1', 'user', [{ type: 'text', text: '短' }])] });
  const earlier = root.children[1]!;

  // Not parked across the only message, and nothing requested on its own.
  assert.equal(earlier.hidden, true);
  assert.deepEqual(asked, []);

  // The shell's explicit entry is how a page that cannot scroll reaches back.
  view.revealHistory();
  assert.equal(earlier.hidden, false);
  assert.deepEqual(asked, [512]);
});

test('a shell with no history menu keeps an inline way back', () => {
  const doc = stubDocument();
  const root = doc.create('div');
  // The short unscrollable page again, but in a shell that has no menu of its
  // own — Windows, macOS and iOS all listen for the inline control and nothing
  // else. Hiding it there would leave history permanently unreachable.
  root.scrollHeight = 300; root.clientHeight = 400; root.scrollTop = 0;
  const asked: number[] = [];
  const view = createTranscriptView({ document: doc, root, onLoadEarlier: (cursor) => asked.push(cursor) });
  view.snapshot({ generation: 1, status: 'ready', capabilities, earlierCursor: 512,
    messages: [message('m1', 'user', [{ type: 'text', text: '短' }])] });
  const earlier = root.children[1] as StubElement;

  // Present and compact — not the full-width button that used to sit on the
  // opening screen — and still nothing fetched without a tap.
  assert.equal(earlier.hidden, false);
  assert.deepEqual(asked, []);
  earlier.listeners.click?.forEach((listener) => listener());
  assert.deepEqual(asked, [512]);
});

test('delivery states read honestly and only an outright rejection may be retried', () => {
  assert.equal(deliveryLabel('accepted'), '正在发送…');
  assert.match(deliveryLabel('delivered'), /等待/);
  assert.match(deliveryLabel('observed'), /收到/);
  assert.match(deliveryLabel('uncertain'), /未知/);
  assert.deepEqual(
    (['accepted', 'delivered', 'observed', 'uncertain', 'failed'] as const).map(canRetry),
    [false, false, false, false, true],
  );
  assert.equal(toolSummary('Bash', ''), 'Bash');
  assert.equal(toolSummary('Grep', '{"pattern":"TODO"}'), 'TODO');
  assert.equal(toolSummary('X', 'not json'), 'not json');
});

test('an unrecognized shell message is ignored rather than acted on', () => {
  assert.equal(readShellMessage({ op: 'nope' }), undefined);
  assert.equal(readShellMessage(null), undefined);
  assert.equal(readShellMessage('clear'), undefined);
  assert.deepEqual(readShellMessage({ op: 'clear' }), { op: 'clear' });
});

test('an early tool result is reconciled into one call card', () => {
  const rows = buildRows([
    message('result', 'tool', [{ type: 'tool-result', callId: 'c1', output: 'done' }], 1),
    message('call', 'assistant', [{ type: 'tool-call', callId: 'c1', name: 'Bash', input: 'pwd' }], 2),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind === 'tool' && rows[0].name, 'Bash');
  assert.equal(rows[0]?.kind === 'tool' && rows[0].output, 'done');
});

test('a redraw keeps a tool card expanded, and an event that changes nothing rebuilds nothing', () => {
  const doc = stubDocument(), root = doc.create('div');
  const view = createTranscriptView({ document: doc, root });
  view.snapshot({ generation: 1, status: 'working', capabilities,
    messages: [message('call', 'assistant', [{ type: 'tool-call', name: 'Bash', input: 'pwd', callId: 'c1' }])] });
  const list = root.children[2]!;
  const node = list.children[0]!;
  assert.equal(node.attributes['data-state'], 'running');
  node.open = true;

  // Nothing about this call changed, so the same element stays in place and the
  // user keeps their expansion, selection and scroll position.
  view.append({ generation: 1, status: 'working', capabilities, messages: [] });
  assert.equal(list.children[0], node);
  assert.equal(list.children[0]!.open, true);

  // The turn ended with no result recorded. That is a real change, so the card
  // is rebuilt — but it reopens, because the user had opened it.
  view.append({ generation: 1, status: 'ready', capabilities, messages: [] });
  assert.equal(list.children[0]!.attributes['data-state'], 'unknown');
  assert.equal(list.children[0]!.open, true);
  assert.match(text(list.children[0]!), /没有记录结果/);

  view.append({ generation: 1, status: 'ready', capabilities,
    messages: [message('result', 'tool', [{ type: 'tool-result', output: 'done', callId: 'c1' }], 2)] });
  assert.equal(list.children[0]!.open, true);
  assert.equal(list.children[0]!.attributes['data-state'], 'done');
  assert.match(text(list.children[0]!), /done/);
});

test('a global working flag does not mark an older unanswered call as running', () => {
  const doc = stubDocument(), root = doc.create('div');
  const view = createTranscriptView({ document: doc, root });
  view.snapshot({
    generation: 1, status: 'working', capabilities,
    messages: [
      message('call', 'assistant', [{ type: 'tool-call', name: 'Bash', input: 'pwd', callId: 'c1' }]),
      message('later', 'assistant', [{ type: 'text', text: '换个做法' }], 2),
    ],
  });
  // The transcript moved past that call without ever recording a result. The
  // Agent being busy now says nothing about it.
  const card = (root.children[2] as StubElement).children[0]!;
  assert.equal(card.attributes['data-state'], 'unknown');
});

test('a restated call updates its card; identical arguments under a new id do not', () => {
  const restated = buildRows([
    message('m1', 'assistant', [{ type: 'tool-call', name: 'Bash', input: '{"command":"ls"}', callId: 'c1' }]),
    message('m2', 'assistant', [{ type: 'tool-call', name: 'Bash', input: '{"command":"ls -al"}', callId: 'c1' }], 2),
    message('m3', 'tool', [{ type: 'tool-result', output: 'ok', callId: 'c1' }], 3),
  ], { status: 'ready' });
  // One invocation, one card, carrying the latest arguments and its result.
  assert.equal(restated.filter((row) => row.kind === 'tool').length, 1);
  assert.equal(restated[0]!.kind === 'tool' && restated[0]!.state, 'done');
  assert.equal(restated[0]!.kind === 'tool' && restated[0]!.summary, 'ls -al');

  const twins = buildRows([
    message('m1', 'assistant', [{ type: 'tool-call', name: 'Bash', input: '{"command":"ls"}', callId: 'c1' }]),
    message('m2', 'assistant', [{ type: 'tool-call', name: 'Bash', input: '{"command":"ls"}', callId: 'c2' }], 2),
  ], { status: 'working' });
  // Same tool, same arguments, two real invocations. Both stay.
  assert.equal(twins.filter((row) => row.kind === 'tool').length, 2);
});

test('tool arguments are formatted as JSON, copied verbatim, and never built as markup', () => {
  const doc = stubDocument(), root = doc.create('div');
  const view = createTranscriptView({ document: doc, root });
  const args = '{"command":"echo <script>alert(1)</script>","flags":[1,true,null],"nested":{"k":"v"}}';
  view.snapshot({
    generation: 1, status: 'ready', capabilities,
    messages: [message('m1', 'assistant', [{ type: 'tool-call', name: 'Bash', input: args, callId: 'c1' }])],
  });
  const nodes = tree(root.children[2] as StubElement);
  const pre = nodes.find((node) => (node.className ?? '').includes('tb-json'))!;

  // Formatted: keys, strings, numbers and punctuation are separate spans.
  assert.ok(nodes.some((node) => (node.className ?? '') === 'tb-json-key'));
  assert.ok(nodes.some((node) => (node.className ?? '') === 'tb-json-number'));
  // Copying gives back exactly what the Agent sent, not the re-indented form.
  assert.equal(pre.attributes['data-copy'], args);
  // The script tag inside a value is text, never an element.
  assert.equal(nodes.some((node) => node.tag === 'script'), false);
  assert.ok(text(pre).includes('<script>alert(1)</script>'));
});

test('a non-JSON argument is shown exactly as it arrived', () => {
  const doc = stubDocument(), root = doc.create('div');
  const view = createTranscriptView({ document: doc, root });
  const raw = 'ls -al /tmp   # not json {broken';
  view.snapshot({
    generation: 1, status: 'ready', capabilities,
    messages: [message('m1', 'assistant', [{ type: 'tool-call', name: 'Bash', input: raw, callId: 'c1' }])],
  });
  const nodes = tree(root.children[2] as StubElement);
  // No guessing: it falls back to a plain code block carrying the original.
  assert.equal(nodes.some((node) => (node.className ?? '').includes('tb-json')), false);
  assert.ok(nodes.some((node) => node.textContent === raw));
});

test('a repeated out-of-order result and a restated call both stay one card', () => {
  // Two results arrive before their call is decoded. Same invocation, one card.
  const outOfOrder = buildRows([
    message('m1', 'tool', [{ type: 'tool-result', output: 'first', callId: 'c1' }]),
    message('m2', 'tool', [{ type: 'tool-result', output: 'second', callId: 'c1' }], 2),
    message('m3', 'assistant', [{ type: 'tool-call', name: 'Bash', input: '{"command":"ls"}', callId: 'c1' }], 3),
  ], { status: 'ready' });
  const cards = outOfOrder.filter((row) => row.kind === 'tool');
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.kind === 'tool' && cards[0]!.state, 'done');

  // A call restated in a later message is the newest word on it, so while the
  // conversation is working that card is running — not stranded as unknown
  // because the card kept the first message's id.
  const restated = buildRows([
    message('m1', 'assistant', [{ type: 'tool-call', name: 'Bash', input: '{"command":"A"}', callId: 'c1' }]),
    message('m2', 'assistant', [{ type: 'tool-call', name: 'Bash', input: '{"command":"B"}', callId: 'c1' }], 2),
  ], { status: 'working' });
  const one = restated.filter((row) => row.kind === 'tool');
  assert.equal(one.length, 1);
  assert.equal(one[0]!.kind === 'tool' && one[0]!.state, 'running');
  assert.equal(one[0]!.kind === 'tool' && one[0]!.summary, 'B');
  // The card keeps the id it was created with, so the DOM is not rebuilt.
  assert.equal(one[0]!.id, 'm1:0');
});

test('a send receipt rides on its own message and never on a shared band', () => {
  const doc = stubDocument(), root = doc.create('div');
  const view = createTranscriptView({ document: doc, root });
  view.snapshot({ generation: 1, status: 'ready', capabilities, messages: [message('m1', 'user', [{ type: 'text', text: '第一条' }])] });
  const notice = root.children[0] as StubElement;

  view.setPendingSend({ id: 'req-1', text: '跑一下测试', state: 'accepted' });
  const list = () => root.children[2] as StubElement;
  const pending = () => list().children.at(-1)!;
  assert.match(text(pending()), /跑一下测试/);
  assert.match(text(pending()), /发送中/);
  // The shared strip says nothing about this send.
  assert.equal(notice.hidden, true);

  view.setPendingSend({ id: 'req-1', text: '跑一下测试', state: 'delivered' });
  assert.equal(pending().attributes['data-state'], 'delivered');

  view.setPendingSend({ id: 'req-1', text: '跑一下测试', state: 'uncertain', error: '结果未知，请在终端确认' });
  assert.equal(pending().attributes['data-state'], 'uncertain');
  assert.match(text(pending()), /结果未知，请在终端确认/);

  // Once the Agent's own record carries it, the local row gives way to the real
  // message instead of the two standing side by side.
  view.append({ generation: 1, status: 'ready', capabilities,
    messages: [message('m2', 'user', [{ type: 'text', text: '跑一下测试' }], 2)] });
  view.setPendingSend(undefined);
  assert.equal(list().children.some((child) => (child.className ?? '').includes('tb-pending')), false);
  assert.equal(list().children.filter((child) => text(child).includes('跑一下测试')).length, 1);
});

test('a receipt merges by messageId, in either arrival order', () => {
  for (const order of ['observed-first', 'message-first'] as const) {
    const doc = stubDocument(), root = doc.create('div');
    const view = createTranscriptView({ document: doc, root });
    view.snapshot({ generation: 1, status: 'ready', capabilities, messages: [] });
    const list = () => root.children[2] as StubElement;
    const pendingRows = () => list().children.filter((child) => (child.className ?? '').includes('tb-pending'));
    const recorded = message('m-real', 'user', [{ type: 'text', text: '跑一下测试' }], 2);

    if (order === 'observed-first') {
      view.setPendingSend({ id: 'req-1', text: '跑一下测试', state: 'observed', messageId: 'm-real' });
      // The Host says it observed the send, but its record has not arrived yet.
      // The local row has to stay, or the message disappears from view.
      assert.equal(pendingRows().length, 1, order);
      view.append({ generation: 1, status: 'ready', capabilities, messages: [recorded] });
    } else {
      view.append({ generation: 1, status: 'ready', capabilities, messages: [recorded] });
      view.setPendingSend({ id: 'req-1', text: '跑一下测试', state: 'observed', messageId: 'm-real' });
    }

    // Once both are in, exactly one copy is shown.
    assert.equal(pendingRows().length, 0, order);
    assert.equal(list().children.filter((child) => text(child).includes('跑一下测试')).length, 1, order);
  }
});

test('a repeated receipt for the same request does not add a second row', () => {
  const doc = stubDocument(), root = doc.create('div');
  const view = createTranscriptView({ document: doc, root });
  view.snapshot({ generation: 1, status: 'ready', capabilities, messages: [] });
  view.setPendingSend({ id: 'req-1', text: '重复回执', state: 'delivered' });
  view.setPendingSend({ id: 'req-1', text: '重复回执', state: 'delivered' });
  view.setPendingSend({ id: 'req-1', text: '重复回执', state: 'observed', messageId: 'not-here-yet' });
  const list = root.children[2] as StubElement;
  assert.equal(list.children.filter((child) => (child.className ?? '').includes('tb-pending')).length, 1);
});

test('an identical earlier message does not swallow a new send', () => {
  const doc = stubDocument(), root = doc.create('div');
  const view = createTranscriptView({ document: doc, root });
  view.snapshot({ generation: 1, status: 'ready', capabilities,
    messages: [message('m-old', 'user', [{ type: 'text', text: '再来一次' }])] });
  // Same words, different send. Nothing may merge them: only the messageId the
  // Host reported for *this* request can retire the local row.
  view.setPendingSend({ id: 'req-2', text: '再来一次', state: 'delivered' });
  const list = root.children[2] as StubElement;
  assert.equal(list.children.filter((child) => text(child).includes('再来一次')).length, 2);
});

test('the same text sent twice stays two messages', () => {
  const doc = stubDocument(), root = doc.create('div');
  const view = createTranscriptView({ document: doc, root });
  view.snapshot({
    generation: 1, status: 'ready', capabilities,
    messages: [
      message('m1', 'user', [{ type: 'text', text: '再来一次' }]),
      message('m2', 'user', [{ type: 'text', text: '再来一次' }], 2),
    ],
  });
  // Identical text is not evidence of a duplicate: these are two real sends.
  const list = root.children[2] as StubElement;
  assert.equal(list.children.filter((child) => text(child).includes('再来一次')).length, 2);
});

test('paged history survives status changes and a live append', () => {
  const doc = stubDocument(), root = doc.create('div');
  const view = createTranscriptView({ document: doc, root, windowLimit: 2 });
  const m = (n: number) => message(String(n), 'user', [{ type: 'text', text: String(n) }], n);
  view.snapshot({ generation: 1, status: 'ready', capabilities, earlierCursor: 3, messages: [m(3), m(4)] });
  view.prepend({ generation: 1, messages: [m(1), m(2)], atHead: true });
  view.append({ generation: 1, status: 'working', capabilities, messages: [] });
  // Four messages plus the working indicator the status now asks for.
  assert.equal(view.rows.filter((row) => row.kind !== 'working').length, 4);
  view.append({ generation: 1, status: 'working', capabilities, messages: [m(5)] });
  assert.equal(view.rows.filter((row) => row.kind !== 'working').length, 5);
  assert.equal(view.rows[0]!.id, '1:0');
  assert.equal(root.children[1]!.hidden, true);
});
