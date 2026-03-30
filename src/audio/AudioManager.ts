import { Howl, Howler } from 'howler';
import type { EventBus } from '@core/EventBus';
import type { IsometricCamera } from '@render/IsometricCamera';
import * as THREE from 'three';

export class AudioManager {
  private acknowledge: Howl;
  private smallWeaponFire: Howl;
  private largeWeaponFire: Howl;
  private unitExplosion: Howl;
  private buildingExplosion: Howl;
  private camera: IsometricCamera;
  private tmpVec = new THREE.Vector3();

  constructor(eventBus: EventBus, camera: IsometricCamera) {
    Howler.volume(0.5);
    this.camera = camera;

    this.acknowledge = new Howl({ src: ['/sounds/acknowledge.mp3'], volume: 1 });
    this.smallWeaponFire = new Howl({ src: ['/sounds/smallWeaponFire.mp3'], volume: 0.15 });
    this.largeWeaponFire = new Howl({ src: ['/sounds/largeWeaponFire.mp3'], volume: 0.15 });
    this.unitExplosion = new Howl({ src: ['/sounds/unitexplosion.mp3'], volume: 0.3 });
    this.buildingExplosion = new Howl({ src: ['/sounds/buildingexplosion.mp3'], volume: 0.4 });

    // Command events
    eventBus.on('command:move', () => this.acknowledge.play());
    eventBus.on('command:rally', () => this.acknowledge.play());
    eventBus.on('command:repair', () => this.acknowledge.play());
    eventBus.on('command:attack', () => this.acknowledge.play());
    eventBus.on('command:build', () => this.acknowledge.play());

    // Weapon fire events (screen-proximity gated)
    eventBus.on('weapon:fire:small', (...args: unknown[]) => {
      if (this.isOnScreen(args[0] as number, args[1] as number)) this.smallWeaponFire.play();
    });
    eventBus.on('weapon:fire:large', (...args: unknown[]) => {
      if (this.isOnScreen(args[0] as number, args[1] as number)) this.largeWeaponFire.play();
    });

    // Explosion events (screen-proximity gated)
    eventBus.on('explosion:unit', (...args: unknown[]) => {
      if (this.isOnScreen(args[0] as number, args[1] as number)) this.unitExplosion.play();
    });
    eventBus.on('explosion:building', (...args: unknown[]) => {
      if (this.isOnScreen(args[0] as number, args[1] as number)) this.buildingExplosion.play();
    });
  }

  private isOnScreen(x: number, z: number): boolean {
    this.tmpVec.set(x, 0, z);
    const ndc = this.tmpVec.project(this.camera.getCamera());
    return ndc.x >= -1 && ndc.x <= 1 && ndc.y >= -1 && ndc.y <= 1;
  }
}
