import { COURT, hoopX } from './court';
import { attackSide, SIM_DT, slotOf, type GameEvent, type GameState, type PlayerInput, type PlayerState } from './game';
import { dist, steer, type P2 } from './steer';

/**
 * Jugadas del pasador (cuando lo maneja la IA tras pasar):
 *
 * CORTE ("pasa y corta"): corre al aro con un brazo en alto pidiendo el balón. Si el que tiene el
 *   balón vuelve a pulsar pase, se lo devuelve. Al llegar bajo el aro salta con los dos brazos
 *   arriba; si no recibe, sale a la línea de tres y vuelve a su posición normal.
 *
 * BLOQUEO: va hacia el defensor del nuevo poseedor, se planta a su lado y se queda quieto (no se
 *   le puede empujar), para que el compañero deje atrás a su defensor.
 */
export type Play =
  | { kind: 'cut'; phase: 'toRim' | 'jump' | 'out'; t: number; side: 1 | -1 }
  | {
      kind: 'screen';
      phase: 'approach' | 'set';
      t: number;
      defender: number;
      carrier: number;
      x: number;
      z: number;
      /** Orientación congelada al plantarse (de cara al defensor): su anchura queda cruzada en su camino. */
      face: number;
    };

export const PLAYS = {
  /** Probabilidad de cortar (si no, bloquea). */
  cutChance: 0.5,
  /** Punto de llegada bajo el aro (distancia delante del aro y desplazamiento lateral). */
  rimFront: 1.0,
  rimSide: 0.5,
  /** Se considera "bajo el aro" a esta distancia (la zona suele estar llena de cuerpos). */
  rimArrive: 1.6,
  jumpTime: 0.75,
  jumpHeight: 0.55,
  /** Alcance extra para recibir saltando con los brazos arriba. */
  jumpReach: 0.55,
  /** Salida a la línea de tres: radio y ángulo respecto al eje de la canasta. */
  outRadius: 7.0,
  outAngleDeg: 55,
  cutTimeout: 3.5,
  /** Separación lateral del bloqueo respecto al defensor. */
  screenGap: 0.8,
  /** Tiempo plantado en el bloqueo, con piernas abiertas y brazos en jarras. */
  screenTime: 1.0,
  /** Anchura del obstáculo mientras bloquea (× la normal). */
  screenWidth: 2,
  /** Defensor que choca con un bloqueo: tiempo frenado y fracción de su velocidad. */
  screenedTime: 0.9,
  screenedSpeed: 0.35,
  approachTimeout: 3.5,
} as const;

export function startPlay(g: GameState, p: PlayerState, rng: () => number, ev: GameEvent[]): void {
  const carrierId = g.ball.passTarget;
  if (rng() < PLAYS.cutChance) {
    p.play = { kind: 'cut', phase: 'toRim', t: 0, side: p.z >= 0 ? 1 : -1 };
  } else {
    const carrier = g.players[carrierId]!;
    const defender = g.players.find((q) => q.team !== p.team && slotOf(q) === slotOf(carrier))!;
    p.play = { kind: 'screen', phase: 'approach', t: 0, defender: defender.id, carrier: carrierId, x: defender.x, z: defender.z, face: 0 };
  }
  ev.push({ type: 'play', playerId: p.id, kind: p.play.kind });
}

/** Compañero que está cortando y pide el balón (para devolverle el pase). */
export function cutterCalling(g: GameState, team: 0 | 1): PlayerState | null {
  return g.players.find((q) => q.team === team && q.play?.kind === 'cut' && q.play.phase !== 'out') ?? null;
}

/** El bloqueador plantado no se mueve al chocar. */
export const isAnchored = (p: PlayerState) => p.play?.kind === 'screen' && p.play.phase === 'set';

/** Multiplicador de anchura del obstáculo (2 mientras bloquea, 1 si no). */
export const screenWidthMul = (p: PlayerState) => (isAnchored(p) ? PLAYS.screenWidth : 1);

/** Altura del salto del cortador bajo el aro (0 si no está saltando). */
export function cutJumpLift(p: PlayerState): number {
  if (p.play?.kind !== 'cut' || p.play.phase !== 'jump') return 0;
  return Math.sin(Math.min(1, p.play.t / PLAYS.jumpTime) * Math.PI) * PLAYS.jumpHeight;
}

export function extraReach(p: PlayerState): number {
  return p.play?.kind === 'cut' && p.play.phase === 'jump' ? PLAYS.jumpReach : 0;
}

/** Input de la jugada en curso, o null si no hay (o ya terminó). */
export function playInput(g: GameState, p: PlayerState): PlayerInput | null {
  const play = p.play;
  if (!play) return null;
  const b = g.ball;
  const ballPos: P2 = b.holder >= 0 ? g.players[b.holder]! : b;
  // Perdimos la posesión: se cancela cualquier jugada.
  if (g.possession !== p.team) return (p.play = null);
  play.t += SIM_DT;
  const dir = attackSide(p.team);
  const hx = hoopX(dir);

  if (play.kind === 'cut') {
    if (play.phase === 'toRim') {
      const target = { x: hx - dir * PLAYS.rimFront, z: play.side * PLAYS.rimSide };
      if (dist(p, { x: hx, z: 0 }) < PLAYS.rimArrive || play.t > PLAYS.cutTimeout) {
        play.phase = 'jump';
        play.t = 0;
      }
      return steer(p, target, ballPos);
    }
    if (play.phase === 'jump') {
      if (play.t >= PLAYS.jumpTime) {
        play.phase = 'out';
        play.t = 0;
      }
      return { mx: 0, mz: 0, shoot: false, look: ballPos };
    }
    // Salida a la línea de tres por su lado.
    const a = (PLAYS.outAngleDeg * Math.PI) / 180;
    const target = { x: hx - dir * Math.cos(a) * PLAYS.outRadius, z: play.side * Math.sin(a) * PLAYS.outRadius };
    if (dist(p, target) < 0.5 || play.t > PLAYS.cutTimeout) p.play = null;
    return steer(p, target, ballPos);
  }

  // Bloqueo: si el balón cambió de manos (y no es el pase que aún va hacia él), ya no tiene sentido.
  if (b.holder !== play.carrier && b.passTarget !== play.carrier) return (p.play = null);
  const defender = g.players[play.defender]!;
  const carrier = g.players[play.carrier]!;
  if (play.phase === 'approach') {
    // Al lado del defensor, perpendicular a la línea defensor→atacante, por el lado por el que llega.
    const u = { x: carrier.x - defender.x, z: carrier.z - defender.z };
    const L = Math.hypot(u.x, u.z) || 1;
    u.x /= L;
    u.z /= L;
    const perp = { x: -u.z, z: u.x };
    const side = Math.sign(perp.x * (p.x - defender.x) + perp.z * (p.z - defender.z)) || 1;
    play.x = defender.x + perp.x * side * PLAYS.screenGap + u.x * 0.15;
    play.z = defender.z + perp.z * side * PLAYS.screenGap + u.z * 0.15;
    play.x = Math.max(-COURT.halfL, Math.min(COURT.halfL, play.x));
    play.z = Math.max(-COURT.halfW, Math.min(COURT.halfW, play.z));
    if (dist(p, play) < 0.4) {
      play.phase = 'set';
      play.t = 0;
      play.face = Math.atan2(defender.x - p.x, defender.z - p.z);
    } else if (play.t > PLAYS.approachTimeout) {
      return (p.play = null);
    }
    return steer(p, { x: play.x, z: play.z }, defender);
  }
  if (play.t >= PLAYS.screenTime) p.play = null;
  // Plantado: no gira (mira siempre al frente que fijó al plantarse).
  return { mx: 0, mz: 0, shoot: false, look: { x: p.x + Math.sin(play.face), z: p.z + Math.cos(play.face) } };
}
