// Shared protocol types for multiplayer WebSocket messages.
// Used by both the browser client (NetworkClient) and the relay server.

// --- Game command payloads ---

export interface MoveUnitsPayload {
  type: 'moveUnits';
  entityIds: number[];
  destX: number;
  destZ: number;
  jitterSeed: number; // deterministic formation jitter (replaces Math.random)
}

export interface AttackMovePayload {
  type: 'attackMove';
  entityIds: number[];
  targetEntity: number;
  targetX: number;
  targetZ: number;
}

export interface BuildStructurePayload {
  type: 'buildStructure';
  team: number;
  buildingType: string;
  x: number;
  z: number;
  workerEntity: number;
}

export interface TrainUnitPayload {
  type: 'trainUnit';
  team: number;
  factoryEntity: number;
  unitType: string;
  rallyX: number;
  rallyZ: number;
}

export interface SetRallyPointPayload {
  type: 'setRallyPoint';
  buildingEntity: number;
  rallyX: number;
  rallyZ: number;
}

export interface DemolishPayload {
  type: 'demolish';
  entityId: number;
  team: number;
}

export interface RepairBuildingPayload {
  type: 'repairBuilding';
  workerEntities: number[];
  targetBuildingEntity: number;
}

export interface ReassignWorkerPayload {
  type: 'reassignWorker';
  workerEntity: number;
  constructionSiteEntity: number;
}

export interface RepairAllPolesPayload {
  type: 'repairAllPoles';
  team: number;
}

export interface RebuildLinesPayload {
  type: 'rebuildLines';
  team: number;
}

export type GameCommandPayload =
  | MoveUnitsPayload
  | AttackMovePayload
  | BuildStructurePayload
  | TrainUnitPayload
  | SetRallyPointPayload
  | DemolishPayload
  | RepairBuildingPayload
  | ReassignWorkerPayload
  | RepairAllPolesPayload
  | RebuildLinesPayload;

// --- Tick-tagged command (sent over the wire) ---

export interface TickTaggedCommand {
  tick: number;
  playerId: number;
  payload: GameCommandPayload;
}

// --- Lobby messages ---

export interface CreateRoomMessage {
  type: 'create_room';
}

export interface RoomCreatedMessage {
  type: 'room_created';
  code: string;
}

export interface JoinRoomMessage {
  type: 'join_room';
  code: string;
}

export interface JoinedRoomMessage {
  type: 'joined_room';
  team: number;
}

export interface GameStartMessage {
  type: 'game_start';
  seed: number;
  yourTeam: number;
  inputDelay: number;
}

export interface LobbyErrorMessage {
  type: 'lobby_error';
  message: string;
}

// --- Game messages ---

export interface GameCommandMessage {
  type: 'game_command';
  tick: number;
  playerId: number;
  payload: GameCommandPayload;
}

export interface TickConfirmMessage {
  type: 'tick_confirm';
  playerId: number;
  tick: number;
}

// --- Meta messages ---

export interface PlayerDisconnectedMessage {
  type: 'player_disconnected';
}

export interface DesyncAlertMessage {
  type: 'desync_alert';
  tick: number;
  checksum: number;
}

export interface SpeedChangeMessage {
  type: 'speed_change';
  scale: number;
}

// --- Union of all messages ---

export type ClientToServerMessage =
  | CreateRoomMessage
  | JoinRoomMessage
  | GameCommandMessage
  | TickConfirmMessage
  | DesyncAlertMessage
  | SpeedChangeMessage;

export type ServerToClientMessage =
  | RoomCreatedMessage
  | JoinedRoomMessage
  | GameStartMessage
  | LobbyErrorMessage
  | GameCommandMessage
  | TickConfirmMessage
  | PlayerDisconnectedMessage
  | DesyncAlertMessage
  | SpeedChangeMessage;

// Input delay default (ticks). 6 ticks = 100ms at 60Hz.
export const DEFAULT_INPUT_DELAY = 6;
