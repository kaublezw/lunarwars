export enum RLActionType {
  NoOp = 0,
  MoveUnit = 1,
  AttackMove = 2,
  TrainUnit = 3,
  BuildStructure = 4,
}

export interface AIAction {
  actionType: number;
  sourceX: number;
  sourceZ: number;
  targetX: number;
  targetZ: number;
  param: number;
}

export interface ObservationData {
  resources: number[];
  mapGrid: number[];
  energyGrid: number[];
  oreGrid: number[];
  unitData: number[];
  buildingData: number[];
  gameState: number[];
  actionMask: number[];
  tick: number;
}

export interface StepResult {
  observation: ObservationData;
  reward: number;
  done: boolean;
  truncated: boolean;
  info: Record<string, unknown>;
}

