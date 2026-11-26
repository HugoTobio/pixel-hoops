import { stepBall, type BallEvent, type BallState } from './ball';
import { COURT, hoopX, isThree, type Side } from './court';
import { aiInput } from './ai';
import { choosePassTarget, launchPass, PASS, resolvePass, takeBall } from './pass';
import { cutterCalling, isAnchored, PLAYS, screenWidthMul, startPlay, type Play } from './plays';
import { contest, finishKind, startFinish, stepFinish, type Finish } from './finish';
import { gauss, perfectWindowFor, SHOT, shotVelocity, type ShotQuality } from './shot';

export const SIM_DT = 1 / 60;

export const PLAYER = {
  radius: 0.38,
  speed: 5.4,
  speedWithBall: 4.7,
  accel: 28,
  pickupRange: 0.6,
  pickupMaxHeight: 1.7,
  handHeight: 1.0,
  jumpTime: 0.35,
} as const;

export type Team = 0 | 1;
/** El equipo 0 ataca la canasta derecha (+x); el 1, la izquierda. */
export const attackSide = (team: Team): Side => (team === 0 ? 1 : -1);

export interface PlayerState {
  id: number;
  team: Team;
  /** Quién lo maneja: un humano, la IA del sistema, o nadie (se queda quieto). */
  control: Control;
  x: number;
  z: number;
  vx: number;
  vz: number;
  facing: number;
  charging: boolean;
  charge: number;
  /** Tiempo restante de la animación de salto tras soltar. */
  jump: number;
  pickupCooldown: number;
  /** Ventana restante de "cortar pase" tras pulsar el botón. */
  interceptT: number;
  /** Jugada en curso tras pasar (corte o bloqueo), o null. */
  play: Play | null;
  /** Tiempo restante "atrapado" en un bloqueo (corre más lento). */
  screenedT: number;
  /** Bandeja o mate en curso, o null. */
  finish: Finish | null;
  /** Está sacando de fondo: no se mueve ni tira, solo puede pasar. */
  inbound: boolean;
  /** Segundos que lleva con el balón (para las decisiones de la IA). */
  holdT: number;
  /** IA: en qué momento de la carga suelta el tiro (con algo de error). */
  aiReleaseAt: number;
  /** Zona verde (±) del tiro en curso, fijada al empezar a cargar según el defensor más cercano. */
  shotWindow: number;
  /** Altura en metros: cambia el punto de lanzamiento (y más adelante el alcance para taponar). */
  height: number;
}

export type Control = 'human' | 'ai' | 'idle';

/** Alturas por posición: base, alero, pívot. */
export const ROSTER_HEIGHTS = [1.85, 2.01, 2.13] as const;

export interface PlayerInput {
  mx: number;
  mz: number;
  shoot: boolean;
  /** Pulsación (un solo paso) del botón de pase: pasa si tienes el balón, intenta cortar si no. */
  pass?: boolean;
  /** Punto al que mirar (p. ej. un defensor mirando al balón); si falta, mira hacia donde se mueve. */
  look?: { x: number; z: number };
}

export const NO_INPUT: PlayerInput = { mx: 0, mz: 0, shoot: false };

export type GameEvent =
  | BallEvent
  | { type: 'shot'; playerId: number; quality: ShotQuality; meter: number }
  | { type: 'pickup'; playerId: number }
  | { type: 'pass'; from: number; to: number }
  | { type: 'catch'; playerId: number; passer: number }
  | { type: 'intercept'; playerId: number; passer: number }
  | { type: 'play'; playerId: number; kind: Play['kind'] }
  | { type: 'screened'; playerId: number; screener: number }
  | { type: 'finish'; playerId: number; kind: Finish['kind'] }
  | { type: 'inbound'; playerId: number };

export interface GameState {
  players: PlayerState[];
  ball: BallState;
  score: [number, number];
  time: number;
  /** Equipo que tiene (o tuvo por última vez) la posesión. */
  possession: Team;
  /** Saque pendiente tras canasta: quién saca, desde qué fondo y cuánto falta. */
  pendingInbound: { team: Team; side: Side; t: number } | null;
}

/** Tiempo entre la canasta y el saque (el balón cae por la red). */
export const INBOUND_DELAY = 1.2;

/** Formación inicial: el equipo 0 saca desde su campo; el 1 espera en el suyo. Índice = puesto. */
const FORMATION: [number, number][] = [
  [-8, 0],
  [-6, -4.5],
  [-6, 4.5],
];

/** Puesto (0 base, 1 alero, 2 pívot) dentro de su equipo. */
export const slotOf = (p: PlayerState) => p.id % 3;

export function createGame(controls: Control[] = ['human', 'ai', 'ai', 'ai', 'ai', 'ai']): GameState {
  const players: PlayerState[] = [];
  ([0, 1] as Team[]).forEach((team) => {
    FORMATION.forEach((_, slot) => {
      players.push({
        id: players.length,
        team,
        control: controls[players.length] ?? 'idle',
        x: 0,
        z: 0,
        vx: 0,
        vz: 0,
        facing: 0,
        height: ROSTER_HEIGHTS[slot]!,
        charging: false,
        charge: 0,
        jump: 0,
        pickupCooldown: 0,
        interceptT: 0,
        play: null,
        screenedT: 0,
        finish: null,
        inbound: false,
        holdT: 0,
        aiReleaseAt: 0,
        shotWindow: SHOT.perfectWindow,
      });
    });
  });
  const g: GameState = {
    players,
    ball: {
      x: 0,
      y: PLAYER.handHeight,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      holder: 0,
      shooter: -1,
      shotInFlight: false,
      shotIsThree: false,
      scored: false,
      passTarget: -1,
      passer: -1,
    },
    score: [0, 0],
    time: 0,
    possession: 0,
    pendingInbound: null,
  };
  resetPossession(g, 0);
  return g;
}

/**
 * Recoloca a todos en la formación inicial y da el balón a `holderId`.
 * El equipo con balón empieza en su campo trasero; el otro, en su campo, esperando.
 */
export function resetPossession(g: GameState, holderId: number): void {
  const holder = g.players[holderId]!;
  const dir = attackSide(holder.team);
  for (const p of g.players) {
    const [fx, fz] = FORMATION[slotOf(p)]!;
    const attacking = p.team === holder.team;
    // Atacantes en su campo trasero; defensores al otro lado, cerca de su canasta.
    p.x = attacking ? dir * fx : dir * (-fx - 1);
    p.z = fz;
    p.vx = p.vz = 0;
    p.facing = Math.atan2(dir * (attacking ? 1 : -1), 0);
    p.charging = false;
    p.charge = 0;
    p.jump = 0;
    p.pickupCooldown = 0;
    p.interceptT = 0;
    p.play = null;
    p.screenedT = 0;
    p.finish = null;
    p.inbound = false;
    p.holdT = 0;
  }
  g.pendingInbound = null;
  const o = handOffset(holder.facing);
  Object.assign(g.ball, {
    x: holder.x + o.x,
    y: PLAYER.handHeight,
    z: holder.z + o.z,
    vx: 0,
    vy: 0,
    vz: 0,
    holder: holderId,
    shooter: -1,
    shotInFlight: false,
    shotIsThree: false,
    scored: false,
    passTarget: -1,
    passer: -1,
  });
  g.possession = holder.team;
}

/**
 * Saque de fondo tras canasta: el base del equipo que la recibió saca desde detrás de la línea
 * de fondo de esa canasta. Si su equipo tiene un humano, el humano pasa a controlarle.
 */
export function setupInbound(g: GameState, team: Team, side: Side, ev?: GameEvent[]): void {
  const inbounder = g.players.find((p) => p.team === team && slotOf(p) === 0)!;
  if (g.players.some((p) => p.team === team && p.control === 'human')) assignHuman(g, inbounder.id);
  Object.assign(inbounder, {
    x: side * (COURT.halfL + 0.55),
    z: 1.4,
    vx: 0,
    vz: 0,
    facing: Math.atan2(-side, 0),
    charging: false,
    charge: 0,
    jump: 0,
    finish: null,
    play: null,
    inbound: true,
  });
  for (const p of g.players) p.play = null;
  takeBall(g, inbounder);
  inbounder.holdT = 0;
  g.pendingInbound = null;
  ev?.push({ type: 'inbound', playerId: inbounder.id });
}

/** Distancia al rival más cercano. */
export function nearestOpponent(g: GameState, p: PlayerState): number {
  let d = Infinity;
  for (const q of g.players) if (q.team !== p.team) d = Math.min(d, Math.hypot(q.x - p.x, q.z - p.z));
  return d;
}

/** Si un compañero de un humano (manejado por la IA) se hace con el balón, el humano pasa a él. */
export function giveControlTo(g: GameState, q: PlayerState): void {
  if (q.control !== 'ai') return;
  const human = g.players.find((p) => p.team === q.team && p.control === 'human');
  if (!human) return;
  human.control = 'ai';
  q.control = 'human';
}

/** El humano de un equipo pasa a manejar a `humanId`; sus compañeros, la IA. */
export function assignHuman(g: GameState, humanId: number): void {
  const team = g.players[humanId]!.team;
  for (const p of g.players) if (p.team === team) p.control = p.id === humanId ? 'human' : 'ai';
}

/** Mano derecha del jugador (donde bota el balón), en el plano XZ. */
export function handOffset(facing: number): { x: number; z: number } {
  const fx = Math.sin(facing);
  const fz = Math.cos(facing);
  // Mirando a +z, la derecha anatómica es −x; rotada: (−cos f, sin f).
  return { x: -Math.cos(facing) * 0.36 + fx * 0.18, z: Math.sin(facing) * 0.36 + fz * 0.18 };
}

function release(g: GameState, p: PlayerState, rng: () => number, ev: GameEvent[]) {
  const side = attackSide(p.team);
  const meter = p.charge / SHOT.meterTime;
  const from = {
    x: p.x + Math.sin(p.facing) * 0.25,
    y: p.height + SHOT.releaseAboveHead,
    z: p.z + Math.cos(p.facing) * 0.25,
  };
  const { v, quality } = shotVelocity(from, { x: hoopX(side), y: COURT.rimHeight, z: 0 }, meter, rng, contest(g, p), p.shotWindow);
  const b = g.ball;
  Object.assign(b, {
    x: from.x,
    y: from.y,
    z: from.z,
    vx: v.x,
    vy: v.y,
    vz: v.z,
    holder: -1,
    shooter: p.id,
    shotInFlight: true,
    shotIsThree: isThree(p.x, p.z, side),
    scored: false,
    passTarget: -1,
  });
  p.charging = false;
  p.charge = 0;
  p.jump = PLAYER.jumpTime;
  p.pickupCooldown = 0.5;
  ev.push({ type: 'shot', playerId: p.id, quality, meter });
}

function movePlayer(p: PlayerState, input: PlayerInput, hasBall: boolean, dt: number) {
  let tx = 0;
  let tz = 0;
  if (p.inbound) {
    // Sacando: quieto; el joystick solo apunta el pase.
    p.vx = p.vz = 0;
    if (input.look) p.facing = Math.atan2(input.look.x - p.x, input.look.z - p.z);
    else if (Math.hypot(input.mx, input.mz) > 0.2) p.facing = Math.atan2(input.mx, input.mz);
    return;
  }
  if (!p.charging && p.jump <= 0) {
    let { mx, mz } = input;
    const len = Math.hypot(mx, mz);
    if (len > 1) {
      mx /= len;
      mz /= len;
    }
    if (len > 0.05) {
      const s = (hasBall ? PLAYER.speedWithBall : PLAYER.speed) * (p.screenedT > 0 ? PLAYS.screenedSpeed : 1);
      tx = mx * s;
      tz = mz * s;
    }
  }
  const dvx = tx - p.vx;
  const dvz = tz - p.vz;
  const dl = Math.hypot(dvx, dvz);
  const maxDv = PLAYER.accel * dt;
  const k = dl > maxDv ? maxDv / dl : 1;
  p.vx += dvx * k;
  p.vz += dvz * k;
  p.x = Math.max(-COURT.playBoundX, Math.min(COURT.playBoundX, p.x + p.vx * dt));
  p.z = Math.max(-COURT.playBoundZ, Math.min(COURT.playBoundZ, p.z + p.vz * dt));
  if (p.charging) return;
  if (input.look) p.facing = Math.atan2(input.look.x - p.x, input.look.z - p.z);
  else if (Math.hypot(p.vx, p.vz) > 0.3) p.facing = Math.atan2(p.vx, p.vz);
}

/** Punto de `p` más cercano a `other`: su centro, o sobre la cápsula si está bloqueando. */
function contactPoint(p: PlayerState, other: PlayerState): { x: number; z: number } {
  const mul = screenWidthMul(p);
  if (mul <= 1) return p;
  const half = PLAYER.radius * (mul - 1); // semilongitud del segmento: anchura total = mul × diámetro
  const ax = Math.cos(p.facing); // eje izquierda-derecha del jugador
  const az = -Math.sin(p.facing);
  const proj = Math.max(-half, Math.min(half, (other.x - p.x) * ax + (other.z - p.z) * az));
  return { x: p.x + ax * proj, z: p.z + az * proj };
}

function separatePlayers(players: PlayerState[], events?: GameEvent[]) {
  const minD = PLAYER.radius * 2;
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i]!;
      const b = players[j]!;
      // Quietos (idle) o bloqueando: no se les puede empujar.
      const aMoves = a.control !== 'idle' && !isAnchored(a);
      const bMoves = b.control !== 'idle' && !isAnchored(b);
      if (!aMoves && !bMoves) continue;
      // Un bloqueador plantado ocupa una cápsula más ancha (de hombro a hombro).
      const ca = contactPoint(a, b);
      const cb = contactPoint(b, a);
      const dx = cb.x - ca.x;
      const dz = cb.z - ca.z;
      const d = Math.hypot(dx, dz);
      if (d >= minD || d < 1e-6) continue;
      const push = minD - d;
      const ux = dx / d;
      const uz = dz / d;
      // Un rival que choca con un bloqueo plantado se queda "enganchado": pierde su velocidad.
      for (const [screener, other] of [[a, b], [b, a]] as const) {
        if (isAnchored(screener) && other.team !== screener.team && other.screenedT <= 0) {
          other.screenedT = PLAYS.screenedTime;
          other.vx *= 0.15;
          other.vz *= 0.15;
          events?.push({ type: 'screened', playerId: other.id, screener: screener.id });
        }
      }
      const wa = aMoves ? (bMoves ? 0.5 : 1) : 0;
      const wb = 1 - wa;
      a.x -= ux * push * wa;
      a.z -= uz * push * wa;
      b.x += ux * push * wb;
      b.z += uz * push * wb;
    }
  }
}

/** Avanza la partida un paso fijo. Misma función para cliente (predicción) y servidor. */
export function stepGame(
  g: GameState,
  inputFor: (id: number) => PlayerInput,
  dt: number,
  rng: () => number,
): GameEvent[] {
  const ev: GameEvent[] = [];
  const b = g.ball;
  g.time += dt;
  if (g.pendingInbound) {
    g.pendingInbound.t -= dt;
    if (g.pendingInbound.t <= 0) setupInbound(g, g.pendingInbound.team, g.pendingInbound.side, ev);
  }

  for (const p of g.players) {
    p.pickupCooldown = Math.max(0, p.pickupCooldown - dt);
    p.jump = Math.max(0, p.jump - dt);
    p.interceptT = Math.max(0, p.interceptT - dt);
    p.screenedT = Math.max(0, p.screenedT - dt);
    if (b.holder === p.id) p.holdT += dt;
    if (p.control === 'idle') continue;
    if (p.finish) {
      stepFinish(g, p, dt, rng, ev);
      continue;
    }
    const input = p.control === 'ai' ? aiInput(g, p) : inputFor(p.id);
    const hasBall = b.holder === p.id;

    // Botón de pase: con balón pasa; sin balón abre la ventana para cortar.
    if (input.pass && hasBall && !p.charging && p.jump <= 0) {
      // Si un compañero está cortando y pide el balón, se le devuelve; si no, al que se mira.
      const target = cutterCalling(g, p.team) ?? choosePassTarget(g, p);
      if (target) {
        launchPass(g, p, target, ev);
        // Tras el saque no hay jugada; tras un pase normal, corte o bloqueo.
        if (p.inbound) p.inbound = false;
        else startPlay(g, p, rng, ev);
        movePlayer(p, input, false, dt);
        continue;
      }
    } else if (input.pass && !hasBall) {
      p.interceptT = PASS.interceptWindow;
    }

    if (hasBall && input.shoot && !p.charging && p.jump <= 0 && !p.inbound) {
      // Cerca del aro (o atacándolo): bandeja o mate en vez de tiro en suspensión.
      const kind = finishKind(p);
      if (kind) {
        startFinish(p, kind, ev);
        continue;
      }
      p.charging = true;
      p.charge = 0;
      p.shotWindow = perfectWindowFor(nearestOpponent(g, p));
      // La IA suelta cerca del punto ideal, con algo de error humano.
      if (p.control === 'ai') p.aiReleaseAt = SHOT.meterTime * (SHOT.sweet + gauss(rng) * 0.06);
    }
    if (p.charging) {
      p.charge += dt;
      p.facing = Math.atan2(hoopX(attackSide(p.team)) - p.x, -p.z);
      if (!input.shoot || p.charge >= SHOT.meterTime * SHOT.autoRelease) release(g, p, rng, ev);
    }
    movePlayer(p, input, hasBall, dt);
  }
  separatePlayers(g.players, ev);

  if (b.holder >= 0) {
    const h = g.players[b.holder]!;
    const o = handOffset(h.facing);
    b.x = h.x + o.x;
    b.z = h.z + o.z;
    b.y = PLAYER.handHeight;
    b.vx = h.vx;
    b.vy = 0;
    b.vz = h.vz;
  } else {
    const ballEv: BallEvent[] = [];
    stepBall(b, dt, ballEv);
    ev.push(...ballEv);
    if (resolvePass(g, ev)) {
      // Atrapado o interceptado.
    } else if (b.passTarget < 0 && b.y < PLAYER.pickupMaxHeight && !g.pendingInbound) {
      for (const p of g.players) {
        if (p.control === 'idle' || p.pickupCooldown > 0) continue;
        if (Math.hypot(b.x - p.x, b.z - p.z) < PLAYER.pickupRange) {
          takeBall(g, p);
          giveControlTo(g, p);
          ev.push({ type: 'pickup', playerId: p.id });
          break;
        }
      }
    }
  }

  for (const e of ev) {
    if (e.type === 'score') {
      const scorer: Team = e.side === 1 ? 0 : 1;
      g.score[scorer] += e.points;
      // Saca el equipo que ha recibido la canasta, desde el fondo de esa misma canasta.
      g.pendingInbound = { team: scorer === 0 ? 1 : 0, side: e.side, t: INBOUND_DELAY };
    }
  }
  return ev;
}
