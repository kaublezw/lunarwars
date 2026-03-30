import { Howl } from 'howler';
import type { EventBus } from '@core/EventBus';

export class AudioManager {
  private acknowledge: Howl;

  constructor(eventBus: EventBus) {
    this.acknowledge = new Howl({ src: ['/sounds/acknowledge.mp3'] });

    eventBus.on('command:move', () => this.acknowledge.play());
    eventBus.on('command:rally', () => this.acknowledge.play());
    eventBus.on('command:repair', () => this.acknowledge.play());
  }
}
