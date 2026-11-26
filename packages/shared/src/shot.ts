import { BALL } from './ball';
import { COURT } from './court';

export const SHOT = {
  /** Segundos que tarda la barra en llenarse (meter = 1). */
  meterTime: 0.7,
  /** Punto ideal de soltar, en fracción de la barra. */
  sweet: 0.88,
  /** ± alrededor del punto ideal que cuenta como "perfecto". */
  /** ± alrededor del punto ideal que cuenta como "perfecto" con un defensor encima. */
  perfectWindow: 0.05,
  /** ...y estando solo (p. ej. tras un bloqueo): mucho más fácil. */
  perfectWindowOpen: 0.16,
  /** Distancia al defensor más cercano: hasta aquí cuenta como "encima"; desde `openFrom`, "solo". */
  guardedUntil: 1.4,
  openFrom: 4.0,
  /** "Bien" = zona verde + este margen. */
  goodMargin: 0.09,
  /** Si no sueltas, se suelta solo (muy tarde) al llegar aquí. */
  autoRelease: 1.25,
  /** El balón sale por encima de la cabeza: altura del jugador + esto (incluye el salto). */
  releaseAboveHead: 0.4,
  minEntryAngle: (45 * Math.PI) / 180,
} as const;

export type ShotQuality = 'perfect' | 'good' | 'early' | 'late';

/** Tamaño de la zona verde (±) según la distancia al defensor más cercano. */
export function perfectWindowFor(nearestDefender: number): number {
  const t = Math.max(0, Math.min(1, (nearestDefender - SHOT.guardedUntil) / (SHOT.openFrom - SHOT.guardedUntil)));
  const s = t * t * (3 - 2 * t);
  return SHOT.perfectWindow + (SHOT.perfectWindowOpen - SHOT.perfectWindow) * s;
}

export function rateRelease(meter: number, window: number = SHOT.perfectWindow): { quality: ShotQuality; penalty: number; late: boolean } {
  const err = Math.abs(meter - SHOT.sweet);
  const late = meter > SHOT.sweet;
  const quality: ShotQuality =
    err <= window ? 'perfect' : err <= window + SHOT.goodMargin ? 'good' : late ? 'late' : 'early';
  return { quality, penalty: Math.max(0, err - window), late };
}

export interface V3 {
  x: number;
  y: number;
  z: number;
}

/** Velocidad de lanzamiento para llegar de `from` a `to` con el ángulo dado (parábola sin rozamiento). */
export function ballisticVelocity(from: V3, to: V3, angle: number): V3 | null {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const d = Math.hypot(dx, dz);
  const dh = to.y - from.y;
  if (d < 1e-3) return null;
  const c = Math.cos(angle);
  const denom = 2 * c * c * (d * Math.tan(angle) - dh);
  if (denom <= 0) return null;
  const v = Math.sqrt((BALL.gravity * d * d) / denom);
  const vh = v * c;
  return { x: (dx / d) * vh, y: v * Math.sin(angle), z: (dz / d) * vh };
}

/** Normal estándar a partir de un generador uniforme (Box–Muller). */
export function gauss(rng: () => number): number {
  const u = Math.max(1e-9, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/**
 * Calcula la velocidad real del tiro: trayectoria ideal + error según timing y distancia.
 * Determinista dado `rng`, para que el servidor obtenga lo mismo.
 */
export function shotVelocity(
  from: V3,
  target: V3,
  meter: number,
  rng: () => number,
  contest = 0,
  window: number = SHOT.perfectWindow,
): { v: V3; quality: ShotQuality } {
  const d = Math.hypot(target.x - from.x, target.z - from.z);
  // Distancia horizontal al borde cercano del aro: ahí el balón debe ir ya por encima.
  const nearEdge = d - (COURT.rimRadius + BALL.radius + 0.06);
  let v: V3 | null = null;
  for (let deg = 50; deg <= 82 && !v; deg += 1) {
    const a = (deg * Math.PI) / 180;
    const cand = ballisticVelocity(from, target, a);
    if (!cand) continue;
    // Ángulo de entrada: por debajo de ~44° el hueco efectivo del aro es casi el balón.
    const vh0 = Math.hypot(cand.x, cand.z);
    const vyEnd = cand.y - BALL.gravity * (d / vh0);
    if (Math.atan2(-vyEnd, vh0) < SHOT.minEntryAngle) continue;
    if (nearEdge > 0) {
      const vh = Math.hypot(cand.x, cand.z);
      const tEdge = nearEdge / vh;
      const yEdge = from.y + cand.y * tEdge - 0.5 * BALL.gravity * tEdge * tEdge;
      if (yEdge < COURT.rimHeight + BALL.radius + 0.08) continue;
    }
    v = cand;
  }
  v ??= ballisticVelocity(from, target, (82 * Math.PI) / 180) ?? { x: 0, y: 5, z: 0 };

  const { quality, penalty, late } = rateRelease(meter, window);
  // Un defensor encima (contest ~1) añade bastante error.
  const sigma = 0.003 + 0.0007 * d + penalty * 0.08 + contest * 0.012;
  const power = 1 + (late ? 1 : -1) * penalty * 0.15 + gauss(rng) * sigma;
  const yaw = gauss(rng) * sigma * 0.9;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  return {
    quality,
    v: {
      x: (v.x * cy - v.z * sy) * power,
      y: v.y * power,
      z: (v.x * sy + v.z * cy) * power,
    },
  };
}
