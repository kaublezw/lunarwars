import { WebSocketServer, WebSocket } from 'ws';

const PORT = parseInt(process.env.PORT || '8080', 10);
const INPUT_DELAY = 6; // ticks

// --- Room management ---

interface Room {
  code: string;
  players: (WebSocket | null)[];  // index = team (0 or 1)
  seed: number;
  started: boolean;
}

const rooms = new Map<string, Room>();
const playerRoom = new Map<WebSocket, Room>();
const playerTeam = new Map<WebSocket, number>();

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code: string;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));
  return code;
}

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastToRoom(room: Room, msg: unknown): void {
  const data = JSON.stringify(msg);
  for (const player of room.players) {
    if (player && player.readyState === WebSocket.OPEN) {
      player.send(data);
    }
  }
}

function cleanupRoom(room: Room): void {
  rooms.delete(room.code);
  for (const player of room.players) {
    if (player) {
      playerRoom.delete(player);
      playerTeam.delete(player);
    }
  }
}

// --- WebSocket server ---

const wss = new WebSocketServer({ port: PORT });

console.log(`Lunar Wars relay server listening on port ${PORT}`);

wss.on('connection', (ws: WebSocket) => {
  ws.on('message', (raw: Buffer) => {
    let msg: { type: string; [key: string]: unknown };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'create_room': {
        // Player wants to host a new room
        if (playerRoom.has(ws)) {
          send(ws, { type: 'lobby_error', message: 'Already in a room' });
          return;
        }
        const code = generateRoomCode();
        const room: Room = {
          code,
          players: [ws, null],
          seed: Math.floor(Math.random() * 2147483647),
          started: false,
        };
        rooms.set(code, room);
        playerRoom.set(ws, room);
        playerTeam.set(ws, 0);
        send(ws, { type: 'room_created', code });
        console.log(`Room ${code} created`);
        break;
      }

      case 'join_room': {
        if (playerRoom.has(ws)) {
          send(ws, { type: 'lobby_error', message: 'Already in a room' });
          return;
        }
        const code = (msg.code as string || '').toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          send(ws, { type: 'lobby_error', message: 'Room not found' });
          return;
        }
        if (room.players[1] !== null) {
          send(ws, { type: 'lobby_error', message: 'Room is full' });
          return;
        }
        // Join as team 1
        room.players[1] = ws;
        playerRoom.set(ws, room);
        playerTeam.set(ws, 1);
        send(ws, { type: 'joined_room', team: 1 });

        // Both players connected — start the game
        room.started = true;
        send(room.players[0]!, {
          type: 'game_start',
          seed: room.seed,
          yourTeam: 0,
          inputDelay: INPUT_DELAY,
        });
        send(ws, {
          type: 'game_start',
          seed: room.seed,
          yourTeam: 1,
          inputDelay: INPUT_DELAY,
        });
        console.log(`Room ${code} started (seed: ${room.seed})`);
        break;
      }

      case 'game_command':
      case 'tick_confirm':
      case 'desync_alert':
      case 'speed_change': {
        // Relay game messages to both players (including sender)
        const room = playerRoom.get(ws);
        if (!room || !room.started) return;

        const team = playerTeam.get(ws);
        // Attach playerId from server (don't trust client)
        const relayMsg = { ...msg, playerId: team };
        broadcastToRoom(room, relayMsg);
        break;
      }
    }
  });

  ws.on('close', () => {
    const room = playerRoom.get(ws);
    if (!room) return;

    // Notify other player
    for (const player of room.players) {
      if (player && player !== ws && player.readyState === WebSocket.OPEN) {
        send(player, { type: 'player_disconnected' });
      }
    }

    cleanupRoom(room);
    console.log(`Room ${room.code} closed (player disconnected)`);
  });
});
