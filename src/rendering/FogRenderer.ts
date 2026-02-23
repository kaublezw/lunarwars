import * as THREE from 'three';
import type { TerrainData } from '@sim/terrain/TerrainData';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';
import { FOG_UNEXPLORED, FOG_EXPLORED } from '@sim/fog/FogOfWarState';

const FOG_Y_OFFSET = 0.15;

// Must match TerrainRenderer's PLATEAU_PAD so fog covers the extended plateau
const PLATEAU_PAD = 25;

export class FogRenderer {
  private mesh: THREE.Mesh;
  private texture: THREE.DataTexture;
  private textureData: Uint8Array;
  private fogState: FogOfWarState;
  private playerTeam: number;

  constructor(terrain: TerrainData, fogState: FogOfWarState, playerTeam: number) {
    this.fogState = fogState;
    this.playerTeam = playerTeam;

    const w = terrain.width;
    const h = terrain.height;
    const totalW = w + PLATEAU_PAD * 2;
    const totalH = h + PLATEAU_PAD * 2;

    const geometry = new THREE.PlaneGeometry(totalW, totalH, totalW - 1, totalH - 1);
    geometry.rotateX(-Math.PI / 2);

    // Displace vertices to match terrain heights + offset
    const posAttr = geometry.getAttribute('position');
    const uvAttr = geometry.getAttribute('uv');

    // The fog grid now includes padding, so texture covers the full extended area.
    // gridWidth/gridHeight = width + 2*padding
    const gw = fogState.gridWidth;
    const gh = fogState.gridHeight;

    for (let i = 0; i < posAttr.count; i++) {
      const lx = posAttr.getX(i);
      const lz = posAttr.getZ(i);
      const wx = lx + w / 2;
      const wz = lz + h / 2;

      const height = terrain.getHeight(wx, wz);
      posAttr.setY(i, height + FOG_Y_OFFSET);

      // Map world coords to grid coords, then to UV [0,1] across the full grid
      const gx = wx + fogState.padding;
      const gz = wz + fogState.padding;
      uvAttr.setXY(i, gx / gw, 1 - gz / gh);
    }
    geometry.computeVertexNormals();

    // Texture covers the full padded grid
    this.textureData = new Uint8Array(gw * gh * 4);
    this.texture = new THREE.DataTexture(
      this.textureData as unknown as BufferSource,
      gw, gh, THREE.RGBAFormat,
    ) as THREE.DataTexture;
    this.texture.flipY = true;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;

    // Initialize all pixels as unexplored (fully black)
    for (let i = 0; i < gw * gh; i++) {
      this.textureData[i * 4 + 0] = 0;   // R
      this.textureData[i * 4 + 1] = 0;   // G
      this.textureData[i * 4 + 2] = 0;   // B
      this.textureData[i * 4 + 3] = 255; // A - fully opaque
    }
    this.texture.needsUpdate = true;

    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.position.set(w / 2, 0, h / 2);
    this.mesh.renderOrder = 100;
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.mesh);
  }

  update(): void {
    const grid = this.fogState.getGrid(this.playerTeam);
    const len = grid.length;

    for (let i = 0; i < len; i++) {
      const state = grid[i];
      const idx = i * 4;

      if (state === FOG_UNEXPLORED) {
        this.textureData[idx + 0] = 0;   // R
        this.textureData[idx + 1] = 0;   // G
        this.textureData[idx + 2] = 4;   // B — very dark blue
        this.textureData[idx + 3] = 255;
      } else if (state === FOG_EXPLORED) {
        this.textureData[idx + 0] = 0;   // R
        this.textureData[idx + 1] = 0;   // G
        this.textureData[idx + 2] = 3;   // B
        this.textureData[idx + 3] = 150;
      } else {
        this.textureData[idx + 0] = 0;
        this.textureData[idx + 1] = 0;
        this.textureData[idx + 2] = 0;
        this.textureData[idx + 3] = 0;   // fully visible
      }
    }

    this.texture.needsUpdate = true;
  }
}
