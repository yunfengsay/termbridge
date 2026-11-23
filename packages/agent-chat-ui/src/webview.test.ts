import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createContext, Script } from 'node:vm';

// Execute the actual browser bundle against each native API. This fixture only
// models DOM message effects; layout and scrolling have their own acceptance.
class Element {
  textContent: string | null = '';
  className = '';
  hidden = false;
  open = false;
  disabled = false;
  children: Element[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<(event?: unknown) => void>>();
  scrollTop = 0;
  scrollHeight = 1000;
  clientHeight = 400;
  constructor(readonly tag: string) {}
  get childNodes() { return this.children; }
  appendChild(child: Element) { this.children.push(child); return child; }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  addEventListener(type: string, callback: (event?: unknown) => void) {
    const callbacks = this.listeners.get(type) ?? [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }
  emit(type: string, event?: unknown) { this.listeners.get(type)?.forEach(callback => callback(event)); }
}

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./webview.ts', import.meta.url))],
  bundle: true, write: false, format: 'iife', platform: 'browser',
  target: ['chrome110', 'safari15'], minify: true, logLevel: 'silent',
});
const script = new Script(bundle.outputFiles[0]!.text);
const capabilities = { history: true, send: true, terminal: true, stop: false, attachments: false, approvals: false, questions: false };
const message = (id: string, text: string, seq: number) => ({
  id, role: 'assistant', blocks: [{ type: 'text', text }], timestamp: null, source: 'transcript', seq,
});
const text = (node: Element): string => [node.textContent ?? '', ...node.children.map(text)].join(' ');

for (const platform of ['windows', 'apple', 'android'] as const) {
  test(`${platform}: native messages reach one mounted surface with one ready event`, () => {
    const root = new Element('div');
    const document = {
      getElementById: (id: string) => id === 'chat' ? root : null,
      createElement: (tag: string) => new Element(tag),
      documentElement: { dataset: {} as Record<string, string> },
    };
    const output: Array<Record<string, unknown>> = [];
    const encodings: string[] = [];
    const nativeListeners: Array<(event: { data: unknown }) => void> = [];
    const scope: Record<string, unknown> & { termbridgeChat?: { receive(data: unknown): void } } = { document };
    const postMessage = (data: unknown) => {
      encodings.push(typeof data);
      const decoded = typeof data === 'string' ? JSON.parse(data) : JSON.parse(JSON.stringify(data));
      output.push(decoded);
      if (decoded.op === 'ready') scope.termbridgeChat!.receive({ op: 'theme', theme: 'dark' });
    };
    if (platform === 'windows') scope.chrome = { webview: {
      postMessage,
      addEventListener: (_type: string, listener: (event: { data: unknown }) => void) => nativeListeners.push(listener),
    } };
    if (platform === 'apple') scope.webkit = { messageHandlers: { agentChat: { postMessage } } };
    if (platform === 'android') scope.TermBridgeChat = { postMessage };
    const context = createContext({ window: scope });
    script.runInContext(context);
    assert.deepEqual(output, [{ op: 'ready' }]);
    assert.equal(document.documentElement.dataset.theme, 'dark', 'receive exists before ready is delivered');
    const receiver = scope.termbridgeChat;
    const firstChildren = root.children;
    script.runInContext(context);
    assert.equal(scope.termbridgeChat, receiver);
    assert.equal(root.children, firstChildren);
    assert.equal(output.length, 1);
    assert.equal(nativeListeners.length, platform === 'windows' ? 1 : 0);

    const anchor = new Element('a');
    anchor.setAttribute('href', 'docs/result.md');
    const click = { target: { closest: () => anchor }, preventDefault() {} };
    root.emit('click', click);
    assert.deepEqual(output.at(-1), { op: 'open', url: 'docs/result.md' });
    root.emit('contextmenu', click);
    assert.deepEqual(output.at(-1), { op: 'copy', data: 'docs/result.md' });
    const safeLength = output.length;
    anchor.setAttribute('href', 'javascript:alert(1)');
    root.emit('click', click); root.emit('contextmenu', click);
    assert.equal(output.length, safeLength);

    const snapshot = { op: 'snapshot', generation: 7, status: 'ready', capabilities,
      earlierCursor: 100, messages: [message('m2', '<img src=x onerror=alert(1)>', 2)] };
    if (platform === 'windows') nativeListeners[0]!({ data: snapshot });
    else receiver!.receive(snapshot);
    // Assistant prose is Markdown, so it is built out of elements — but never
    // out of the ones the Agent wrote. The characters are shown; the tag is not
    // constructed, whichever shell is hosting the bundle.
    const prose = root.children[2]!.children[0]!.children[0]!;
    const built = (node: Element): Element[] => [node, ...node.children.flatMap(built)];
    assert.equal(built(prose).some((node) => node.tag === 'img' || node.tag === 'script'), false, 'no markup is constructed');
    assert.ok(text(prose).includes('<img src=x onerror=alert(1)>'), 'the characters are still shown');
    receiver!.receive({ op: 'append', generation: 6, status: 'ready', capabilities, messages: [message('stale', 'stale event', 3)] });
    assert.ok(!text(root).includes('stale event'));
    root.children[1]!.emit('click');
    assert.deepEqual(output.at(-1), { op: 'earlier', generation: 7, cursor: 100 });
    receiver!.receive({ op: 'earlier', generation: 7, atHead: true, messages: [message('m1', 'earlier message', 1)] });
    assert.ok(text(root).includes('earlier message'));
    assert.equal(root.children[1]!.hidden, true);
    receiver!.receive({ op: 'theme', theme: 'light' });
    assert.equal(document.documentElement.dataset.theme, 'light');
    receiver!.receive(JSON.stringify({ op: 'clear' }));
    assert.ok(text(root).includes('earlier message'), 'inbound bridge takes JSON objects, not evaluated strings');
    receiver!.receive({ op: 'clear' });
    assert.equal(root.children[2]!.children.length, 0);
    assert.ok(encodings.every(value => value === (platform === 'android' ? 'string' : 'object')));
  });
}
