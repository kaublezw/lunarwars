import { Howl, Howler } from 'howler';
import type { EventBus } from '@core/EventBus';
import type { IsometricCamera } from '@render/IsometricCamera';
import type { FogOfWarState } from '@sim/fog/FogOfWarState';
import * as THREE from 'three';

export class AudioManager {
  private acknowledge: Howl | null = null;
  private smallWeaponFire: Howl | null = null;
  private largeWeaponFire: Howl | null = null;
  private unitExplosion: Howl | null = null;
  private buildingExplosion: Howl | null = null;
  private construction: Howl | null = null;
  private camera: IsometricCamera | null = null;
  private fogState: FogOfWarState | null = null;
  private playerTeam: number = 0;
  private tmpVec = new THREE.Vector3();

  private bgMusic: Howl;
  private musicVolume: number;
  private musicMuted: boolean;

  constructor(eventBus?: EventBus, camera?: IsometricCamera) {
    Howler.volume(0.5);

    // --- Background music ---
    this.musicVolume = this.loadMusicVolume();
    this.musicMuted = this.loadMusicMuted();

    this.bgMusic = new Howl({
      src: ['/sounds/backgroundmusic.mp3'],
      loop: true,
      volume: this.musicVolume,
    });
    if (this.musicMuted) {
      this.bgMusic.mute(true);
    }

    // --- SFX (only when eventBus + camera provided) ---
    if (eventBus && camera) {
      this.camera = camera;

      this.acknowledge = new Howl({ src: ['/sounds/acknowledge.mp3'], volume: 1 });
      this.smallWeaponFire = new Howl({ src: ['/sounds/smallWeaponFire.mp3'], volume: 0.15 });
      this.largeWeaponFire = new Howl({ src: ['/sounds/largeWeaponFire.mp3'], volume: 0.15 });
      this.unitExplosion = new Howl({ src: ['/sounds/unitexplosion.mp3'], volume: 0.3 });
      this.buildingExplosion = new Howl({ src: ['/sounds/buildingexplosion.mp3'], volume: 0.4 });
      this.construction = new Howl({ src: ['/sounds/construction.mp3'], volume: 0.25 });

      // Command events
      eventBus.on('command:move', () => this.acknowledge!.play());
      eventBus.on('command:rally', () => this.acknowledge!.play());
      eventBus.on('command:repair', () => this.acknowledge!.play());
      eventBus.on('command:attack', () => this.acknowledge!.play());
      eventBus.on('command:build', () => this.acknowledge!.play());

      // Weapon fire events (screen + fog gated)
      eventBus.on('weapon:fire:small', (...args: unknown[]) => {
        if (this.canHear(args[0] as number, args[1] as number)) this.smallWeaponFire!.play();
      });
      eventBus.on('weapon:fire:large', (...args: unknown[]) => {
        if (this.canHear(args[0] as number, args[1] as number)) this.largeWeaponFire!.play();
      });

      // Explosion events (screen + fog gated)
      eventBus.on('explosion:unit', (...args: unknown[]) => {
        if (this.canHear(args[0] as number, args[1] as number)) this.unitExplosion!.play();
      });
      eventBus.on('explosion:building', (...args: unknown[]) => {
        if (this.canHear(args[0] as number, args[1] as number)) this.buildingExplosion!.play();
      });

      // Construction events (screen + fog gated)
      eventBus.on('construction:active', (...args: unknown[]) => {
        if (this.canHear(args[0] as number, args[1] as number) && !this.construction!.playing()) {
          this.construction!.play();
        }
      });
    }
  }

  // --- Music controls ---

  startMusic(): void {
    if (!this.bgMusic.playing()) {
      this.bgMusic.play();
    }
  }

  pauseMusic(): void {
    if (this.bgMusic.playing()) {
      this.bgMusic.pause();
    }
  }

  resumeMusic(): void {
    if (!this.bgMusic.playing()) {
      this.bgMusic.play();
    }
  }

  stopMusic(): void {
    this.bgMusic.stop();
  }

  setMusicVolume(vol: number): void {
    this.musicVolume = Math.max(0, Math.min(1, vol));
    if (!this.musicMuted) {
      this.bgMusic.volume(this.musicVolume);
    }
    localStorage.setItem('lunarwars_music_volume', String(this.musicVolume));
  }

  getMusicVolume(): number {
    return this.musicVolume;
  }

  setMusicMuted(muted: boolean): void {
    this.musicMuted = muted;
    this.bgMusic.mute(muted);
    localStorage.setItem('lunarwars_music_muted', muted ? '1' : '0');
  }

  isMusicMuted(): boolean {
    return this.musicMuted;
  }

  setFogState(fogState: FogOfWarState, playerTeam: number): void {
    this.fogState = fogState;
    this.playerTeam = playerTeam;
  }

  // --- Private helpers ---

  private canHear(x: number, z: number): boolean {
    if (!this.isOnScreen(x, z)) return false;
    if (!this.fogState) return true;
    return this.fogState.isVisible(this.playerTeam, x, z);
  }

  private loadMusicVolume(): number {
    const stored = localStorage.getItem('lunarwars_music_volume');
    if (stored !== null) {
      const val = parseFloat(stored);
      if (!isNaN(val)) return Math.max(0, Math.min(1, val));
    }
    return 0.3;
  }

  private loadMusicMuted(): boolean {
    return localStorage.getItem('lunarwars_music_muted') === '1';
  }

  private isOnScreen(x: number, z: number): boolean {
    this.tmpVec.set(x, 0, z);
    const ndc = this.tmpVec.project(this.camera!.getCamera());
    return ndc.x >= -1 && ndc.x <= 1 && ndc.y >= -1 && ndc.y <= 1;
  }
}
