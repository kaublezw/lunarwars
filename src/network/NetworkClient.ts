import type {
  GameCommandPayload,
  TickTaggedCommand,
  ServerToClientMessage,
} from '@network/Protocol';

const DEFAULT_SERVER_URL = 'ws://localhost:8080';

function getServerUrl(): string {
  // Vite injects VITE_WS_SERVER_URL at build time (set in Amplify env vars for production)
  const envUrl = (import.meta as { env?: Record<string, string> }).env?.VITE_WS_SERVER_URL;
  return envUrl || DEFAULT_SERVER_URL;
}

export class NetworkClient {
  private ws: WebSocket | null = null;
  private serverUrl: string;

  // Lobby callbacks
  onRoomCreated: ((code: string) => void) | null = null;
  onJoinedRoom: ((team: number) => void) | null = null;
  onGameStart: ((seed: number, team: number, inputDelay: number) => void) | null = null;
  onLobbyError: ((message: string) => void) | null = null;

  // Game callbacks
  onGameCommand: ((cmd: TickTaggedCommand) => void) | null = null;
  onTickConfirm: ((playerId: number, tick: number) => void) | null = null;

  // Meta callbacks
  onOpponentDisconnected: (() => void) | null = null;
  onDesyncAlert: ((tick: number, checksum: number) => void) | null = null;

  constructor(serverUrl?: string) {
    this.serverUrl = serverUrl || getServerUrl();
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.serverUrl);

      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('WebSocket connection failed'));

      this.ws.onmessage = (event) => {
        let msg: ServerToClientMessage;
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          return;
        }
        this.handleMessage(msg);
      };

      this.ws.onclose = () => {
        this.ws = null;
      };
    });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  // --- Lobby actions ---

  createRoom(): void {
    this.send({ type: 'create_room' });
  }

  joinRoom(code: string): void {
    this.send({ type: 'join_room', code: code.toUpperCase() });
  }

  // --- Game actions ---

  sendCommand(tick: number, playerId: number, payload: GameCommandPayload): void {
    this.send({
      type: 'game_command',
      tick,
      playerId,
      payload,
    });
  }

  sendTickConfirm(tick: number): void {
    this.send({ type: 'tick_confirm', tick, playerId: 0 }); // server overrides playerId
  }

  sendDesyncAlert(tick: number, checksum: number): void {
    this.send({ type: 'desync_alert', tick, checksum });
  }

  // --- Internal ---

  private send(msg: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleMessage(msg: ServerToClientMessage): void {
    switch (msg.type) {
      case 'room_created':
        this.onRoomCreated?.(msg.code);
        break;
      case 'joined_room':
        this.onJoinedRoom?.(msg.team);
        break;
      case 'game_start':
        this.onGameStart?.(msg.seed, msg.yourTeam, msg.inputDelay);
        break;
      case 'lobby_error':
        this.onLobbyError?.(msg.message);
        break;
      case 'game_command':
        this.onGameCommand?.({ tick: msg.tick, playerId: msg.playerId, payload: msg.payload });
        break;
      case 'tick_confirm':
        this.onTickConfirm?.(msg.playerId, msg.tick);
        break;
      case 'player_disconnected':
        this.onOpponentDisconnected?.();
        break;
      case 'desync_alert':
        this.onDesyncAlert?.(msg.tick, msg.checksum);
        break;
    }
  }
}
