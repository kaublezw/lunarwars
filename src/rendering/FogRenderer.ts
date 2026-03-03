import * as THREE from 'three';
import type { TerrainData } from '@sim/terrain/TerrainData';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';
import { FOG_UNEXPLORED, FOG_EXPLORED } from '@sim/fog/FogOfWarState';
import { VOXEL_SIZE } from '@sim/data/VoxelModels';

const FOG_Y_OFFSET = 0.15;

// Fog mesh extends beyond terrain edges so border areas are covered
const PLATEAU_PAD = 25;

// Vertex shader: displaces fog plane to terrain height via heightmap
const fogVertexShader = /* glsl */ `
  uniform sampler2D heightmap;
  uniform float voxelSize;
  uniform float fogYOffset;
  uniform vec2 terrainSize;
  uniform float fogPadding;
  uniform vec2 fogGridSize;
  uniform vec2 mapOffset;

  varying vec2 vFogUV;

  void main() {
    vec2 worldXZ = position.xz + mapOffset;

    vec2 heightUV = worldXZ / terrainSize;
    float tileHeight = texture2D(heightmap, heightUV).r * 255.0;

    vec3 displaced = position;
    displaced.y = tileHeight * voxelSize + fogYOffset;

    vFogUV = vec2(
      (worldXZ.x + fogPadding) / fogGridSize.x,
      1.0 - (worldXZ.y + fogPadding) / fogGridSize.y
    );

    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`;

// Fragment shader: writes fog RGBA directly (no blending) to render target
const fogFragmentShader = /* glsl */ `
  uniform sampler2D fogTexture;
  varying vec2 vFogUV;

  void main() {
    gl_FragColor = texture2D(fogTexture, vFogUV);
  }
`;

// Composite: fullscreen quad that blends the fog RT over the scene
const compositeVertexShader = /* glsl */ `
  varying vec2 vUV;
  void main() {
    vUV = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const compositeFragmentShader = /* glsl */ `
  uniform sampler2D fogRT;
  varying vec2 vUV;
  void main() {
    gl_FragColor = texture2D(fogRT, vUV);
  }
`;

export class FogRenderer {
  private fogScene: THREE.Scene;
  private fogMesh: THREE.Mesh;
  private renderTarget: THREE.WebGLRenderTarget;
  private compositeQuad: THREE.Mesh;
  private texture: THREE.DataTexture;
  private heightmapTexture: THREE.DataTexture;
  private textureData: Uint8Array;
  private fogState: FogOfWarState;
  private playerTeam: number;
  private rtSize = new THREE.Vector2();
  private tempSize = new THREE.Vector2();
  private tempColor = new THREE.Color();

  constructor(terrain: TerrainData, fogState: FogOfWarState, playerTeam: number) {
    this.fogState = fogState;
    this.playerTeam = playerTeam;

    const w = terrain.width;
    const h = terrain.height;
    const totalW = w + PLATEAU_PAD * 2;
    const totalH = h + PLATEAU_PAD * 2;

    // Build heightmap texture from terrain tile heights
    const heightData = new Uint8Array(w * h);
    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        heightData[z * w + x] = terrain.getTileHeight(x, z);
      }
    }
    this.heightmapTexture = new THREE.DataTexture(
      heightData as unknown as BufferSource, w, h,
      THREE.RedFormat, THREE.UnsignedByteType,
    );
    this.heightmapTexture.minFilter = THREE.NearestFilter;
    this.heightmapTexture.magFilter = THREE.NearestFilter;
    this.heightmapTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.heightmapTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.heightmapTexture.needsUpdate = true;

    // Fog plane matches terrain resolution for sharp edge conformance
    const geometry = new THREE.PlaneGeometry(totalW, totalH, totalW - 1, totalH - 1);
    geometry.rotateX(-Math.PI / 2);

    // Fog RGBA data texture
    const gw = fogState.gridWidth;
    const gh = fogState.gridHeight;

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

    for (let i = 0; i < gw * gh; i++) {
      this.textureData[i * 4 + 0] = 0;   // R
      this.textureData[i * 4 + 1] = 0;   // G
      this.textureData[i * 4 + 2] = 0;   // B
      this.textureData[i * 4 + 3] = 255; // A - fully opaque
    }
    this.texture.needsUpdate = true;

    // Fog mesh renders to its own RT with depth test (closest fragment wins)
    // and no blending (RGBA written directly so alpha is preserved exactly)
    const fogMaterial = new THREE.ShaderMaterial({
      uniforms: {
        fogTexture: { value: this.texture },
        heightmap: { value: this.heightmapTexture },
        voxelSize: { value: VOXEL_SIZE },
        fogYOffset: { value: FOG_Y_OFFSET },
        terrainSize: { value: new THREE.Vector2(w, h) },
        fogPadding: { value: fogState.padding },
        fogGridSize: { value: new THREE.Vector2(gw, gh) },
        mapOffset: { value: new THREE.Vector2(w / 2, h / 2) },
      },
      vertexShader: fogVertexShader,
      fragmentShader: fogFragmentShader,
      depthTest: true,
      depthWrite: true,
      side: THREE.FrontSide,
      blending: THREE.NoBlending,
    });

    this.fogMesh = new THREE.Mesh(geometry, fogMaterial);
    this.fogMesh.position.set(w / 2, 0, h / 2);

    // Private scene containing only the fog mesh (rendered to RT)
    this.fogScene = new THREE.Scene();
    this.fogScene.add(this.fogMesh);

    // Render target (resized dynamically to match canvas)
    this.renderTarget = new THREE.WebGLRenderTarget(1, 1);

    // Composite fullscreen quad: samples the fog RT and alpha-blends over scene
    const compositeGeometry = new THREE.PlaneGeometry(2, 2);
    const compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        fogRT: { value: this.renderTarget.texture },
      },
      vertexShader: compositeVertexShader,
      fragmentShader: compositeFragmentShader,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.FrontSide,
    });

    this.compositeQuad = new THREE.Mesh(compositeGeometry, compositeMaterial);
    this.compositeQuad.frustumCulled = false;
    this.compositeQuad.renderOrder = 100;

    // Render the fog scene to the RT right before the composite quad draws
    const self = this;
    this.compositeQuad.onBeforeRender = function (renderer, _scene, camera) {
      // Resize RT to match canvas pixel dimensions
      renderer.getSize(self.tempSize);
      const pr = renderer.getPixelRatio();
      const rtW = Math.floor(self.tempSize.x * pr);
      const rtH = Math.floor(self.tempSize.y * pr);
      if (self.rtSize.x !== rtW || self.rtSize.y !== rtH) {
        self.renderTarget.setSize(rtW, rtH);
        self.rtSize.set(rtW, rtH);
        compositeMaterial.uniforms.fogRT.value = self.renderTarget.texture;
      }

      // Save renderer state
      const prevRT = renderer.getRenderTarget();
      renderer.getClearColor(self.tempColor);
      const prevAlpha = renderer.getClearAlpha();

      // Render fog to RT (clear to transparent, depth-tested for correct ordering)
      renderer.setRenderTarget(self.renderTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.render(self.fogScene, camera);

      // Restore renderer state
      renderer.setRenderTarget(prevRT);
      renderer.setClearColor(self.tempColor, prevAlpha);
    };
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.compositeQuad);
  }

  setPlayerTeam(team: number): void {
    this.playerTeam = team;
  }

  setVisible(visible: boolean): void {
    this.compositeQuad.visible = visible;
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

  dispose(): void {
    this.fogMesh.geometry.dispose();
    (this.fogMesh.material as THREE.ShaderMaterial).dispose();
    this.compositeQuad.geometry.dispose();
    (this.compositeQuad.material as THREE.ShaderMaterial).dispose();
    this.renderTarget.dispose();
    this.texture.dispose();
    this.heightmapTexture.dispose();
  }
}
