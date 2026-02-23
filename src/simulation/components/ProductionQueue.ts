export interface ProductionItem {
  unitType: string;
  timeRemaining: number;
  totalTime: number;
}

export interface ProductionQueueComponent {
  queue: ProductionItem[];
  rallyX: number;
  rallyZ: number;
}
