type MouseCallback = (x: number, y: number, button: number) => void;
type MoveCallback = (x: number, y: number, dx: number, dy: number) => void;
type WheelCallback = (delta: number, x: number, y: number) => void;
type KeyCallback = (key: string) => void;

export class InputManager {
  private mousePos = { x: 0, y: 0 };
  private buttonsDown = new Set<number>();
  private keysDown = new Set<string>();
  private dragStart: { x: number; y: number } | null = null;

  // Touch state
  private touches = new Map<number, { x: number; y: number }>();
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressFired = false;
  private touchDragStartPos: { x: number; y: number } | null = null;
  private lastPinchDist = 0;
  private twoFingerTouchStart: { time: number; moved: boolean } | null = null;
  private syntheticButtonsDown = new Set<number>();
  private readonly LONG_PRESS_MS = 400;
  private readonly TWO_FINGER_TAP_MS = 200;

  private mouseDownCallbacks: MouseCallback[] = [];
  private mouseUpCallbacks: MouseCallback[] = [];
  private mouseMoveCallbacks: MoveCallback[] = [];
  private wheelCallbacks: WheelCallback[] = [];
  private keyDownCallbacks: KeyCallback[] = [];
  private keyUpCallbacks: KeyCallback[] = [];

  constructor(canvas: HTMLCanvasElement) {
    canvas.addEventListener('mousedown', (e) => {
      this.buttonsDown.add(e.button);
      this.mousePos.x = e.clientX;
      this.mousePos.y = e.clientY;
      this.dragStart = { x: e.clientX, y: e.clientY };
      for (const cb of this.mouseDownCallbacks) cb(e.clientX, e.clientY, e.button);
    });

    canvas.addEventListener('mousemove', (e) => {
      const dx = e.clientX - this.mousePos.x;
      const dy = e.clientY - this.mousePos.y;
      this.mousePos.x = e.clientX;
      this.mousePos.y = e.clientY;
      for (const cb of this.mouseMoveCallbacks) cb(e.clientX, e.clientY, dx, dy);
    });

    canvas.addEventListener('mouseup', (e) => {
      this.buttonsDown.delete(e.button);
      this.dragStart = null;
      for (const cb of this.mouseUpCallbacks) cb(e.clientX, e.clientY, e.button);
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      for (const cb of this.wheelCallbacks) cb(e.deltaY, e.clientX, e.clientY);
    }, { passive: false });

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      if (!e.repeat) {
        this.keysDown.add(e.key.toLowerCase());
        for (const cb of this.keyDownCallbacks) cb(e.key.toLowerCase());
      }
    });

    window.addEventListener('keyup', (e) => {
      this.keysDown.delete(e.key.toLowerCase());
      for (const cb of this.keyUpCallbacks) cb(e.key.toLowerCase());
    });

    // Touch handlers
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        this.touches.set(t.identifier, { x: t.clientX, y: t.clientY });
      }

      if (this.touches.size === 1) {
        const t = e.changedTouches[0];
        this.touchDragStartPos = { x: t.clientX, y: t.clientY };
        this.longPressFired = false;

        // Synthesize button=0 mousedown so SelectionController initializes leftDownPos
        this.syntheticButtonsDown.add(0);
        this.buttonsDown.add(0);
        this.mousePos.x = t.clientX;
        this.mousePos.y = t.clientY;
        this.dragStart = { x: t.clientX, y: t.clientY };
        for (const cb of this.mouseDownCallbacks) cb(t.clientX, t.clientY, 0);

        // Long-press timer fires a right-click command
        this.longPressTimer = setTimeout(() => {
          this.longPressTimer = null;
          this.longPressFired = true;
          const pos = this.mousePos;
          // Fire button=2 down+up (right-click command)
          this.syntheticButtonsDown.add(2);
          this.buttonsDown.add(2);
          for (const cb of this.mouseDownCallbacks) cb(pos.x, pos.y, 2);
          this.syntheticButtonsDown.delete(2);
          this.buttonsDown.delete(2);
          for (const cb of this.mouseUpCallbacks) cb(pos.x, pos.y, 2);
        }, this.LONG_PRESS_MS);

      } else if (this.touches.size === 2) {
        // Cancel single-finger state
        this.cancelLongPress();
        if (this.syntheticButtonsDown.has(0)) {
          this.syntheticButtonsDown.delete(0);
          this.buttonsDown.delete(0);
          for (const cb of this.mouseUpCallbacks) cb(this.mousePos.x, this.mousePos.y, 0);
        }
        this.touchDragStartPos = null;

        // Compute initial pinch distance
        const pts = Array.from(this.touches.values());
        const dx = pts[1].x - pts[0].x;
        const dy = pts[1].y - pts[0].y;
        this.lastPinchDist = Math.sqrt(dx * dx + dy * dy);

        // Start camera pan (button=2 held)
        const centX = (pts[0].x + pts[1].x) / 2;
        const centY = (pts[0].y + pts[1].y) / 2;
        this.mousePos.x = centX;
        this.mousePos.y = centY;
        this.syntheticButtonsDown.add(2);
        this.buttonsDown.add(2);
        for (const cb of this.mouseDownCallbacks) cb(centX, centY, 2);

        this.twoFingerTouchStart = { time: performance.now(), moved: false };
      }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        this.touches.set(t.identifier, { x: t.clientX, y: t.clientY });
      }

      if (this.touches.size === 1) {
        const t = e.changedTouches[0];
        const dx = t.clientX - this.mousePos.x;
        const dy = t.clientY - this.mousePos.y;

        // Cancel long-press if finger moved beyond threshold
        if (this.touchDragStartPos) {
          const totalDx = t.clientX - this.touchDragStartPos.x;
          const totalDy = t.clientY - this.touchDragStartPos.y;
          if (Math.sqrt(totalDx * totalDx + totalDy * totalDy) > 5) {
            this.cancelLongPress();
          }
        }

        this.mousePos.x = t.clientX;
        this.mousePos.y = t.clientY;
        for (const cb of this.mouseMoveCallbacks) cb(t.clientX, t.clientY, dx, dy);

      } else if (this.touches.size === 2) {
        const pts = Array.from(this.touches.values());

        // Pan: fire mousemove with centroid delta
        const centX = (pts[0].x + pts[1].x) / 2;
        const centY = (pts[0].y + pts[1].y) / 2;
        const dx = centX - this.mousePos.x;
        const dy = centY - this.mousePos.y;
        this.mousePos.x = centX;
        this.mousePos.y = centY;
        for (const cb of this.mouseMoveCallbacks) cb(centX, centY, dx, dy);

        // Pinch: zoom
        const ddx = pts[1].x - pts[0].x;
        const ddy = pts[1].y - pts[0].y;
        const newDist = Math.sqrt(ddx * ddx + ddy * ddy);
        const pinchDelta = newDist - this.lastPinchDist;
        if (Math.abs(pinchDelta) > 0.5) {
          // Spreading fingers (pinchDelta > 0) → zoom in (negative wheel delta)
          for (const cb of this.wheelCallbacks) cb(-pinchDelta * 3, centX, centY);
          this.lastPinchDist = newDist;
        }

        if (this.twoFingerTouchStart) {
          this.twoFingerTouchStart.moved = true;
        }
      }
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
      e.preventDefault();
      const prevCount = this.touches.size;
      for (const t of e.changedTouches) {
        this.touches.delete(t.identifier);
      }

      if (prevCount >= 2 && this.touches.size < 2) {
        // Two-finger gesture ended
        const twoFinger = this.twoFingerTouchStart;
        this.twoFingerTouchStart = null;

        // Two-finger tap (short, no movement) = cancel placement (Escape)
        if (twoFinger && !twoFinger.moved && (performance.now() - twoFinger.time) < this.TWO_FINGER_TAP_MS) {
          for (const cb of this.keyDownCallbacks) cb('escape');
          for (const cb of this.keyUpCallbacks) cb('escape');
        }

        // Release pan button
        if (this.syntheticButtonsDown.has(2)) {
          this.syntheticButtonsDown.delete(2);
          this.buttonsDown.delete(2);
          for (const cb of this.mouseUpCallbacks) cb(this.mousePos.x, this.mousePos.y, 2);
        }

        // If one finger remains, restart single-finger tracking
        if (this.touches.size === 1) {
          const [remaining] = this.touches.values();
          this.touchDragStartPos = { x: remaining.x, y: remaining.y };
          this.longPressFired = false;
          this.mousePos.x = remaining.x;
          this.mousePos.y = remaining.y;
          this.syntheticButtonsDown.add(0);
          this.buttonsDown.add(0);
          this.dragStart = { x: remaining.x, y: remaining.y };
          for (const cb of this.mouseDownCallbacks) cb(remaining.x, remaining.y, 0);
        }

      } else if (prevCount === 1 && this.touches.size === 0) {
        // Single-finger lift
        this.cancelLongPress();
        const t = e.changedTouches[0];

        if (!this.longPressFired && this.syntheticButtonsDown.has(0)) {
          this.syntheticButtonsDown.delete(0);
          this.buttonsDown.delete(0);
          this.dragStart = null;
          for (const cb of this.mouseUpCallbacks) cb(t.clientX, t.clientY, 0);
        }
        this.touchDragStartPos = null;
      }
    }, { passive: false });

    canvas.addEventListener('touchcancel', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        this.touches.delete(t.identifier);
      }
      this.cancelLongPress();
      this.touchDragStartPos = null;
      this.twoFingerTouchStart = null;

      if (this.syntheticButtonsDown.has(0)) {
        this.syntheticButtonsDown.delete(0);
        this.buttonsDown.delete(0);
        for (const cb of this.mouseUpCallbacks) cb(this.mousePos.x, this.mousePos.y, 0);
      }
      if (this.syntheticButtonsDown.has(2)) {
        this.syntheticButtonsDown.delete(2);
        this.buttonsDown.delete(2);
        for (const cb of this.mouseUpCallbacks) cb(this.mousePos.x, this.mousePos.y, 2);
      }
      this.dragStart = null;
    }, { passive: false });
  }

  private cancelLongPress(): void {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  onMouseDown(callback: MouseCallback): void {
    this.mouseDownCallbacks.push(callback);
  }

  onMouseUp(callback: MouseCallback): void {
    this.mouseUpCallbacks.push(callback);
  }

  onMouseMove(callback: MoveCallback): void {
    this.mouseMoveCallbacks.push(callback);
  }

  onWheel(callback: WheelCallback): void {
    this.wheelCallbacks.push(callback);
  }

  onKeyDown(callback: KeyCallback): void {
    this.keyDownCallbacks.push(callback);
  }

  onKeyUp(callback: KeyCallback): void {
    this.keyUpCallbacks.push(callback);
  }

  getMousePosition(): { x: number; y: number } {
    return { ...this.mousePos };
  }

  isButtonDown(button: number): boolean {
    return this.buttonsDown.has(button);
  }

  isKeyDown(key: string): boolean {
    return this.keysDown.has(key.toLowerCase());
  }
}
