export interface WheelCoordinates {
  deltaY: number;
  clientX: number;
  clientY: number;
}

export type WheelEventFactory = (coordinates: WheelCoordinates) => Event;

export interface AnimationScheduler {
  now(): number;
  requestFrame(callback: (time: number) => void): number;
  cancelFrame(handle: number): void;
}

export interface KineticScroller {
  begin(timeStamp?: number): void;
  move(deltaY: number, timeStamp?: number): void;
  end(timeStamp?: number): void;
  fling(velocityPixelsPerSecond: number): void;
  cancel(): void;
}

const MAX_WHEEL_DELTA_PIXELS = 20;
const MIN_VELOCITY_SAMPLE_MS = 4;
// Android WebView can coalesce touchmove delivery while xterm is painting a
// burst of output. Keep those still-useful samples instead of treating the
// gesture as having no release velocity at all.
const MAX_VELOCITY_SAMPLE_MS = 120;
const MIN_FLING_VELOCITY = 0.04;
const MAX_FLING_VELOCITY = 4;
const DECELERATION_PER_MS = 0.997;
const RELEASE_VELOCITY_DECAY_PER_MS = 0.98;
// MotionEvent delivery and its DOM touch event are not guaranteed to arrive in
// the same frame. A short gap after the last move is transport latency, not a
// user pause, so preserve the measured velocity through that window.
const RELEASE_VELOCITY_GRACE_MS = 120;
const DEFAULT_FRAME_DURATION_MS = 16;
const MAX_FRAME_DURATION_MS = 34;
const VELOCITY_SAMPLE_WEIGHT = 0.7;

export function dispatchWheelDelta(
  wheelTarget: HTMLElement,
  coordinates: WheelCoordinates,
  createWheelEvent: WheelEventFactory = createBrowserWheelEvent
): void {
  let remainingDelta = coordinates.deltaY;
  while (remainingDelta !== 0) {
    const wheelDelta = Math.sign(remainingDelta) * Math.min(
      Math.abs(remainingDelta),
      MAX_WHEEL_DELTA_PIXELS
    );
    wheelTarget.dispatchEvent(
      createWheelEvent({
        ...coordinates,
        deltaY: wheelDelta,
      })
    );
    remainingDelta -= wheelDelta;
  }
}

export function installTouchWheelBridge(
  touchTarget: HTMLElement,
  wheelTarget: HTMLElement,
  createWheelEvent: WheelEventFactory = createBrowserWheelEvent,
  onTap?: () => void,
  scheduler: AnimationScheduler = browserAnimationScheduler
): () => void {
  let lastClientY: number | undefined;
  let movement = 0;
  let coordinates: WheelCoordinates = { deltaY: 0, clientX: 0, clientY: 0 };
  const kineticScroller = createKineticScroller((deltaY) => {
    dispatchWheelDelta(wheelTarget, { ...coordinates, deltaY }, createWheelEvent);
  }, scheduler);

  const onTouchStart = (event: TouchEvent): void => {
    kineticScroller.begin(event.timeStamp);
    if (event.touches.length !== 1) {
      kineticScroller.cancel();
      lastClientY = undefined;
      return;
    }
    event.preventDefault();
    lastClientY = event.touches[0].clientY;
    movement = 0;
  };
  const onTouchMove = (event: TouchEvent): void => {
    if (event.touches.length !== 1 || lastClientY === undefined) {
      kineticScroller.cancel();
      lastClientY = undefined;
      return;
    }
    const touch = event.touches[0];
    const deltaY = touch.clientY - lastClientY;
    lastClientY = touch.clientY;
    movement += Math.abs(deltaY);
    if (deltaY === 0) return;

    event.preventDefault();
    coordinates = { deltaY, clientX: touch.clientX, clientY: touch.clientY };
    kineticScroller.move(deltaY, event.timeStamp);
  };
  const finishTouch = (): void => {
    lastClientY = undefined;
    movement = 0;
  };
  const onTouchEnd = (event: TouchEvent): void => {
    if (lastClientY !== undefined) {
      if (movement < 8) onTap?.();
      kineticScroller.end(event.timeStamp);
    } else {
      kineticScroller.cancel();
    }
    finishTouch();
  };
  const onTouchCancel = (): void => {
    kineticScroller.cancel();
    finishTouch();
  };

  touchTarget.addEventListener("touchstart", onTouchStart, { passive: false });
  touchTarget.addEventListener("touchmove", onTouchMove, { passive: false });
  touchTarget.addEventListener("touchend", onTouchEnd, { passive: true });
  touchTarget.addEventListener("touchcancel", onTouchCancel, { passive: true });

  return () => {
    kineticScroller.cancel();
    touchTarget.removeEventListener("touchstart", onTouchStart);
    touchTarget.removeEventListener("touchmove", onTouchMove);
    touchTarget.removeEventListener("touchend", onTouchEnd);
    touchTarget.removeEventListener("touchcancel", onTouchCancel);
  };
}

export function createKineticScroller(
  onDelta: (deltaY: number) => void,
  scheduler: AnimationScheduler = browserAnimationScheduler
): KineticScroller {
  let frameHandle: number | undefined;
  let lastGestureTime: number | undefined;
  let lastFrameTime: number | undefined;
  let velocity = 0;
  let hasVelocitySample = false;

  const cancelFrame = (): void => {
    if (frameHandle !== undefined) scheduler.cancelFrame(frameHandle);
    frameHandle = undefined;
    lastFrameTime = undefined;
  };

  const cancel = (): void => {
    cancelFrame();
    lastGestureTime = undefined;
    velocity = 0;
    hasVelocitySample = false;
  };

  const scheduleFrame = (): void => {
    if (frameHandle === undefined) frameHandle = scheduler.requestFrame(step);
  };

  const startFling = (nextVelocity: number): void => {
    cancelFrame();
    velocity = clamp(nextVelocity, -MAX_FLING_VELOCITY, MAX_FLING_VELOCITY);
    if (Math.abs(velocity) < MIN_FLING_VELOCITY) {
      velocity = 0;
      return;
    }
    scheduleFrame();
  };

  const step = (time: number): void => {
    frameHandle = undefined;
    const elapsed = lastFrameTime === undefined
      ? DEFAULT_FRAME_DURATION_MS
      : clamp(time - lastFrameTime, 1, MAX_FRAME_DURATION_MS);
    lastFrameTime = time;
    onDelta(velocity * elapsed);
    velocity *= Math.pow(DECELERATION_PER_MS, elapsed);
    if (Math.abs(velocity) >= MIN_FLING_VELOCITY) scheduleFrame();
    else cancel();
  };

  return {
    begin(timeStamp = scheduler.now()): void {
      cancel();
      lastGestureTime = timeStamp;
    },
    move(deltaY: number, timeStamp = scheduler.now()): void {
      cancelFrame();
      if (lastGestureTime !== undefined) {
        const elapsed = timeStamp - lastGestureTime;
        if (elapsed >= MIN_VELOCITY_SAMPLE_MS && elapsed <= MAX_VELOCITY_SAMPLE_MS) {
          const sample = deltaY / elapsed;
          velocity = hasVelocitySample
            ? velocity * (1 - VELOCITY_SAMPLE_WEIGHT) + sample * VELOCITY_SAMPLE_WEIGHT
            : sample;
          hasVelocitySample = true;
        }
      }
      lastGestureTime = timeStamp;
      onDelta(deltaY);
    },
    end(timeStamp = scheduler.now()): void {
      if (!hasVelocitySample || lastGestureTime === undefined) {
        cancel();
        return;
      }
      const releaseDelay = Math.max(0, timeStamp - lastGestureTime);
      const intentionalPause = Math.max(0, releaseDelay - RELEASE_VELOCITY_GRACE_MS);
      const releaseVelocity = velocity * Math.pow(RELEASE_VELOCITY_DECAY_PER_MS, intentionalPause);
      lastGestureTime = undefined;
      startFling(releaseVelocity);
    },
    fling(velocityPixelsPerSecond: number): void {
      lastGestureTime = undefined;
      hasVelocitySample = false;
      startFling(velocityPixelsPerSecond / 1000);
    },
    cancel,
  };
}

const browserAnimationScheduler: AnimationScheduler = {
  now: () => globalThis.performance.now(),
  requestFrame: (callback) => {
    if (typeof globalThis.requestAnimationFrame === "function") {
      return globalThis.requestAnimationFrame(callback);
    }
    return globalThis.setTimeout(
      () => callback(globalThis.performance.now()),
      DEFAULT_FRAME_DURATION_MS
    ) as unknown as number;
  },
  cancelFrame: (handle) => {
    if (typeof globalThis.cancelAnimationFrame === "function") {
      globalThis.cancelAnimationFrame(handle);
    } else {
      globalThis.clearTimeout(handle);
    }
  },
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function createBrowserWheelEvent({ deltaY, clientX, clientY }: WheelCoordinates): Event {
  return new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    deltaMode: WheelEvent.DOM_DELTA_PIXEL,
    deltaY,
  });
}
