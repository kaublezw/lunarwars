import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Entity, World } from '@core/ECS';
import { POSITION, UNIT_TYPE, TEAM, HEALTH } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { TeamComponent } from '@sim/components/Team';
import type { HealthComponent } from '@sim/components/Health';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';

const XRAY_VS = `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const XRAY_FS = `
uniform sampler2D buildingDepth;
uniform vec2 resolution;
uniform vec3 xrayColor;
uniform float xrayOpacity;

void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  float bDepth = texture2D(buildingDepth, uv).r;
  float fDepth = gl_FragCoord.z;

  // Draw only where a building wrote depth (< 1.0) and this fragment is behind it
  if (bDepth >= 1.0 || fDepth <= bDepth) {
    discard;
  }

  gl_FragColor = vec4(xrayColor, xrayOpacity);
}`;

export class XRayRenderer {
  private silhouettes = new Map<Entity, THREE.Mesh>();
  private fogState: FogOfWarState | null = null;
  private playerTeam = 0;
  private objectGetter: ((e: Entity) => THREE.Object3D | undefined) | null = null;

  private webglRenderer: THREE.WebGLRenderer | null = null;
  private camera: THREE.Camera | null = null;
  private depthTarget: THREE.WebGLRenderTarget;
  private depthOverrideMat: THREE.MeshBasicMaterial;
  private xrayMaterial: THREE.ShaderMaterial;
  private resolution: THREE.Vector2;

  constructor(private scene: THREE.Scene) {
    this.resolution = new THREE.Vector2(1, 1);

    const depthTexture = new THREE.DepthTexture(1, 1);
    this.depthTarget = new THREE.WebGLRenderTarget(1, 1, {
      depthTexture,
      depthBuffer: true,
      stencilBuffer: false,
    });

    this.depthOverrideMat = new THREE.MeshBasicMaterial({
      colorWrite: false,
    });

    this.xrayMaterial = new THREE.ShaderMaterial({
      uniforms: {
        buildingDepth: { value: depthTexture },
        resolution: { value: this.resolution },
        xrayColor: { value: new THREE.Color(0x88ccff) },
        xrayOpacity: { value: 0.35 },
      },
      vertexShader: XRAY_VS,
      fragmentShader: XRAY_FS,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
  }

  setRenderer(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    this.webglRenderer = renderer;
    this.camera = camera;
    this.updateSize();
  }

  resize(): void {
    this.updateSize();
  }

  private updateSize(): void {
    if (!this.webglRenderer) return;
    const size = new THREE.Vector2();
    this.webglRenderer.getSize(size);
    const pr = this.webglRenderer.getPixelRatio();
    const pw = Math.floor(size.x * pr);
    const ph = Math.floor(size.y * pr);
    this.resolution.set(pw, ph);
    this.depthTarget.setSize(pw, ph);
  }

  setFogState(fogState: FogOfWarState, playerTeam: number): void {
    this.fogState = fogState;
    this.playerTeam = playerTeam;
  }

  setPlayerTeam(team: number): void {
    this.playerTeam = team;
  }

  setObjectGetter(fn: (e: Entity) => THREE.Object3D | undefined): void {
    this.objectGetter = fn;
  }

  sync(world: World, alpha: number): void {
    this.renderBuildingDepth();

    const entities = world.query(POSITION, UNIT_TYPE, TEAM);
    const activeEntities = new Set<Entity>();

    for (const e of entities) {
      // Player units only
      const team = world.getComponent<TeamComponent>(e, TEAM)!;
      if (team.team !== this.playerTeam) continue;

      // Skip dead units
      const health = world.getComponent<HealthComponent>(e, HEALTH);
      if (health && health.dead) continue;

      // Skip fogged units (shouldn't happen for own team, but safety check)
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;
      if (this.fogState && this.playerTeam >= 0) {
        if (!this.fogState.isVisible(this.playerTeam, pos.x, pos.z)) continue;
      }

      activeEntities.add(e);

      // Interpolate position
      const x = pos.prevX + (pos.x - pos.prevX) * alpha;
      const y = pos.prevY + (pos.y - pos.prevY) * alpha;
      const z = pos.prevZ + (pos.z - pos.prevZ) * alpha;

      if (!this.silhouettes.has(e)) {
        const mesh = this.createSilhouette(e);
        if (mesh) {
          this.scene.add(mesh);
          this.silhouettes.set(e, mesh);
        }
      }

      const mesh = this.silhouettes.get(e);
      if (mesh) {
        mesh.position.set(x, y, z);
        mesh.rotation.y = pos.rotation;
      }
    }

    // Remove silhouettes for entities no longer active
    for (const [e, mesh] of this.silhouettes) {
      if (!activeEntities.has(e)) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        this.silhouettes.delete(e);
      }
    }
  }

  private renderBuildingDepth(): void {
    if (!this.webglRenderer || !this.camera) return;

    const cam = this.camera;
    const savedMask = cam.layers.mask;
    const savedAutoUpdate = this.webglRenderer.shadowMap.autoUpdate;

    cam.layers.set(1);
    this.webglRenderer.shadowMap.autoUpdate = false;
    this.scene.overrideMaterial = this.depthOverrideMat;

    this.webglRenderer.setRenderTarget(this.depthTarget);
    this.webglRenderer.render(this.scene, cam);
    this.webglRenderer.setRenderTarget(null);

    this.scene.overrideMaterial = null;
    this.webglRenderer.shadowMap.autoUpdate = savedAutoUpdate;
    cam.layers.mask = savedMask;
  }

  private createSilhouette(entity: Entity): THREE.Mesh | null {
    if (!this.objectGetter) return null;
    const obj = this.objectGetter(entity);
    if (!obj) return null;

    obj.updateMatrixWorld(true);
    const rootInverse = new THREE.Matrix4().copy(obj.matrixWorld).invert();

    const geos: THREE.BufferGeometry[] = [];
    obj.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || !child.geometry) return;
      // Skip wireframe overlay meshes
      const mat = child.material;
      if (mat instanceof THREE.MeshBasicMaterial && mat.wireframe) return;

      const relativeMatrix = new THREE.Matrix4().multiplyMatrices(rootInverse, child.matrixWorld);
      const cloned = child.geometry.clone();
      cloned.applyMatrix4(relativeMatrix);
      geos.push(cloned);
    });

    if (geos.length === 0) return null;

    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) return null;

    const mesh = new THREE.Mesh(merged, this.xrayMaterial);
    mesh.scale.copy(obj.scale);
    mesh.renderOrder = 999;
    return mesh;
  }
}
