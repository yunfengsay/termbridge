import assert from "node:assert/strict";
import test from "node:test";

import {
  activateTranscriptSnapshot,
  updateTranscriptLines,
  updateTranscriptNodes,
} from "./transcript-reconcile.js";

class FakeLine {
  parentElement: FakeTranscript | null = null;
  readonly dataset: { transcriptKey?: string };

  constructor(
    readonly text: string,
    key = text,
    readonly height = 20,
  ) {
    this.dataset = { transcriptKey: key };
  }

  get offsetTop(): number {
    const index = this.parentElement?.nodes.indexOf(this) ?? -1;
    if (index < 0) return -this.height;
    return this.parentElement!.nodes.slice(0, index).reduce((total, line) => total + line.height, 0);
  }

  get offsetHeight(): number {
    return this.height;
  }

  remove(): void {
    this.parentElement?.remove(this);
  }
}

class FakeTranscript {
  readonly nodes: FakeLine[] = [];
  scrollTop = 0;
  mutations = 0;

  constructor(private readonly visible: () => boolean = () => true) {}

  get clientHeight(): number {
    return this.visible() ? 40 : 0;
  }

  get children(): ArrayLike<FakeLine> {
    return this.nodes;
  }

  get firstElementChild(): FakeLine | null {
    return this.nodes[0] ?? null;
  }

  get scrollHeight(): number {
    return this.visible() ? this.nodes.reduce((total, line) => total + line.height, 0) : 0;
  }

  insertBefore(line: FakeLine, reference: FakeLine | null): FakeLine {
    const oldIndex = this.nodes.indexOf(line);
    if (oldIndex >= 0) this.nodes.splice(oldIndex, 1);
    const nextIndex = reference ? this.nodes.indexOf(reference) : this.nodes.length;
    this.nodes.splice(nextIndex < 0 ? this.nodes.length : nextIndex, 0, line);
    line.parentElement = this;
    this.mutations += 1;
    return line;
  }

  remove(line: FakeLine): void {
    const index = this.nodes.indexOf(line);
    if (index < 0) return;
    this.nodes.splice(index, 1);
    line.parentElement = null;
    this.mutations += 1;
  }
}

test("activates an initially hidden transcript before following its first snapshot to the bottom", () => {
  let active = false;
  const transcript = new FakeTranscript(() => active);
  const host = {
    classList: {
      add(name: string): void {
        if (name === "mobile-reading") active = true;
      },
    },
  };

  activateTranscriptSnapshot(
    host as unknown as HTMLElement,
    transcript as unknown as HTMLElement,
    [line("a"), line("b"), line("c"), line("d"), line("e")] as unknown as HTMLElement[],
  );

  assert.equal(active, true);
  assert.equal(transcript.scrollTop, 60);
});

function line(text: string, height = 20): FakeLine {
  return new FakeLine(text, text, height);
}

function update(transcript: FakeTranscript, lines: FakeLine[]): void {
  updateTranscriptLines(
    transcript as unknown as HTMLElement,
    lines as unknown as HTMLElement[],
  );
}

test("reuses the overlapping transcript window and preserves a visible scroll anchor", () => {
  const transcript = new FakeTranscript();
  const initial = [line("old"), line("a"), line("b"), line("c"), line("d"), line("e"), line("f")];
  initial.forEach((entry) => transcript.insertBefore(entry, null));
  transcript.scrollTop = 20;
  transcript.mutations = 0;

  update(transcript, [line("a"), line("b"), line("c"), line("d"), line("e"), line("f"), line("new")]);

  assert.deepEqual(transcript.nodes.map((entry) => entry.text), ["a", "b", "c", "d", "e", "f", "new"]);
  assert.equal(transcript.nodes[0], initial[1], "the overlapping lines should keep their DOM identity");
  assert.equal(transcript.nodes[1], initial[2]);
  assert.equal(transcript.scrollTop, 0, "the formerly visible line a should remain at the same viewport offset");
  assert.equal(transcript.mutations, 2, "only the expired head and new tail should mutate the DOM");
});

test("does not mutate or move the viewport for an identical snapshot", () => {
  const transcript = new FakeTranscript();
  const initial = [line("a"), line("b"), line("c"), line("d"), line("e"), line("f"), line("g")];
  initial.forEach((entry) => transcript.insertBefore(entry, null));
  transcript.scrollTop = 20;
  transcript.mutations = 0;

  update(transcript, [line("a"), line("b"), line("c"), line("d"), line("e"), line("f"), line("g")]);

  assert.deepEqual(transcript.nodes, initial);
  assert.equal(transcript.scrollTop, 20);
  assert.equal(transcript.mutations, 0);
});

test("continues following the bottom while a live agent appends output", () => {
  const transcript = new FakeTranscript();
  [line("a"), line("b"), line("c"), line("d")].forEach((entry) => transcript.insertBefore(entry, null));
  transcript.scrollTop = 40;

  update(transcript, [line("a"), line("b"), line("c"), line("d"), line("e")]);

  assert.equal(transcript.scrollTop, 60);
});

test("keeps the viewport anchored when a changing status tail reflows", () => {
  const transcript = new FakeTranscript();
  [line("a"), line("b"), line("c"), line("working")].forEach((entry) => transcript.insertBefore(entry, null));
  transcript.scrollTop = 40;

  update(transcript, [line("a"), line("b"), line("c"), line("still working with a wrapped status", 40)]);

  assert.equal(
    transcript.scrollTop,
    40,
    "replacing a mutable tail must not pull an otherwise stable viewport to the new bottom",
  );
});

test("an exact patch keeps the intended repeated-line identity and viewport anchor", () => {
  const transcript = new FakeTranscript();
  const firstRepeat = line("repeat");
  const marker = line("marker");
  const visibleRepeat = line("repeat");
  const tail = line("tail");
  const later = [line("later-1"), line("later-2"), line("later-3")];
  [firstRepeat, marker, visibleRepeat, tail, ...later].forEach((entry) => transcript.insertBefore(entry, null));
  transcript.scrollTop = 40;

  const appended = line("new");
  updateTranscriptNodes(
    transcript as unknown as HTMLElement,
    [marker, visibleRepeat, tail, ...later, appended] as unknown as HTMLElement[],
  );

  assert.equal(transcript.nodes[1], visibleRepeat);
  assert.equal(transcript.scrollTop, 20, "the visible repeated line must remain at the same viewport offset");
});
