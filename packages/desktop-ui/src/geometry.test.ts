import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desktopGeometry, sourcePoint, zoomAround } from './geometry.js';
import { DesktopRequests } from './rfbRequests.js';

test('drawing, source viewport and input share the same inverse at every zoom and pan edge', () => {
  for (const [width, height, vw, vh] of [[5120,2880,412,720],[1920,1080,1024,768],[1440,2560,960,540]]) {
    for (const zoom of [1,1.5,2,4,6]) for (const px of [0,-20,-1e6]) for (const py of [0,-80,-1e6]) {
      const g = desktopGeometry(width,height,vw,vh,zoom,px,py);
      const r=g.rect;
      assert.ok(r.x>=0 && r.y>=0 && r.x+r.width<=width && r.y+r.height<=height);
      for (const f of [.1,.5,.9]) {
        const x=r.x+r.width*f, y=r.y+r.height*f;
        const mapped=sourcePoint(g,g.left+x*g.scale,g.top+y*g.scale)!;
        assert.ok(Math.abs(mapped.x-x)<1.001 && Math.abs(mapped.y-y)<1.001);
      }
    }
  }
});
test('pinch keeps its anchor stable and ignores taps in letterboxed margins', () => {
  const g=desktopGeometry(5120,2880,400,700,2,-150,-20);
  const before=sourcePoint(g,200,350)!;
  const next=zoomAround(g,4,200,350), after=sourcePoint(next,200,350)!;
  assert.ok(Math.abs(before.x-after.x)<=1 && Math.abs(before.y-after.y)<=1);
  const fitted=desktopGeometry(5120,2880,400,700);
  assert.equal(sourcePoint(fitted,10,10),undefined);
  assert.equal(sourcePoint(fitted,399,699),undefined);
});
test('zoom requests contain only visible source pixels, with fragmented messages and native inputs preserved', () => {
  const sent: Uint8Array[]=[], views: unknown[]=[];
  let g=desktopGeometry(5120,2880,1000,562,1);
  const filter=new DesktopRequests((p: Uint8Array)=>sent.push(p),()=>g.rect,true,(r: unknown)=>views.push(r));
  const enc=new Uint8Array([2,0,0,1,0,0,0,7]);
  filter.write(enc.subarray(0,3)); assert.equal(sent.length,0); filter.write(enc.subarray(3));
  assert.deepEqual([...sent[0]], [2,0,0,2,0,0,0,0,255,255,255,33]);
  g=desktopGeometry(5120,2880,1000,562,4,-700,-400); filter.refresh();
  const view=new DataView(sent[1].buffer);
  assert.equal(view.getUint16(2),g.rect.x);assert.equal(view.getUint16(4),g.rect.y);
  assert.equal(view.getUint16(6),g.rect.width);assert.equal(view.getUint16(8),g.rect.height);
  assert.ok(g.rect.width*g.rect.height < 5120*2880*.064);
  const input=new Uint8Array([5,1,2,3,4,5]); filter.write(input);assert.deepEqual(sent.at(-1),input);
});

test('panning coalesces forced refreshes until pixels render and preserves immediate pointer input', () => {
  const sent: Uint8Array[] = [];
  let rect = { x: 0, y: 0, width: 640, height: 360 };
  const filter = new DesktopRequests((p: Uint8Array) => sent.push(p), () => rect, true, () => {});
  filter.refresh();
  for (let x = 10; x <= 200; x += 10) { rect = { ...rect, x }; filter.refresh(); }
  assert.equal(sent.length, 1, 'Old viewport refreshes must not pile up during decode or network delay');
  const pointer = new Uint8Array([5, 1, 0, 20, 0, 30]); filter.write(pointer);
  assert.deepEqual(sent.at(-1), pointer);
  // noVNC asks for the next incremental update before asynchronous JPEG painting finishes.
  filter.write(new Uint8Array([3, 1, 0, 0, 0, 0, 0, 1, 0, 1]));
  assert.equal(sent.length, 2);
  filter.rendered();
  assert.equal(sent.length, 3);
  assert.equal(new DataView(sent[2].buffer).getUint16(2), 200, 'Only the newest viewport is requested');
  assert.equal(sent[2][1], 0, 'Full refresh wins over a queued incremental request');
  filter.rendered();
  // An incremental request can be waiting on a static desktop indefinitely.
  // A new viewport must wake it immediately rather than wait for changed pixels.
  filter.write(new Uint8Array([3, 1, 0, 0, 0, 0, 0, 1, 0, 1]));
  const before = sent.length; rect = { ...rect, x: 300 }; filter.refresh();
  assert.equal(sent.length, before + 1);
});

test('frame-rate choices pace requests, coalesce backlog, and never delay input or survive close', () => {
  for (const fps of [10, 20, 30]) {
    let now = 0, id = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const clock = { now: () => now, set: (fn: () => void, ms: number) => { timers.set(++id, { at: now + ms, fn }); return id; }, clear: (key: number) => { timers.delete(key); } };
    const sent: Uint8Array[] = [];
    const filter = new DesktopRequests((bytes: Uint8Array) => sent.push(bytes), () => ({ x: 0, y: 0, width: 800, height: 600 }), true, () => {}, fps, clock);
    filter.refresh(); filter.rendered();
    for (let i = 0; i < 50; i++) filter.update(true);
    assert.equal(sent.length, 1); assert.equal(timers.size, 1);
    const timer = [...timers.values()][0];
    assert.equal(timer.at, 1000 / fps);
    const pointer = new Uint8Array([5, 0, 0, 1, 0, 2]); filter.write(pointer);
    assert.deepEqual(sent.at(-1), pointer);
    now = timer.at; timers.clear(); timer.fn();
    assert.equal(sent.length, 3);
    filter.update(true); assert.equal(timers.size, 1);
    const retired = [...timers.values()][0]; filter.close();
    now += 1000; retired.fn();
    assert.equal(timers.size, 0); assert.equal(sent.length, 3);
  }
});

test('changing rate reschedules immediately without accumulating frames and full refresh wakes idle desktop', () => {
  let now = 0, pending: { fn: () => void; delay: number } | undefined;
  const clock = { now: () => now, set: (fn: () => void, delay: number) => { pending = { fn, delay }; return 1; }, clear: () => { pending = undefined; } };
  const sent: Uint8Array[] = [];
  const filter = new DesktopRequests((bytes: Uint8Array) => sent.push(bytes), () => ({ x: 0, y: 0, width: 800, height: 600 }), false, () => {}, 10, clock);
  filter.refresh(); filter.rendered(); now = 40; filter.update(true);
  assert.equal(pending?.delay, 60);
  filter.setFrameRate(30); assert.equal(sent.length, 2); assert.equal(pending, undefined);
  filter.setFrameRate(10); filter.update(true); assert.equal(pending?.delay, 100);
  filter.refresh(); assert.equal(sent.length, 3); assert.equal(pending, undefined);
  filter.close();
});
