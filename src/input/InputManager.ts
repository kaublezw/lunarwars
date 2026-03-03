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
  private touchMode: 'idle' | 'pending' | 'pan' | 'longpress' | 'twofinger' = 'idle';
  private touchStartPos: { x: number; y: number } | null = null;
  private isPanHeld = false;
  private secondFingerPos: { x: number; y: number } | null = null;
  private twoFingerCentroid: { x: number; y: number } | null = null;
  private twoFingerMoved = false;
  private twoFingerStartTime = 0;
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly LONG_PRESS_MS = 400;
  private readonly TWO_FINGER_TAP_MS = 400;
  private readonly DRAG_THRESHOLD_PX = 8;

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
    // Single finger: tap = select, drag = camera pan, long-press = right-click command
    // Two fingers:   tap = shift+click (multi-select), drag = camera pan
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const count = e.touches.length;

      if (count === 1) {
        const t = e.touches[0];
        this.touchMode = 'pending';
        this.touchStartPos = { x: t.clientX, y: t.clientY };
        this.mousePos.x = t.clientX;
        this.mousePos.y = t.clientY;

        this.longPressTimer = setTimeout(() => {
          this.longPressTimer = null;
          if (this.touchMode === 'pending') {
            this.touchMode = 'longpress';
            const { x, y } = this.mousePos;
            for (const cb of this.mouseDownCallbacks) cb(x, y, 2);
            for (const cb of this.mouseUpCallbacks) cb(x, y, 2);
          }
        }, this.LONG_PRESS_MS);

      } else if (count === 2) {
        // Cancel any single-finger state
        this.cancelLongPress();
        if (this.isPanHeld) {
          this.isPanHeld = false;
          for (const cb of this.mouseUpCallbacks) cb(this.mousePos.x, this.mousePos.y, 2);
        }

        const t0 = e.touches[0];
        const t1 = e.touches[1];
        const centX = (t0.clientX + t1.clientX) / 2;
        const centY = (t0.clientY + t1.clientY) / 2;
        this.twoFingerCentroid = { x: centX, y: centY };
        this.secondFingerPos = { x: t1.clientX, y: t1.clientY };
        this.twoFingerMoved = false;
        this.twoFingerStartTime = performance.now();
        this.touchMode = 'twofinger';
        this.mousePos.x = centX;
        this.mousePos.y = centY;

        // Start two-finger pan
        this.isPanHeld = true;
        for (const cb of this.mouseDownCallbacks) cb(centX, centY, 2);
      }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const count = e.touches.length;

      if (this.touchMode === 'twofinger' && count >= 2) {
        const t0 = e.touches[0];
        const t1 = e.touches[1];
        const centX = (t0.clientX + t1.clientX) / 2;
        const centY = (t0.clientY + t1.clientY) / 2;
        const dx = centX - this.mousePos.x;
        const dy = centY - this.mousePos.y;
        this.twoFingerCentroid = { x: centX, y: centY };
        this.mousePos.x = centX;
        this.mousePos.y = centY;
        if (!this.twoFingerMoved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
          this.twoFingerMoved = true;
        }
        for (const cb of this.mouseMoveCallbacks) cb(centX, centY, dx, dy);

      } else if ((this.touchMode === 'pending' || this.touchMode === 'pan') && count === 1) {
        const t = e.changedTouches[0];

        // Transition pending → pan once drag threshold is crossed
        let justStartedPan = false;
        if (this.touchMode === 'pending' && this.touchStartPos) {
          const ddx = t.clientX - this.touchStartPos.x;
          const ddy = t.clientY - this.touchStartPos.y;
          if (Math.sqrt(ddx * ddx + ddy * ddy) > this.DRAG_THRESHOLD_PX) {
            this.cancelLongPress();
            this.touchMode = 'pan';
            this.isPanHeld = true;
            this.mousePos.x = t.clientX;
            this.mousePos.y = t.clientY;
            for (const cb of this.mouseDownCallbacks) cb(t.clientX, t.clientY, 2);
            justStartedPan = true;
          }
        }

        if (this.touchMode === 'pan' && !justStartedPan) {
          const dx = t.clientX - this.mousePos.x;
          const dy = t.clientY - this.mousePos.y;
          this.mousePos.x = t.clientX;
          this.mousePos.y = t.clientY;
          for (const cb of this.mouseMoveCallbacks) cb(t.clientX, t.clientY, dx, dy);
        }
      }
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
      e.preventDefault();
      const remainingCount = e.touches.length;

      if (this.touchMode === 'twofinger') {
        if (remainingCount <= 1) {
          const elapsed = performance.now() - this.twoFingerStartTime;
          const wasTap = !this.twoFingerMoved && elapsed < this.TWO_FINGER_TAP_MS;

          if (this.isPanHeld) {
            this.isPanHeld = false;
            for (const cb of this.mouseUpCallbacks) cb(this.mousePos.x, this.mousePos.y, 2);
          }

          if (wasTap && this.secondFingerPos) {
            // Shift+click at second finger position to add to selection
            const { x, y } = this.secondFingerPos;
            this.keysDown.add('shift');
            for (const cb of this.keyDownCallbacks) cb('shift');
            for (const cb of this.mouseDownCallbacks) cb(x, y, 0);
            for (const cb of this.mouseUpCallbacks) cb(x, y, 0);
            this.keysDown.delete('shift');
            for (const cb of this.keyUpCallbacks) cb('shift');
          }

          this.touchMode = 'idle';
          this.secondFingerPos = null;
          this.twoFingerCentroid = null;
        }
        return;
      }

      if (remainingCount === 0) {
        this.cancelLongPress();

        if (this.touchMode === 'pending') {
          // Tap: fire left click to select
          const t = e.changedTouches[0];
          for (const cb of this.mouseDownCallbacks) cb(t.clientX, t.clientY, 0);
          for (const cb of this.mouseUpCallbacks) cb(t.clientX, t.clientY, 0);
        } else if (this.touchMode === 'pan' && this.isPanHeld) {
          // End pan
          const t = e.changedTouches[0];
          this.isPanHeld = false;
          for (const cb of this.mouseUpCallbacks) cb(t.clientX, t.clientY, 2);
        }
        // 'longpress': already fired, nothing to do

        this.touchMode = 'idle';
        this.touchStartPos = null;
      }
    }, { passive: false });

    canvas.addEventListener('touchcancel', (e) => {
      e.preventDefault();
      this.cancelLongPress();
      if (this.isPanHeld) {
        this.isPanHeld = false;
        for (const cb of this.mouseUpCallbacks) cb(this.mousePos.x, this.mousePos.y, 2);
      }
      this.touchMode = 'idle';
      this.touchStartPos = null;
      this.secondFingerPos = null;
      this.twoFingerCentroid = null;
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
