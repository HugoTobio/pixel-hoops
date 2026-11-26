import { COURT } from './court';
import type { PlayerInput, PlayerState } from './game';

export interface P2 {
  x: number;
  z: number;
}

export const STEER = {
  /** Radio de frenado al llegar al punto objetivo. */
  arriveRadius: 1.1,
  deadZone: 0.12,
} as const;

export const dist = (a: P2, b: P2) => Math.hypot(a.x - b.x, a.z - b.z);

export const toward = (from: P2, to: P2, d: number): P2 => {
  const L = dist(from, to) || 1;
  return { x: from.x + ((to.x - from.x) / L) * d, z: from.z + ((to.z - from.z) / L) * d };
};

/** Input para ir a `target` frenando al llegar, mirando a `look`. */
export function steer(p: PlayerState, target: P2, look: P2): PlayerInput {
  target.x = Math.max(-COURT.halfL + 0.3, Math.min(COURT.halfL - 0.3, target.x));
  target.z = Math.max(-COURT.halfW + 0.3, Math.min(COURT.halfW - 0.3, target.z));
  const d = dist(p, target);
  if (d < STEER.deadZone) return { mx: 0, mz: 0, shoot: false, look };
  const mag = Math.min(1, d / STEER.arriveRadius);
  return { mx: ((target.x - p.x) / d) * mag, mz: ((target.z - p.z) / d) * mag, shoot: false, look };
}
