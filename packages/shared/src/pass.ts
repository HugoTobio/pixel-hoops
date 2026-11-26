import { BALL } from './ball';
import type { GameEvent, GameState, PlayerState } from './game';
import { extraReach } from './plays';

export const PASS = {
  /** Velocidad horizontal del pase tenso (m/s). */
  speed: 11,
  /** Altura de salida y llegada (pecho). */
  height: 1.3,
  /** Cono de búsqueda del receptor alrededor de hacia dónde mira el pasador. */
  coneDeg: 75,
  /** Distancia a la que el receptor atrapa el balón. */
  catchRange: 0.9,
  /** Distancia a la que un rival que pulsa "cortar" intercepta. */
  interceptRange: 1.3,
  /** Tiempo durante el que vale una pulsación de "cortar". */
  interceptWindow: 0.35,
  /** Margen por encima de la cabeza para atrapar/interceptar. */
  reachAbove: 0.6,
} as const;

const angleDiff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/** Compañero más cercano a la dirección en la que mira `p` (dentro del cono; si no hay, el de menor ángulo). */
export function choosePassTarget(g: GameState, p: PlayerState): PlayerState | null {
  const cone = (PASS.coneDeg * Math.PI) / 180;
  let best: PlayerState | null = null;
  let bestScore = Infinity;
  for (const q of g.players) {
    if (q.team !== p.team || q.id === p.id) continue;
    const d = Math.hypot(q.x - p.x, q.z - p.z);
    const ang = angleDiff(Math.atan2(q.x - p.x, q.z - p.z), p.facing);
    // Ángulo manda; la distancia desempata. Fuera del cono penaliza mucho.
    const score = ang + d * 0.015 + (ang > cone ? 10 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = q;
    }
  }
  return best;
}

export function launchPass(g: GameState, p: PlayerState, target: PlayerState, ev: GameEvent[]): void {
  const b = g.ball;
  const dx = target.x - b.x;
  const dz = target.z - b.z;
  const d = Math.hypot(dx, dz);
  const t = Math.max(0.2, d / PASS.speed);
  Object.assign(b, {
    y: PASS.height,
    vx: dx / t,
    vz: dz / t,
    // Llega a la misma altura: compensa la gravedad durante el vuelo.
    vy: (0.5 * BALL.gravity * t * t) / t,
    holder: -1,
    passTarget: target.id,
    passer: p.id,
    shooter: -1,
    shotInFlight: false,
    scored: false,
  });
  p.pickupCooldown = 0.4;
  ev.push({ type: 'pass', from: p.id, to: target.id });
}

/** Comprueba interceptaciones y recepción del pase en vuelo. Devuelve true si alguien se hizo con el balón. */
export function resolvePass(g: GameState, ev: GameEvent[]): boolean {
  const b = g.ball;
  if (b.passTarget < 0) return false;
  const passer = g.players[b.passer]!;
  const reach = (q: PlayerState, range: number) =>
    Math.hypot(b.x - q.x, b.z - q.z) <= range && b.y <= q.height + PASS.reachAbove + extraReach(q);

  for (const q of g.players) {
    if (q.team === passer.team || q.interceptT <= 0) continue;
    if (reach(q, PASS.interceptRange)) {
      takeBall(g, q);
      ev.push({ type: 'intercept', playerId: q.id, passer: passer.id });
      return true;
    }
  }
  const target = g.players[b.passTarget]!;
  if (reach(target, PASS.catchRange)) {
    takeBall(g, target);
    // Si el pasador era humano y el receptor no, el humano pasa a controlar al receptor.
    if (passer.control === 'human' && target.control === 'ai') {
      passer.control = 'ai';
      target.control = 'human';
    }
    ev.push({ type: 'catch', playerId: target.id, passer: passer.id });
    return true;
  }
  if (b.y <= BALL.radius + 0.01) b.passTarget = -1; // tocó el suelo: balón suelto
  return false;
}

export function takeBall(g: GameState, q: PlayerState): void {
  const b = g.ball;
  b.holder = q.id;
  b.passTarget = -1;
  b.shotInFlight = false;
  g.possession = q.team;
  q.interceptT = 0;
  q.play = null;
  q.holdT = 0;
}
