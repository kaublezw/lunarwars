type MouseCallback = (x: number, y: number, button: number) => void;
type MoveCallback = (x: number, y: number, dx: number, dy: number) => void;
type WheelCallback = (delta: number, x: number, y: number) => void;
type KeyCallback = (key: string) => void;

export class InputManager {
  private mousePos = { x: 0, y: 0 };
  private buttonsDown = new Set<number>();
  private keysDown = new Set<string>();
  private dragStart: { x: number; y: number } | null = null;

  // Touch state machine
  // idle: no active touch
  // one_pending: single finger down, waiting to determine tap vs drag
  // one_drag: single finger dragging (fires button 0 for selection box)
  // two_pending: two fingers down, determining pan vs pinch
  // two_pan: two-finger camera pan (locked, no zoom)
  // two_pinch: two-finger pinch zoom (locked, no pan)
  private touchMode: 'idle' | 'one_pending' | 'one_drag' | 'two_pending' | 'two_pan' | 'two_pinch' = 'idle';
  private touchStartPos: { x: number; y: number } | null = null;
  private isPanHeld = false;
  private _lastInputWasTouch = false;

  // Double-tap detection
  private lastTapTime = 0;
  private lastTapPos: { x: number; y: number } | null = null;
  private readonly DOUBLE_TAP_MS = 300;
  private readonly DOUBLE_TAP_RADIUS = 30;

  // Two-finger gesture state
  private twoFingerStartCentroid: { x: number; y: number } | null = null;
  private twoFingerStartSpread = 0;
  private twoFingerLastSpread = 0;

  // Thresholds
  private readonly DRAG_THRESHOLD_PX = 8;
  private readonly TWO_FINGER_MOVE_THRESHOLD = 8;
  private readonly TWO_FINGER_PINCH_THRESHOLD = 15;

  private mouseDownCallbacks: MouseCallback[] = [];
  private mouseUpCallbacks: MouseCallback[] = [];
  private mouseMoveCallbacks: MoveCallback[] = [];
  private wheelCallbacks: WheelCallback[] = [];
  private keyDownCallbacks: KeyCallback[] = [];
  private keyUpCallbacks: KeyCallback[] = [];
  private doubleTapCallbacks: MouseCallback[] = [];

  constructor(canvas: HTMLCanvasElement) {
    canvas.addEventListener('mousedown', (e) => {
      this._lastInputWasTouch = false;
      this.buttonsDown.add(e.button);
      this.mousePos.x = e.clientX;
      this.mousePos.y = e.clientY;
      this.dragStart = { x: e.clientX, y: e.clientY };
      for (const cb of this.mouseDownCallbacks) cb(e.clientX, e.clientY, e.button);
    });

    canvas.addEventListener('mousemove', (e) => {
      this._lastInputWasTouch = false;
      const dx = e.clientX - this.mousePos.x;
      const dy = e.clientY - this.mousePos.y;
      this.mousePos.x = e.clientX;
      this.mousePos.y = e.clientY;
      for (const cb of this.mouseMoveCallbacks) cb(e.clientX, e.clientY, dx, dy);
    });

    canvas.addEventListener('mouseup', (e) => {
      this._lastInputWasTouch = false;
      this.buttonsDown.delete(e.button);
      this.dragStart = null;
      for (const cb of this.mouseUpCallbacks) cb(e.clientX, e.clientY, e.button);
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      for (const cb of this.wheelCallbacks) cb(e.deltaY, e.clientX, e.clientY);
    }, { passive: false });

    canvas.addEventListener('dblclick', (e) => {
      this._lastInputWasTouch = false;
      for (const cb of this.doubleTapCallbacks) cb(e.clientX, e.clientY, e.button);
    });

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

    // --- Touch handlers ---
    // Single finger: tap = left click (context-sensitive), drag = selection box
    // Double tap: select all visible units of same type
    // Two fingers: drag = camera pan (locked), pinch = zoom (locked)

    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this._lastInputWasTouch = true;
      const count = e.touches.length;

      if (count === 1 && this.touchMode === 'idle') {
        const t = e.touches[0];
        this.touchMode = 'one_pending';
        this.touchStartPos = { x: t.clientX, y: t.clientY };
        this.mousePos.x = t.clientX;
        this.mousePos.y = t.clientY;

      } else if (count >= 2) {
        // Cancel any one-finger state
        this.cancelOneFinger();

        const t0 = e.touches[0];
        const t1 = e.touches[1];
        const centX = (t0.clientX + t1.clientX) / 2;
        const centY = (t0.clientY + t1.clientY) / 2;
        const spread = this.fingerSpread(t0, t1);

        this.twoFingerStartCentroid = { x: centX, y: centY };
        this.twoFingerStartSpread = spread;
        this.twoFingerLastSpread = spread;
        this.mousePos.x = centX;
        this.mousePos.y = centY;
        this.touchMode = 'two_pending';
      }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const count = e.touches.length;

      // --- Single finger ---
      if (this.touchMode === 'one_pending' && count === 1) {
        const t = e.touches[0];
        if (this.touchStartPos) {
          const dx = t.clientX - this.touchStartPos.x;
          const dy = t.clientY - this.touchStartPos.y;
          if (Math.sqrt(dx * dx + dy * dy) > this.DRAG_THRESHOLD_PX) {
            // Transition to one-finger drag (selection box)
            this.touchMode = 'one_drag';
            for (const cb of this.mouseDownCallbacks) cb(this.touchStartPos.x, this.touchStartPos.y, 0);
            this.mousePos.x = t.clientX;
            this.mousePos.y = t.clientY;
          }
        }

      } else if (this.touchMode === 'one_drag' && count === 1) {
        const t = e.touches[0];
        const dx = t.clientX - this.mousePos.x;
        const dy = t.clientY - this.mousePos.y;
        this.mousePos.x = t.clientX;
        this.mousePos.y = t.clientY;
        for (const cb of this.mouseMoveCallbacks) cb(t.clientX, t.clientY, dx, dy);

      // --- Two fingers ---
      } else if (this.touchMode === 'two_pending' && count >= 2) {
        const t0 = e.touches[0];
        const t1 = e.touches[1];
        const centX = (t0.clientX + t1.clientX) / 2;
        const centY = (t0.clientY + t1.clientY) / 2;
        const spread = this.fingerSpread(t0, t1);

        const centroidDx = centX - this.twoFingerStartCentroid!.x;
        const centroidDy = centY - this.twoFingerStartCentroid!.y;
        const centroidDist = Math.sqrt(centroidDx * centroidDx + centroidDy * centroidDy);
        const spreadDelta = Math.abs(spread - this.twoFingerStartSpread);

        if (centroidDist > this.TWO_FINGER_MOVE_THRESHOLD && centroidDist >= spreadDelta) {
          // Pan wins — lock to pan
          this.touchMode = 'two_pan';
          this.isPanHeld = true;
          this.mousePos.x = centX;
          this.mousePos.y = centY;
          for (const cb of this.mouseDownCallbacks) cb(centX, centY, 2);
        } else if (spreadDelta > this.TWO_FINGER_PINCH_THRESHOLD) {
          // Pinch wins — lock to zoom
          this.touchMode = 'two_pinch';
          this.twoFingerLastSpread = spread;
        }

      } else if (this.touchMode === 'two_pan' && count >= 2) {
        const t0 = e.touches[0];
        const t1 = e.touches[1];
        const centX = (t0.clientX + t1.clientX) / 2;
        const centY = (t0.clientY + t1.clientY) / 2;
        const dx = centX - this.mousePos.x;
        const dy = centY - this.mousePos.y;
        this.mousePos.x = centX;
        this.mousePos.y = centY;
        for (const cb of this.mouseMoveCallbacks) cb(centX, centY, dx, dy);

      } else if (this.touchMode === 'two_pinch' && count >= 2) {
        const t0 = e.touches[0];
        const t1 = e.touches[1];
        const spread = this.fingerSpread(t0, t1);
        const centX = (t0.clientX + t1.clientX) / 2;
        const centY = (t0.clientY + t1.clientY) / 2;
        const delta = this.twoFingerLastSpread - spread; // positive = pinch in = zoom out
        if (Math.abs(delta) > 1) {
          for (const cb of this.wheelCallbacks) cb(delta, centX, centY);
          this.twoFingerLastSpread = spread;
        }
      }
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
      e.preventDefault();
      const remainingCount = e.touches.length;

      if (this.touchMode === 'one_pending' && remainingCount === 0) {
        // Single-finger tap
        const t = e.changedTouches[0];
        const tapX = t.clientX;
        const tapY = t.clientY;

        // Check for double-tap
        const now = performance.now();
        if (
          this.lastTapPos &&
          now - this.lastTapTime < this.DOUBLE_TAP_MS &&
          Math.abs(tapX - this.lastTapPos.x) < this.DOUBLE_TAP_RADIUS &&
          Math.abs(tapY - this.lastTapPos.y) < this.DOUBLE_TAP_RADIUS
        ) {
          // Double-tap detected
          for (const cb of this.doubleTapCallbacks) cb(tapX, tapY, 0);
          this.lastTapTime = 0;
          this.lastTapPos = null;
        } else {
          // Single tap: fire mouseMove (for cursor update) then left click
          for (const cb of this.mouseMoveCallbacks) cb(tapX, tapY, 0, 0);
          for (const cb of this.mouseDownCallbacks) cb(tapX, tapY, 0);
          for (const cb of this.mouseUpCallbacks) cb(tapX, tapY, 0);
          this.lastTapTime = now;
          this.lastTapPos = { x: tapX, y: tapY };
        }

        this.touchMode = 'idle';
        this.touchStartPos = null;

      } else if (this.touchMode === 'one_drag' && remainingCount === 0) {
        // End one-finger drag (selection box)
        const t = e.changedTouches[0];
        for (const cb of this.mouseUpCallbacks) cb(t.clientX, t.clientY, 0);
        this.touchMode = 'idle';
        this.touchStartPos = null;

      } else if (
        (this.touchMode === 'two_pan' || this.touchMode === 'two_pinch' || this.touchMode === 'two_pending') &&
        remainingCount <= 1
      ) {
        // End two-finger gesture
        if (this.isPanHeld) {
          this.isPanHeld = false;
          for (const cb of this.mouseUpCallbacks) cb(this.mousePos.x, this.mousePos.y, 2);
        }
        this.touchMode = 'idle';
        this.touchStartPos = null;
        this.twoFingerStartCentroid = null;
      }
    }, { passive: false });

    canvas.addEventListener('touchcancel', (e) => {
      e.preventDefault();
      this.cancelOneFinger();
      if (this.isPanHeld) {
        this.isPanHeld = false;
        for (const cb of this.mouseUpCallbacks) cb(this.mousePos.x, this.mousePos.y, 2);
      }
      this.touchMode = 'idle';
      this.touchStartPos = null;
      this.twoFingerStartCentroid = null;
    }, { passive: false });
  }

  /** Cancel any one-finger gesture cleanly. */
  private cancelOneFinger(): void {
    if (this.touchMode === 'one_drag') {
      // End the drag (fire mouseUp for selection box cleanup)
      for (const cb of this.mouseUpCallbacks) cb(this.mousePos.x, this.mousePos.y, 0);
    }
    this.touchMode = 'idle';
    this.touchStartPos = null;
  }

  private fingerSpread(t0: Touch, t1: Touch): number {
    const dx = t1.clientX - t0.clientX;
    const dy = t1.clientY - t0.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  isLastInputTouch(): boolean {
    return this._lastInputWasTouch;
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

  onDoubleTap(callback: MouseCallback): void {
    this.doubleTapCallbacks.push(callback);
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
