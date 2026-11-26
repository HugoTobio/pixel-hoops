/**
 * Servidor de partidas Humano vs Humano.
 * Autoritativo: ejecuta la misma simulación compartida que el cliente (60 Hz) con los controles
 * de los dos jugadores y envía el estado a ambos (30 Hz). Cada humano maneja a un equipo; sus
 * compañeros los mueve la IA, igual que en local.
 */
import { WebSocket, WebSocketServer } from 'ws';
import {
  createGame,
  makeRoomCode,
  NET,
  NO_INPUT,
  resetPossession,
  SIM_DT,
  stepGame,
  type ClientMsg,
  type GameEvent,
  type GameState,
  type PlayerInput,
  type ServerMsg,
  type Team,
} from '@brawl/shared';

interface Room {
  code: string;
  sockets: [WebSocket | null, WebSocket | null];
  inputs: [PlayerInput, PlayerInput];
  phase: 'waiting' | 'countdown' | 'playing' | 'closed';
  game: GameState | null;
  events: GameEvent[];
  timers: NodeJS.Timeout[];
}

const rooms = new Map<string, Room>();
const port = Number(process.env.PORT) || NET.port;
const wss = new WebSocketServer({ port });

const send = (ws: WebSocket | null, msg: ServerMsg) => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
};
const broadcast = (room: Room, msg: ServerMsg) => room.sockets.forEach((ws) => send(ws, msg));

function closeRoom(room: Room) {
  room.phase = 'closed';
  room.timers.forEach((t) => clearInterval(t));
  rooms.delete(room.code);
}

function startMatch(room: Room) {
  // Equipo 0 = quien creó la partida, equipo 1 = quien se unió. Cada uno maneja a su base.
  const game = createGame(['human', 'ai', 'ai', 'human', 'ai', 'ai']);
  resetPossession(game, 0);
  room.game = game;
  room.phase = 'playing';
  broadcast(room, { t: 'start' });

  let tick = 0;
  const stepsPerSnapshot = Math.round(1 / SIM_DT / NET.snapshotHz);
  room.timers.push(
    setInterval(() => {
      const ev = stepGame(
        game,
        (id) => room.inputs[game.players[id]!.team] ?? NO_INPUT,
        SIM_DT,
        Math.random,
      );
      room.events.push(...ev);
      // La pulsación de pase se usa en un solo paso.
      room.inputs.forEach((inp) => (inp.pass = false));
      if (++tick % stepsPerSnapshot === 0) {
        broadcast(room, { t: 'state', s: game, ev: room.events });
        room.events = [];
      }
    }, SIM_DT * 1000),
  );
}

wss.on('connection', (ws) => {
  let room: Room | null = null;
  let team: Team = 0;

  ws.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.t === 'create' && !room) {
      let code = makeRoomCode();
      while (rooms.has(code)) code = makeRoomCode();
      room = { code, sockets: [ws, null], inputs: [{ ...NO_INPUT }, { ...NO_INPUT }], phase: 'waiting', game: null, events: [], timers: [] };
      rooms.set(code, room);
      team = 0;
      send(ws, { t: 'created', code, team });
      console.log(`[${code}] creada`);
    } else if (msg.t === 'join' && !room) {
      const r = rooms.get(String(msg.code).toUpperCase());
      if (!r) return send(ws, { t: 'error', message: 'No existe ninguna partida con ese código.' });
      if (r.sockets[1] || r.phase !== 'waiting') return send(ws, { t: 'error', message: 'La partida ya está completa.' });
      room = r;
      team = 1;
      r.sockets[1] = ws;
      send(ws, { t: 'joined', code: r.code, team });
      broadcast(r, { t: 'opponent_joined' });
      r.phase = 'countdown';
      broadcast(r, { t: 'countdown', seconds: NET.countdownSeconds });
      r.timers.push(setTimeout(() => r.phase === 'countdown' && startMatch(r), NET.countdownSeconds * 1000));
      console.log(`[${r.code}] rival conectado → cuenta atrás`);
    } else if (msg.t === 'input' && room) {
      const inp = msg.input;
      const cur = room.inputs[team];
      room.inputs[team] = {
        mx: Math.max(-1, Math.min(1, Number(inp.mx) || 0)),
        mz: Math.max(-1, Math.min(1, Number(inp.mz) || 0)),
        shoot: !!inp.shoot,
        // Se retiene hasta que la consuma un paso de simulación.
        pass: !!inp.pass || !!cur.pass,
      };
    }
  });

  ws.on('close', () => {
    if (!room || room.phase === 'closed') return;
    room.sockets[team] = null;
    send(room.sockets[team === 0 ? 1 : 0], { t: 'opponent_left' });
    console.log(`[${room.code}] jugador ${team} desconectado → partida cerrada`);
    closeRoom(room);
  });
});

console.log(`Servidor de partidas escuchando en ws://0.0.0.0:${port}`);
