import { InputManager } from './InputManager';
import { IsometricCamera } from '@render/IsometricCamera';

export class CameraController {
  private isDragging = false;

  constructor(
    private input: InputManager,
    private camera: IsometricCamera
  ) {
    // Right-mouse or middle-mouse drag to pan
    input.onMouseDown((_x, _y, button) => {
      if (button === 1 || button === 2) {
        this.isDragging = true;
      }
    });

    input.onMouseUp((_x, _y, button) => {
      if (button === 1 || button === 2) {
        this.isDragging = false;
      }
    });

    input.onMouseMove((_x, _y, dx, dy) => {
      if (this.isDragging) {
        camera.pan(dx, dy);
      }
    });

    // Scroll wheel to zoom
    input.onWheel((delta, x, y) => {
      camera.zoom(delta, x, y);
    });
  }

  update(_dt: number): void {
    // WASD / arrow keys for panning at fixed speed
    const speed = 300;
    let dx = 0;
    let dy = 0;
    if (this.input.isKeyDown('w') || this.input.isKeyDown('arrowup')) dy -= speed;
    if (this.input.isKeyDown('s') || this.input.isKeyDown('arrowdown')) dy += speed;
    if (this.input.isKeyDown('a') || this.input.isKeyDown('arrowleft')) dx -= speed;
    if (this.input.isKeyDown('d') || this.input.isKeyDown('arrowright')) dx += speed;

    if (dx !== 0 || dy !== 0) {
      this.camera.pan(dx * _dt, dy * _dt);
    }
  }
}
