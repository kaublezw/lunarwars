import * as THREE from 'three';

export class SceneManager {
  readonly scene: THREE.Scene;

  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000010);

    // Harsh directional light from screen-top
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(128 - 60, 60, 128 - 40);
    dirLight.target.position.set(128, 0, 128);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 1;
    dirLight.shadow.camera.far = 500;
    dirLight.shadow.camera.left = -150;
    dirLight.shadow.camera.right = 150;
    dirLight.shadow.camera.top = 150;
    dirLight.shadow.camera.bottom = -150;
    this.scene.add(dirLight);
    this.scene.add(dirLight.target);

    // Dim ambient to keep shadow areas slightly visible
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.2);
    this.scene.add(ambientLight);
  }
}
