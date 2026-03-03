import * as THREE from 'three';

export class SceneManager {
  readonly scene: THREE.Scene;
  readonly dirLight: THREE.DirectionalLight;
  readonly ambientLight: THREE.AmbientLight;

  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000004);

    // Directional light (upper-left in isometric view)
    this.dirLight = new THREE.DirectionalLight(0xffffff, 1.9);
    this.dirLight.position.set(70.4, 73.1, 141.3);
    this.dirLight.target.position.set(128, 0, 128);
    this.dirLight.castShadow = true;
    this.dirLight.shadow.mapSize.width = 2048;
    this.dirLight.shadow.mapSize.height = 2048;
    this.dirLight.shadow.camera.near = 1;
    this.dirLight.shadow.camera.far = 500;
    this.dirLight.shadow.camera.left = -150;
    this.dirLight.shadow.camera.right = 150;
    this.dirLight.shadow.camera.top = 150;
    this.dirLight.shadow.camera.bottom = -150;
    this.scene.add(this.dirLight);
    this.scene.add(this.dirLight.target);

    // Dim ambient to keep shadow areas slightly visible
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.2);
    this.scene.add(this.ambientLight);
  }
}
