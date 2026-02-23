import * as THREE from 'three';

export class IsometricCamera {
  private camera: THREE.OrthographicCamera;
  private target = new THREE.Vector3(128, 0, 128);
  private zoomLevel = 50;
  private readonly minZoom = 10;
  private readonly maxZoom = 200;
  private readonly direction = new THREE.Vector3(1, 1, 1).normalize();
  private readonly distance = 500;
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  constructor(width: number, height: number) {
    const aspect = width / height;
    this.camera = new THREE.OrthographicCamera(
      -this.zoomLevel * aspect, this.zoomLevel * aspect,
      this.zoomLevel, -this.zoomLevel,
      0.1, 2000
    );
    this.updateCameraPosition();
  }

  private updateCameraPosition(): void {
    this.camera.position.copy(this.target).addScaledVector(this.direction, this.distance);
    this.camera.lookAt(this.target);
    this.updateFrustum();
  }

  private updateFrustum(): void {
    const aspect = (this.camera.right - this.camera.left) /
                   (this.camera.top - this.camera.bottom) || 1;
    // Recompute based on current aspect and zoom
    const w = window.innerWidth;
    const h = window.innerHeight;
    const a = w / h;
    this.camera.left = -this.zoomLevel * a;
    this.camera.right = this.zoomLevel * a;
    this.camera.top = this.zoomLevel;
    this.camera.bottom = -this.zoomLevel;
    this.camera.updateProjectionMatrix();
  }

  pan(dx: number, dy: number): void {
    // Convert screen delta to world-space movement on the ground plane.
    // Camera looks along (1,1,1), so "right" on screen is roughly along (-1,0,1)
    // and "up" on screen is roughly along (-1,0,-1) adjusted for iso angle.
    const right = new THREE.Vector3(-1, 0, 1).normalize();
    const forward = new THREE.Vector3(-1, 0, -1).normalize();

    const panSpeed = this.zoomLevel * 0.003;
    this.target.addScaledVector(right, dx * panSpeed);
    this.target.addScaledVector(forward, dy * panSpeed);
    this.updateCameraPosition();
  }

  zoom(delta: number, screenX?: number, screenY?: number): void {
    const oldZoom = this.zoomLevel;

    // Zoom toward/away from cursor
    let worldBefore: THREE.Vector3 | null = null;
    if (screenX !== undefined && screenY !== undefined) {
      worldBefore = this.screenToWorld(screenX, screenY);
    }

    this.zoomLevel *= delta > 0 ? 1.1 : 0.9;
    this.zoomLevel = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoomLevel));

    if (worldBefore && screenX !== undefined && screenY !== undefined) {
      this.updateFrustum();
      this.camera.position.copy(this.target).addScaledVector(this.direction, this.distance);
      this.camera.lookAt(this.target);
      const worldAfter = this.screenToWorld(screenX, screenY);
      if (worldAfter) {
        this.target.add(worldBefore.sub(worldAfter));
      }
    }

    this.updateCameraPosition();
  }

  screenToWorld(sx: number, sy: number): THREE.Vector3 | null {
    const ndcX = (sx / window.innerWidth) * 2 - 1;
    const ndcY = -(sy / window.innerHeight) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const hit = new THREE.Vector3();
    const result = this.raycaster.ray.intersectPlane(this.groundPlane, hit);
    return result;
  }

  worldToScreen(pos: THREE.Vector3): THREE.Vector2 {
    const projected = pos.clone().project(this.camera);
    return new THREE.Vector2(
      (projected.x + 1) / 2 * window.innerWidth,
      (-projected.y + 1) / 2 * window.innerHeight
    );
  }

  resize(width: number, height: number): void {
    this.updateFrustum();
  }

  getCamera(): THREE.OrthographicCamera {
    return this.camera;
  }

  getTarget(): THREE.Vector3 {
    return this.target.clone();
  }

  getZoom(): number {
    return this.zoomLevel;
  }
}
