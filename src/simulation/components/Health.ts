export interface HealthComponent {
  current: number;
  max: number;
  dead: boolean; // set when current <= 0, consumed by HealthSystem
}
