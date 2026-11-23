import assert from "node:assert/strict";
import test from "node:test";

import {
  createKineticScroller,
  installTouchWheelBridge,
  type WheelCoordinates,
} from "./touch-scroll.js";

class FakeElement extends EventTarget {}

function touchEvent(
  type: string,
  touches: Array<{ clientX: number; clientY: number }>,
  timeStamp?: number
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: touches });
  if (timeStamp !== undefined) Object.defineProperty(event, "timeStamp", { value: timeStamp });
  return event;
}

class FakeAnimationScheduler {
  private callbacks = new Map<number, (time: number) => void>();
  private nextHandle = 1;
  private time = 0;

  now = (): number => this.time;

  requestFrame = (callback: (time: number) => void): number => {
    const handle = this.nextHandle++;
    this.callbacks.set(handle, callback);
    return handle;
  };

  cancelFrame = (handle: number): void => {
    this.callbacks.delete(handle);
  };

  advance(milliseconds = 16): void {
    this.time += milliseconds;
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    callbacks.forEach((callback) => callback(this.time));
  }

  get pendingFrames(): number {
    return this.callbacks.size;
  }
}

function fakeWheelEvent(coordinates: WheelCoordinates): Event {
  const event = new Event("wheel", { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    deltaY: { value: coordinates.deltaY },
    clientX: { value: coordinates.clientX },
    clientY: { value: coordinates.clientY },
  });
  return event;
}

test("maps Android touch drags to terminal scroll gestures in the same direction", () => {
  const touchTarget = new FakeElement();
  const wheelTarget = new FakeElement();
  const deltas: number[] = [];
  wheelTarget.addEventListener("wheel", (event) => {
    deltas.push((event as Event & { deltaY: number }).deltaY);
  });

  installTouchWheelBridge(
    touchTarget as unknown as HTMLElement,
    wheelTarget as unknown as HTMLElement,
    fakeWheelEvent
  );

  const touchStart = touchEvent("touchstart", [{ clientX: 20, clientY: 300 }]);
  touchTarget.dispatchEvent(touchStart);
  const upwardMove = touchEvent("touchmove", [{ clientX: 20, clientY: 250 }]);
  touchTarget.dispatchEvent(upwardMove);
  const downwardMove = touchEvent("touchmove", [{ clientX: 20, clientY: 275 }]);
  touchTarget.dispatchEvent(downwardMove);

  assert.deepEqual(deltas, [-20, -20, -10, 20, 5]);
  assert.equal(touchStart.defaultPrevented, true);
  assert.equal(upwardMove.defaultPrevented, true);
  assert.equal(downwardMove.defaultPrevented, true);
});

test("ignores multi-touch gestures and stops forwarding after touchend or disposal", () => {
  const touchTarget = new FakeElement();
  const wheelTarget = new FakeElement();
  const scheduler = new FakeAnimationScheduler();
  let wheelEvents = 0;
  wheelTarget.addEventListener("wheel", () => wheelEvents++);
  const dispose = installTouchWheelBridge(
    touchTarget as unknown as HTMLElement,
    wheelTarget as unknown as HTMLElement,
    fakeWheelEvent,
    undefined,
    scheduler
  );

  touchTarget.dispatchEvent(
    touchEvent("touchstart", [
      { clientX: 20, clientY: 300 },
      { clientX: 40, clientY: 300 },
    ])
  );
  touchTarget.dispatchEvent(touchEvent("touchmove", [{ clientX: 20, clientY: 250 }]));
  touchTarget.dispatchEvent(touchEvent("touchend", []));
  touchTarget.dispatchEvent(touchEvent("touchmove", [{ clientX: 20, clientY: 200 }]));

  touchTarget.dispatchEvent(touchEvent("touchstart", [{ clientX: 20, clientY: 300 }], 0));
  touchTarget.dispatchEvent(touchEvent("touchmove", [{ clientX: 20, clientY: 250 }], 16));
  const wheelEventsBeforeMultiTouch = wheelEvents;
  touchTarget.dispatchEvent(
    touchEvent(
      "touchmove",
      [
        { clientX: 20, clientY: 230 },
        { clientX: 40, clientY: 230 },
      ],
      20
    )
  );
  touchTarget.dispatchEvent(touchEvent("touchend", [], 21));
  scheduler.advance();
  assert.equal(wheelEvents, wheelEventsBeforeMultiTouch);

  dispose();
  touchTarget.dispatchEvent(touchEvent("touchstart", [{ clientX: 20, clientY: 300 }]));
  touchTarget.dispatchEvent(touchEvent("touchmove", [{ clientX: 20, clientY: 250 }]));

  assert.equal(wheelEvents, wheelEventsBeforeMultiTouch);
});

test("preserves tap-to-focus without focusing after a scroll gesture", () => {
  const touchTarget = new FakeElement();
  const wheelTarget = new FakeElement();
  let taps = 0;
  installTouchWheelBridge(
    touchTarget as unknown as HTMLElement,
    wheelTarget as unknown as HTMLElement,
    fakeWheelEvent,
    () => taps++
  );

  touchTarget.dispatchEvent(touchEvent("touchstart", [{ clientX: 20, clientY: 300 }]));
  touchTarget.dispatchEvent(touchEvent("touchend", []));
  assert.equal(taps, 1);

  touchTarget.dispatchEvent(touchEvent("touchstart", [{ clientX: 20, clientY: 300 }]));
  touchTarget.dispatchEvent(touchEvent("touchmove", [{ clientX: 20, clientY: 250 }]));
  touchTarget.dispatchEvent(touchEvent("touchend", []));
  assert.equal(taps, 1);
});

test("continues a fast drag with decelerating momentum and cancels it on the next touch", () => {
  const touchTarget = new FakeElement();
  const wheelTarget = new FakeElement();
  const scheduler = new FakeAnimationScheduler();
  const deltas: number[] = [];
  wheelTarget.addEventListener("wheel", (event) => {
    deltas.push((event as Event & { deltaY: number }).deltaY);
  });

  installTouchWheelBridge(
    touchTarget as unknown as HTMLElement,
    wheelTarget as unknown as HTMLElement,
    fakeWheelEvent,
    undefined,
    scheduler
  );

  touchTarget.dispatchEvent(touchEvent("touchstart", [{ clientX: 20, clientY: 300 }], 0));
  touchTarget.dispatchEvent(touchEvent("touchmove", [{ clientX: 20, clientY: 240 }], 16));
  touchTarget.dispatchEvent(touchEvent("touchend", [], 17));
  const dragEventCount = deltas.length;

  scheduler.advance();
  assert.ok(deltas.length > dragEventCount, "momentum should emit wheel events after touchend");
  assert.ok(deltas.slice(dragEventCount).every((delta) => delta < 0));

  const eventCountBeforeInterruption = deltas.length;
  touchTarget.dispatchEvent(touchEvent("touchstart", [{ clientX: 20, clientY: 240 }], 34));
  assert.equal(scheduler.pendingFrames, 0);
  scheduler.advance();
  assert.equal(deltas.length, eventCountBeforeInterruption);
});

test("keeps momentum when WebView delays touchend after the final move", () => {
  const touchTarget = new FakeElement();
  const wheelTarget = new FakeElement();
  const scheduler = new FakeAnimationScheduler();
  const deltas: number[] = [];
  wheelTarget.addEventListener("wheel", (event) => {
    deltas.push((event as Event & { deltaY: number }).deltaY);
  });

  installTouchWheelBridge(
    touchTarget as unknown as HTMLElement,
    wheelTarget as unknown as HTMLElement,
    fakeWheelEvent,
    undefined,
    scheduler
  );

  touchTarget.dispatchEvent(touchEvent("touchstart", [{ clientX: 20, clientY: 300 }], 0));
  touchTarget.dispatchEvent(touchEvent("touchmove", [{ clientX: 20, clientY: 260 }], 16));
  touchTarget.dispatchEvent(touchEvent("touchmove", [{ clientX: 20, clientY: 220 }], 32));
  touchTarget.dispatchEvent(touchEvent("touchend", [], 144));
  const dragEventCount = deltas.length;

  scheduler.advance();
  assert.ok(deltas.length > dragEventCount, "a delayed Android touchend should still fling");
  assert.ok(deltas.slice(dragEventCount).every((delta) => delta < 0));
});

test("keeps enough fling energy to coast after a delayed Android touchend", () => {
  const scheduler = new FakeAnimationScheduler();
  const deltas: number[] = [];
  const scroller = createKineticScroller((deltaY) => deltas.push(deltaY), scheduler);

  scroller.begin(0);
  scroller.move(-40, 16);
  scroller.move(-40, 32);
  scroller.end(144);
  const dragDistance = Math.abs(deltas.reduce((sum, delta) => sum + delta, 0));

  let frames = 0;
  while (scheduler.pendingFrames > 0 && frames < 200) {
    scheduler.advance();
    frames += 1;
  }
  const coastDistance = Math.abs(deltas.slice(2).reduce((sum, delta) => sum + delta, 0));

  assert.ok(frames >= 60, `fast flick should coast for at least 60 frames, got ${frames}`);
  assert.ok(
    coastDistance >= dragDistance * 4,
    `fast flick should coast at least 4x its drag distance, got ${coastDistance / dragDistance}x`
  );
});

test("derives fling velocity from touch moves coalesced by a busy WebView", () => {
  const scheduler = new FakeAnimationScheduler();
  const deltas: number[] = [];
  const scroller = createKineticScroller((deltaY) => deltas.push(deltaY), scheduler);

  scroller.begin(0);
  scroller.move(-120, 96);
  scroller.end(112);
  scheduler.advance();

  assert.ok(deltas.length > 1, "a 96ms coalesced move should still launch a fling");
  assert.ok(deltas.at(-1)! < 0);
});

test("does not fling when the finger pauses before release", () => {
  const scheduler = new FakeAnimationScheduler();
  const deltas: number[] = [];
  const scroller = createKineticScroller((deltaY) => deltas.push(deltaY), scheduler);

  scroller.begin(0);
  scroller.move(-40, 16);
  scroller.end(416);
  scheduler.advance();

  assert.equal(deltas.length, 1);
  assert.equal(scheduler.pendingFrames, 0);
});

test("decelerates a fling to rest instead of running forever", () => {
  const scheduler = new FakeAnimationScheduler();
  const deltas: number[] = [];
  const scroller = createKineticScroller((deltaY) => deltas.push(deltaY), scheduler);

  scroller.fling(1_000);
  let frames = 0;
  while (scheduler.pendingFrames > 0 && frames < 200) {
    scheduler.advance();
    frames += 1;
  }

  assert.ok(frames > 20 && frames < 120);
  assert.equal(scheduler.pendingFrames, 0);
  assert.ok(deltas.every((delta) => delta > 0));
  assert.ok(deltas[0] > deltas.at(-1)!);
});
