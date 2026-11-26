import { COURT, hoopX } from './court';
import { attackSide, PLAYER, type GameEvent, type GameState, type PlayerState } from './game';
import { ballisticVelocity } from './shot';

/**
 * Finalizaciones cerca del aro: BANDEJA o MATE.
 * Se activan al tirar (o la IA sola) si el jugador está bajo el aro o cerca y yendo hacia él.
 * Recorrido: dos pasos de recogida hacia el aro → salto → suelta (bandeja) o machaca (mate).
 */
export type Finish = { kind: 'layup' | 'dunk'; t: number; released: boolean };

export const FINISH = {
  /** "Bajo el aro": distancia horizontal al aro. */
  underRim: 1.7,
  /** "Cerca y en dirección a él": distancia y velocidad mínima hacia el aro. */
  driveRange: 3.4,
  driveSpeed: 2.0,
  /** Quién puede machacar: muy alto, o alto llegando lanzado. */
  dunkHeight: 2.05,
  dunkHeightRunning: 1.95,
  dunkRunSpeed: 3.0,
  gatherTime: 0.28,
  jumpTime: 0.5,
  layupJump: 0.6,
  dunkJump: 0.8,
  /** Punto de despegue respecto al aro (delante del aro, hacia el jugador). */
  layupTakeoff: 1.0,
  dunkTakeoff: 0.7,
  layupMake: 0.88,
  dunkMake: 0.95,
  /** Cuánto resta un defensor encima (0..1 de "oposición"): bandeja y mate. */
  layupContest: 0.5,
  dunkContest: 0.35,
} as const;

/**
 * Oposición defensiva sobre `p` (0 = solo, ~1 = un defensor alto encima).
 * Cuenta los rivales a menos de 1,6 m, más cuanto más cerca y más altos.
 */
export function contest(g: GameState, p: PlayerState): number {
  let c = 0;
  for (const q of g.players) {
    if (q.team === p.team) continue;
    const d = Math.hypot(q.x - p.x, q.z - p.z);
    if (d < 1.6) c += ((1.6 - d) / 1.2) * (q.height / 2);
  }
  return Math.min(1.2, c);
}

const hoopOf = (p: PlayerState) => ({ x: hoopX(attackSide(p.team)), z: 0 });

/** ¿Debería este jugador finalizar (y cómo)? null si no está en situación. */
export function finishKind(p: PlayerState): Finish['kind'] | null {
  const h = hoopOf(p);
  const dx = h.x - p.x;
  const dz = h.z - p.z;
  const d = Math.hypot(dx, dz);
  const toward = d > 1e-6 ? (p.vx * dx + p.vz * dz) / d : 0;
  const near = d <= FINISH.underRim || (d <= FINISH.driveRange && toward > FINISH.driveSpeed);
  if (!near) return null;
  const dunk = p.height >= FINISH.dunkHeight || (p.height >= FINISH.dunkHeightRunning && toward > FINISH.dunkRunSpeed);
  return dunk ? 'dunk' : 'layup';
}

export function startFinish(p: PlayerState, kind: Finish['kind'], ev: GameEvent[]): void {
  p.finish = { kind, t: 0, released: false };
  ev.push({ type: 'finish', playerId: p.id, kind });
}

/** Altura del salto de la finalización en este instante (para render y alcance). */
export function finishLift(p: PlayerState): number {
  const f = p.finish;
  if (!f || f.t < FINISH.gatherTime) return 0;
  const u = Math.min(1, (f.t - FINISH.gatherTime) / FINISH.jumpTime);
  return Math.sin(u * Math.PI) * (f.kind === 'dunk' ? FINISH.dunkJump : FINISH.layupJump);
}

/** Mueve al jugador durante la finalización y suelta el balón en lo alto del salto. */
export function stepFinish(g: GameState, p: PlayerState, dt: number, rng: () => number, ev: GameEvent[]): void {
  const f = p.finish!;
  f.t += dt;
  const side = attackSide(p.team);
  const h = hoopOf(p);
  // Despegue delante del aro, del lado por el que llega.
  const takeoff = f.kind === 'dunk' ? FINISH.dunkTakeoff : FINISH.layupTakeoff;
  const ang = Math.atan2(p.z - h.z, p.x - h.x);
  const tx = h.x + Math.cos(ang) * takeoff;
  const tz = h.z + Math.sin(ang) * takeoff;
  const remaining = Math.max(0.12, FINISH.gatherTime + FINISH.jumpTime * 0.5 - f.t);
  const dx = tx - p.x;
  const dz = tz - p.z;
  const sp = Math.min(6.5, Math.hypot(dx, dz) / remaining);
  const dl = Math.hypot(dx, dz) || 1;
  p.vx = (dx / dl) * sp;
  p.vz = (dz / dl) * sp;
  p.x += p.vx * dt;
  p.z += p.vz * dt;
  p.facing = Math.atan2(h.x - p.x, h.z - p.z);

  // Suelta en lo alto del salto.
  const releaseAt = FINISH.gatherTime + FINISH.jumpTime * (f.kind === 'dunk' ? 0.5 : 0.45);
  const b = g.ball;
  if (!f.released && f.t >= releaseAt && b.holder === p.id) {
    f.released = true;
    const c = contest(g, p);
    const make = rng() < (f.kind === 'dunk' ? FINISH.dunkMake - FINISH.dunkContest * c : FINISH.layupMake - FINISH.layupContest * c);
    Object.assign(b, { holder: -1, shooter: p.id, shotInFlight: true, shotIsThree: false, scored: false, passTarget: -1 });
    if (f.kind === 'dunk') {
      // Machaca: el balón entra desde encima del aro (o rebota en el aro delantero si falla).
      const off = make ? 0 : 0.2;
      b.x = h.x - side * off;
      b.z = h.z;
      b.y = COURT.rimHeight + 0.3;
      b.vx = make ? 0 : -side * 1.5;
      b.vz = 0;
      b.vy = -4;
    } else {
      // Bandeja: tiro suave y alto desde la mano.
      const from = { x: p.x + Math.sin(p.facing) * 0.3, y: p.height + finishLift(p) + 0.35, z: p.z + Math.cos(p.facing) * 0.3 };
      const v = ballisticVelocity(from, { x: h.x, y: COURT.rimHeight, z: h.z }, (72 * Math.PI) / 180) ?? { x: 0, y: 4, z: 0 };
      const err = make ? 1 : rng() < 0.5 ? 0.8 : 1.22;
      Object.assign(b, { x: from.x, y: from.y, z: from.z, vx: v.x * err, vy: v.y * err, vz: v.z * err });
    }
    p.pickupCooldown = 0.5;
    ev.push({ type: 'shot', playerId: p.id, quality: f.kind === 'dunk' ? 'perfect' : 'good', meter: 0 });
  }
  if (f.t >= FINISH.gatherTime + FINISH.jumpTime) {
    p.finish = null;
    p.jump = PLAYER.jumpTime * 0.6; // aterrizaje
  }
}
