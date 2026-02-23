type MouseCallback = (x: number, y: number, button: number) => void;
type MoveCallback = (x: number, y: number, dx: number, dy: number) => void;
type WheelCallback = (delta: number, x: number, y: number) => void;
type KeyCallback = (key: string) => void;

export class InputManager {
  private mousePos = { x: 0, y: 0 };
  private buttonsDown = new Set<number>();
  private keysDown = new Set<string>();
  private dragStart: { x: number; y: number } | null = null;

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
