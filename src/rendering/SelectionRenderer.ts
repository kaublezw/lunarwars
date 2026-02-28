import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Entity, World } from '@core/ECS';
import { POSITION, SELECTABLE, TEAM, BUILDING, VOXEL_STATE } from '@sim/components/ComponentTypes';
import type { PositionComponent } from '@sim/components/Position';
import type { SelectableComponent } from '@sim/components/Selectable';
import type { TeamComponent } from '@sim/components/Team';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';
import type { VoxelMeshManager } from '@render/VoxelMeshManager';

const OUTLINE_SCALE = 1.03;

export class SelectionRenderer {
  private outlines = new Map<Entity, THREE.LineSegments>();
  private outlineMaterial: THREE.LineBasicMaterial;
  private fogState: FogOfWarState | null = null;
  private playerTeam = 0;
  private objectGetter: ((e: Entity) => THREE.Object3D | undefined) | null = null;
  private voxelMeshManager: VoxelMeshManager | null = null;

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

  setVoxelMeshManager(vmm: VoxelMeshManager): void {
    this.voxelMeshManager = vmm;
  }

  constructor(private scene: THREE.Scene) {
    this.outlineMaterial = new THREE.LineBasicMaterial({
      color: 0x44ff44,
      transparent: true,
      opacity: 0.6,
      depthTest: true,
    });
  }

  sync(world: World, alpha: number): void {
    const entities = world.query(POSITION, SELECTABLE);
    const activeEntities = new Set<Entity>();

    for (const e of entities) {
      const sel = world.getComponent<SelectableComponent>(e, SELECTABLE)!;
      if (!sel.selected) continue;

      // Skip fogged enemy entities (safety net)
      if (this.fogState && this.playerTeam >= 0) {
        const team = world.getComponent<TeamComponent>(e, TEAM);
        if (team && team.team !== this.playerTeam) {
          const pos = world.getComponent<PositionComponent>(e, POSITION)!;
          if (!this.fogState.isVisible(this.playerTeam, pos.x, pos.z)) continue;
        }
      }

      activeEntities.add(e);
      const pos = world.getComponent<PositionComponent>(e, POSITION)!;

      // Interpolate position
      const x = pos.prevX + (pos.x - pos.prevX) * alpha;
      const y = pos.prevY + (pos.y - pos.prevY) * alpha;
      const z = pos.prevZ + (pos.z - pos.prevZ) * alpha;

      if (!this.outlines.has(e)) {
        const outline = world.hasComponent(e, VOXEL_STATE)
          ? this.createVoxelOutline(e)
          : this.createOutline(e);
        if (outline) {
          this.scene.add(outline);
          this.outlines.set(e, outline);
        }
      }

      const outline = this.outlines.get(e);
      if (outline) {
        outline.position.set(x, y, z);
        // Units rotate; buildings don't
        if (!world.hasComponent(e, BUILDING)) {
          outline.rotation.y = pos.rotation;
        }
      }
    }

    // Remove outlines for deselected or destroyed entities
    for (const [e, outline] of this.outlines) {
      if (!activeEntities.has(e)) {
        this.scene.remove(outline);
        outline.geometry.dispose();
        this.outlines.delete(e);
      }
    }
  }

  /** Create bounding-box edge outline for voxel entities */
  private createVoxelOutline(entity: Entity): THREE.LineSegments | null {
    if (!this.voxelMeshManager) return null;
    const bounds = this.voxelMeshManager.getEntityBounds(entity);
    if (!bounds) return null;

    const size = new THREE.Vector3();
    bounds.getSize(size);

    const boxGeo = new THREE.BoxGeometry(size.x, size.y, size.z);
    boxGeo.translate(0, size.y / 2, 0);

    const edgesGeo = new THREE.EdgesGeometry(boxGeo);
    boxGeo.dispose();

    const lines = new THREE.LineSegments(edgesGeo, this.outlineMaterial);
    lines.scale.setScalar(OUTLINE_SCALE);
    return lines;
  }

  private createOutline(entity: Entity): THREE.LineSegments | null {
    if (!this.objectGetter) return null;
    const obj = this.objectGetter(entity);
    if (!obj) return null;

    // Ensure world matrices are up to date
    obj.updateMatrixWorld(true);
    const rootInverse = new THREE.Matrix4().copy(obj.matrixWorld).invert();

    // Collect all child mesh geometries, transformed relative to the root object.
    const geos: THREE.BufferGeometry[] = [];
    obj.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || !child.geometry) return;
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

    const edgesGeo = new THREE.EdgesGeometry(merged, 30);
    merged.dispose();

    const lines = new THREE.LineSegments(edgesGeo, this.outlineMaterial);
    lines.scale.copy(obj.scale).multiplyScalar(OUTLINE_SCALE);
    return lines;
  }
}
