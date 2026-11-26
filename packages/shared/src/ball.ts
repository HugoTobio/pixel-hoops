import { boardX, COURT, hoopX, SIDES, type Side } from './court';

export const BALL = {
  radius: 0.12,
  gravity: 9.81,
  floorRestitution: 0.74,
  rimRestitution: 0.45,
  boardRestitution: 0.6,
  wallRestitution: 0.4,
  rollFriction: 1.2,
} as const;

export interface BallState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** id del jugador que lo tiene, o −1 si está suelto. */
  holder: number;
  /** id del último tirador (−1 si ninguno). */
  shooter: number;
  /** Está en el aire tras un tiro (aún no ha tocado el suelo). */
  shotInFlight: boolean;
  shotIsThree: boolean;
  /** Ya se anotó en este vuelo (evita contar dos veces). */
  scored: boolean;
  /** Receptor del pase en vuelo (−1 si no es un pase). */
  passTarget: number;
  /** Quién hizo el último pase (−1 si ninguno). */
  passer: number;
}

export type BallEvent =
  | { type: 'score'; side: Side; points: 2 | 3; shooter: number }
  | { type: 'rim'; speed: number }
  | { type: 'board'; speed: number }
  | { type: 'bounce'; speed: number };

const R = BALL.radius;

function collideBoard(b: BallState, side: Side, ev: BallEvent[]) {
  const face = Math.abs(boardX(side));
  const sx = side * b.x; // distancia "hacia el fondo" para esta canasta
  if (b.y < COURT.boardBottom - R || b.y > COURT.boardTop + R) return;
  if (Math.abs(b.z) > COURT.boardHalfWidth + R) return;
  if (sx + R <= face || sx > face + COURT.boardThickness) return;
  if (side * b.vx <= 0) return; // ya se aleja
  ev.push({ type: 'board', speed: Math.abs(b.vx) });
  b.x = side * (face - R);
  b.vx = -b.vx * BALL.boardRestitution;
  b.vy *= 0.92;
  b.vz *= 0.92;
}

function collideRim(b: BallState, side: Side, ev: BallEvent[]) {
  const hx = hoopX(side);
  let dx = b.x - hx;
  let dz = b.z;
  const L = Math.hypot(dx, dz);
  if (L < 1e-6) {
    dx = 1;
    dz = 0;
  } else {
    dx /= L;
    dz /= L;
  }
  // Punto más cercano del aro (círculo) al centro del balón.
  const cx = hx + dx * COURT.rimRadius;
  const cz = dz * COURT.rimRadius;
  const nx = b.x - cx;
  const ny = b.y - COURT.rimHeight;
  const nz = b.z - cz;
  const d = Math.hypot(nx, ny, nz);
  const minD = R + COURT.rimTube;
  if (d >= minD || d < 1e-6) return;
  const ux = nx / d;
  const uy = ny / d;
  const uz = nz / d;
  b.x += ux * (minD - d);
  b.y += uy * (minD - d);
  b.z += uz * (minD - d);
  const vn = b.vx * ux + b.vy * uy + b.vz * uz;
  if (vn < 0) {
    ev.push({ type: 'rim', speed: -vn });
    const k = (1 + BALL.rimRestitution) * vn;
    b.vx = (b.vx - k * ux) * 0.9;
    b.vy = (b.vy - k * uy) * 0.9;
    b.vz = (b.vz - k * uz) * 0.9;
  }
}

function checkScore(b: BallState, side: Side, prevY: number, ev: BallEvent[]) {
  if (b.scored || b.vy >= 0) return;
  if (!(prevY >= COURT.rimHeight && b.y < COURT.rimHeight)) return;
  if (Math.hypot(b.x - hoopX(side), b.z) >= COURT.rimRadius) return;
  b.scored = true;
  ev.push({ type: 'score', side, points: b.shotInFlight && b.shotIsThree ? 3 : 2, shooter: b.shooter });
}

/** Integra el balón suelto con sub-pasos (evita atravesar el aro a velocidad de tiro). */
export function stepBall(b: BallState, dt: number, ev: BallEvent[]): void {
  const steps = 4;
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    const prevY = b.y;
    b.vy -= BALL.gravity * h;
    b.x += b.vx * h;
    b.y += b.vy * h;
    b.z += b.vz * h;

    for (const side of SIDES) {
      collideBoard(b, side, ev);
      collideRim(b, side, ev);
      checkScore(b, side, prevY, ev);
    }

    if (b.y < R) {
      b.y = R;
      if (b.vy < 0) {
        if (b.vy < -1) ev.push({ type: 'bounce', speed: -b.vy });
        b.vy = -b.vy * BALL.floorRestitution;
        if (b.vy < 0.4) b.vy = 0;
        b.shotInFlight = false;
      }
    }
    if (Math.abs(b.x) > COURT.wallX - R) {
      b.x = Math.sign(b.x) * (COURT.wallX - R);
      b.vx = -b.vx * BALL.wallRestitution;
    }
    if (Math.abs(b.z) > COURT.wallZ - R) {
      b.z = Math.sign(b.z) * (COURT.wallZ - R);
      b.vz = -b.vz * BALL.wallRestitution;
    }
  }
  if (b.y <= R + 1e-3) {
    const f = Math.max(0, 1 - BALL.rollFriction * dt);
    b.vx *= f;
    b.vz *= f;
  }
}
