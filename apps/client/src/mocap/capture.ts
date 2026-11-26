/**
 * Captura desde vídeo → clip del juego. Funciona en el navegador (estudio de mocap) y en Node.
 *
 * Una captura guarda, por fotograma, lo que vio MediaPipe Pose (puntos en metros centrados en la cadera y
 * puntos de imagen 0–1) y dónde se detectó el balón en la imagen. Hornearla:
 *  1. Ejes de MediaPipe (x derecha, y abajo, z alejándose de la cámara) → los del juego (y arriba, z hacia
 *     la cámara). Es un giro de 180° sobre X, así que no espeja.
 *  2. Limpieza: fuera puntos con visibilidad < 0,5 y saltos sueltos (mediana de 7), huecos interpolados,
 *     suavizado gaussiano sin desfase (el vídeo está grabado: se puede mirar hacia delante).
 *  3. Suelo bajo el pie más bajo. El salto no sale en los puntos de MediaPipe (van centrados en la cadera):
 *     se mide en la imagen, por cuánto suben los tobillos respecto a lo normal.
 *  4. Retargeting (retarget.ts) + rumbo (yaw) aparte, porque en un pivote el giro ES el movimiento.
 *  5. Balón: posición en la imagen → metros con la escala del cuerpo; profundidad la de la mano más cercana.
 *     Si está a menos de ~25 cm de una muñeca, "va en la mano" (en el juego se pega a la palma del rig).
 */
import * as THREE from 'three';
import { retarget, RIG_HIP_Y, SLOTS, toBodySpace, type Pose } from './retarget';

export interface CaptureFrame {
  /** Segundos desde el inicio del tramo analizado. */
  t: number;
  /** 33 puntos de MediaPipe en metros: [x, y, z, visibilidad]. */
  w: number[][] | null;
  /** 33 puntos de imagen (0–1): [x, y]. */
  n: number[][] | null;
  /** Balón en la imagen: [x, y, radio], todo en fracción del ancho/alto (radio: del ancho). */
  ball: [number, number, number] | null;
}

export interface Exaggerate {
  /** Multiplica la altura del salto. */
  jump: number;
  /** Multiplica cuánto se aparta cada articulación de la postura de reposo. */
  pose: number;
}
export const DEFAULT_EXAGGERATE: Exaggerate = { jump: 1, pose: 1 };

export interface Capture {
  version: 1;
  name: string;
  /** Fotogramas por segundo del análisis. */
  fps: number;
  /** Tamaño del vídeo en píxeles (para pasar de imagen a metros sin deformar). */
  width: number;
  height: number;
  /** Tramo del vídeo analizado (segundos). */
  range: [number, number];
  frames: CaptureFrame[];
  exaggerate: Exaggerate;
}

/** Clip horneado: lo que lee el juego (src/mocap/clip.ts). */
export interface MocapClipJson {
  source: string;
  fps: number;
  loop: false;
  duration: number;
  /** Por frame: rootY, 9 cuaterniones (x,y,z,w) en el orden de SLOTS, −1 (hueco del balón de los clips CMU). */
  frames: number[][];
  /** Rumbo del cuerpo (rad) respecto a la cámara del vídeo: 0 = de frente. */
  yaw: number[];
  /** Altura del salto (unidades del rig de 2,00 m). */
  lift: number[];
  /** Balón por frame: [x, y, z (rig, relativo a la cadera, con el salto incluido), peso mano izq., peso mano der.]. */
  ball: number[][];
  /** Exageración elegida en el estudio. */
  exaggerate: Exaggerate;
}

// Puntos de MediaPipe que se usan (impares = izquierda).
export const MP = {
  nose: 0, shL: 11, shR: 12, elL: 13, elR: 14, wrL: 15, wrR: 16,
  hipL: 23, hipR: 24, knL: 25, knR: 26, anL: 27, anR: 28, heelL: 29, heelR: 30, toeL: 31, toeR: 32,
} as const;
export const SKELETON_POINTS = Object.values(MP);
/** Huesos del esqueleto de comprobación (índices en SKELETON_POINTS). */
const NAMES = Object.keys(MP) as (keyof typeof MP)[];
export const SKELETON_BONES: [number, number][] = (
  [
    ['shL', 'shR'], ['hipL', 'hipR'], ['shL', 'hipL'], ['shR', 'hipR'],
    ['shL', 'elL'], ['elL', 'wrL'], ['shR', 'elR'], ['elR', 'wrR'],
    ['hipL', 'knL'], ['knL', 'anL'], ['anL', 'heelL'], ['heelL', 'toeL'], ['anL', 'toeL'],
    ['hipR', 'knR'], ['knR', 'anR'], ['anR', 'heelR'], ['heelR', 'toeR'], ['anR', 'toeR'],
  ] as const
).map(([a, b]) => [NAMES.indexOf(a), NAMES.indexOf(b)]);

/** Radio real del balón (talla 7). */
const BALL_R = 0.12;

// ---------------------------------------------------------------------------
type Track = (THREE.Vector3 | null)[];

function fillGaps(t: Track, maxGap = Infinity): (THREE.Vector3 | null)[] {
  const out: (THREE.Vector3 | null)[] = new Array(t.length).fill(null);
  const valid: number[] = [];
  t.forEach((p, i) => p && valid.push(i));
  if (valid.length === 0) return maxGap === Infinity ? t.map(() => new THREE.Vector3()) : out;
  let k = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i]) {
      out[i] = t[i]!.clone();
      continue;
    }
    while (k < valid.length && valid[k]! < i) k++;
    const a = k > 0 ? valid[k - 1]! : -1;
    const b = k < valid.length ? valid[k]! : -1;
    if (a >= 0 && b >= 0) {
      if (b - a - 1 <= maxGap) out[i] = t[a]!.clone().lerp(t[b]!, (i - a) / (b - a));
    } else if (maxGap === Infinity) out[i] = t[a >= 0 ? a : b]!.clone();
  }
  return out;
}

function median(t: THREE.Vector3[], half: number): THREE.Vector3[] {
  const med = (xs: number[]) => xs.sort((x, y) => x - y)[xs.length >> 1]!;
  return t.map((_, i) => {
    const w = t.slice(Math.max(0, i - half), Math.min(t.length, i + half + 1));
    return new THREE.Vector3(med(w.map((p) => p.x)), med(w.map((p) => p.y)), med(w.map((p) => p.z)));
  });
}

export function gauss(xs: number[], sigma: number): number[] {
  if (sigma <= 0) return xs.slice();
  const r = Math.ceil(sigma * 3);
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  return xs.map((_, i) => {
    let s = 0;
    let ws = 0;
    for (let d = -r; d <= r; d++) {
      const j = Math.min(xs.length - 1, Math.max(0, i + d));
      s += xs[j]! * k[d + r]!;
      ws += k[d + r]!;
    }
    return s / ws;
  });
}
const gaussV = (t: THREE.Vector3[], sigma: number) => {
  const x = gauss(t.map((p) => p.x), sigma);
  const y = gauss(t.map((p) => p.y), sigma);
  const z = gauss(t.map((p) => p.z), sigma);
  return t.map((_, i) => new THREE.Vector3(x[i], y[i], z[i]));
};
const mid = (a: THREE.Vector3, b: THREE.Vector3) => a.clone().add(b).multiplyScalar(0.5);
const sortedMedian = (xs: number[]) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1]! : NaN;
};

export interface Baked {
  clip: MocapClipJson;
  /** Esqueleto de MediaPipe por frame (SKELETON_POINTS × xyz, metros, suelo en y = 0) para comparar. */
  skeleton: number[][];
  /** Balón en metros (mismo espacio que el esqueleto) o null si no se vio. */
  ballMeters: (number[] | null)[];
  stats: { legLen: number; maxJump: number; ballSeen: number };
}

export function bakeCapture(cap: Capture, clean = true): Baked {
  const N = cap.frames.length;
  const W = cap.width;
  const H = cap.height;

  // --- 1–2. Pistas de los 33 puntos, limpias ---
  const tracks = Array.from({ length: 33 }, (_, j) => {
    const raw: Track = cap.frames.map((f) => {
      const p = f.w?.[j];
      if (!p || (clean && p[3]! < 0.5)) return null;
      return new THREE.Vector3(p[0]!, -p[1]!, -p[2]!);
    });
    const filled = fillGaps(raw) as THREE.Vector3[];
    return clean ? gaussV(median(filled, 3), 2.2) : filled;
  });
  const P = (j: number, i: number) => tracks[j]![i]!;

  // --- 3. Escala, suelo y salto ---
  const legLen = sortedMedian(
    Array.from({ length: N }, (_, i) => P(MP.hipL, i).distanceTo(P(MP.knL, i)) + P(MP.knL, i).distanceTo(P(MP.anL, i))),
  );
  const standHipY = legLen + 0.08;
  const floor = gauss(
    Array.from({ length: N }, (_, i) => Math.min(...[MP.heelL, MP.heelR, MP.toeL, MP.toeR, MP.anL, MP.anR].map((j) => P(j, i).y))),
    clean ? 3 : 0.5,
  );

  // Puntos de imagen en píxeles (para que x e y tengan la misma escala).
  const px = (i: number, j: number) => {
    const n = cap.frames[i]!.n;
    return n ? new THREE.Vector2(n[j]![0]! * W, n[j]![1]! * H) : null;
  };
  // Metros por píxel: pierna (cadera→rodilla→tobillo) en metros / en píxeles, mediana móvil de ±1 s.
  const legPx = Array.from({ length: N }, (_, i) => {
    const h = px(i, MP.hipL);
    const k = px(i, MP.knL);
    const a = px(i, MP.anL);
    const h2 = px(i, MP.hipR);
    const k2 = px(i, MP.knR);
    const a2 = px(i, MP.anR);
    if (!h || !k || !a || !h2 || !k2 || !a2) return NaN;
    return Math.max(h.distanceTo(k) + k.distanceTo(a), h2.distanceTo(k2) + k2.distanceTo(a2));
  });
  const win = Math.round(cap.fps);
  const mpp = legPx.map((_, i) => legLen / sortedMedian(legPx.slice(Math.max(0, i - win), i + win + 1)));

  // Salto: subida del tobillo más bajo en pantalla respecto a su altura habitual.
  const ankY = Array.from({ length: N }, (_, i) => {
    const a = px(i, MP.anL);
    const b = px(i, MP.anR);
    return a && b ? Math.max(a.y, b.y) : NaN;
  });
  const sorted = ankY.filter(Number.isFinite).sort((a, b) => a - b);
  const baseAnk = sorted[Math.floor(sorted.length * 0.6)] ?? 0;
  const jumpRaw = ankY.map((a, i) => (Number.isFinite(a) && Number.isFinite(mpp[i]!) ? Math.max(0, (baseAnk - a) * mpp[i]!) : 0));
  // Solo cuenta como salto si supera 6 cm (lo demás es ruido o la cámara moviéndose).
  const jump = gauss(jumpRaw, 2).map((j) => (j > 0.06 ? j - 0.06 : 0));

  // --- 4. Retargeting ---
  const poses: Pose[] = Array.from({ length: N }, (_, i) => {
    const lift = new THREE.Vector3(0, -floor[i]! + 0.03, 0); // 3 cm: del talón a la suela
    const g = (j: number) => P(j, i).clone().add(lift);
    return {
      Hips: mid(g(MP.hipL), g(MP.hipR)),
      Neck: mid(g(MP.shL), g(MP.shR)),
      LeftUpLeg: g(MP.hipL), LeftLeg: g(MP.knL), LeftFoot: g(MP.anL), LeftToeBase: g(MP.toeL),
      RightUpLeg: g(MP.hipR), RightLeg: g(MP.knR), RightFoot: g(MP.anR), RightToeBase: g(MP.toeR),
      LeftArm: g(MP.shL), LeftForeArm: g(MP.elL), LeftHand: g(MP.wrL),
      RightArm: g(MP.shR), RightForeArm: g(MP.elR), RightHand: g(MP.wrR),
    };
  });
  const { body, yaw } = toBodySpace(poses, clean ? 3 : 0);
  // Con el tronco recto la base del tronco ya coincide con la del rig: sin corrección.
  const frames = body.map((p) => retarget(p, standHipY, new THREE.Quaternion()));
  const k = RIG_HIP_Y / standHipY;
  /** Altura sobre el suelo en metros de un punto en coordenadas de MediaPipe (ya giradas). */
  const up = (y: number, i: number) => y - floor[i]! + 0.03 + jump[i]!;

  // --- 5. Balón ---
  const ballRaw: Track = cap.frames.map((f, i) => {
    const hl = px(i, MP.hipL);
    const hr = px(i, MP.hipR);
    if (!f.ball || !hl || !hr || !Number.isFinite(mpp[i]!)) return null;
    const hip = hl.add(hr).multiplyScalar(0.5);
    const x = (f.ball[0] * W - hip.x) * mpp[i]!;
    const y = -(f.ball[1] * H - hip.y) * mpp[i]!;
    // Profundidad: la de la muñeca más cercana en el plano de la imagen.
    const wl = P(MP.wrL, i);
    const wr = P(MP.wrR, i);
    const dl = Math.hypot(wl.x - x, wl.y - y);
    const dr = Math.hypot(wr.x - x, wr.y - y);
    return new THREE.Vector3(x, y, dl < dr ? wl.z : wr.z);
  });
  const ballSeen = ballRaw.filter(Boolean).length;
  const ballFilled = fillGaps(ballRaw, Math.round(cap.fps * 0.2));
  // Mediana de 3 para quitar detecciones sueltas sin redondear los botes.
  const ballM: (THREE.Vector3 | null)[] = ballFilled.map((b, i) => {
    if (!b) return null;
    const near = [ballFilled[i - 1], b, ballFilled[i + 1]].filter(Boolean) as THREE.Vector3[];
    return near.length === 3 ? median(near, 1)[1]! : b;
  });
  // Peso "en la mano" para cada mano: 1 si el balón está a < 18 cm de la muñeca, 0 a partir de 32 cm.
  // Si no se ve el balón, se queda en la última mano que lo tuvo (lo más probable es que lo tape el cuerpo).
  let lastSide: 0 | 1 = 1;
  const holdL: number[] = [];
  const holdR: number[] = [];
  ballM.forEach((b, i) => {
    if (!b) {
      holdL.push(lastSide === 0 ? 1 : 0);
      holdR.push(lastSide === 1 ? 1 : 0);
      return;
    }
    const dl = b.distanceTo(P(MP.wrL, i));
    const dr = b.distanceTo(P(MP.wrR, i));
    const hold = (d: number) => 1 - THREE.MathUtils.smoothstep(d, 0.18, 0.32);
    holdL.push(hold(dl));
    holdR.push(hold(dr));
    if (Math.min(dl, dr) < 0.32) lastSide = dl < dr ? 0 : 1;
  });
  const wL = gauss(holdL, 1.5);
  const wR = gauss(holdR, 1.5);
  // Sin detección: posición libre = muñeca de esa mano (el juego lo pega a la palma de todos modos).
  const ballMeters = ballM.map((b, i) => {
    const q = b ?? (wL[i]! > wR[i]! ? P(MP.wrL, i) : P(MP.wrR, i));
    return [q.x, Math.max(BALL_R, up(q.y, i)), q.z];
  });

  const r = (x: number) => Math.round(x * 1000) / 1000;
  const clip: MocapClipJson = {
    source: `Vídeo → MediaPipe Pose (estudio de mocap): ${cap.name}`,
    fps: cap.fps,
    loop: false,
    duration: +(N / cap.fps).toFixed(3),
    frames: frames.map((f) => [r(f.rootY), ...f.q.flatMap((q) => [r(q.x), r(q.y), r(q.z), r(q.w)]), -1]),
    yaw: yaw.map(r),
    lift: jump.map((j) => r(j * k)),
    ball: ballMeters.map((b, i) => [r(b[0]! * k), r(b[1]! * k), r(b[2]! * k), r(wL[i]!), r(wR[i]!)]),
    exaggerate: { ...cap.exaggerate },
  };
  const skeleton = Array.from({ length: N }, (_, i) =>
    SKELETON_POINTS.flatMap((j) => {
      const q = P(j, i);
      return [r(q.x), r(up(q.y, i)), r(q.z)];
    }),
  );
  return {
    clip,
    skeleton,
    ballMeters: ballM.map((b, i) => (b ? [b.x, Math.max(BALL_R, up(b.y, i)), b.z] : null)),
    stats: { legLen, maxJump: Math.max(0, ...jump), ballSeen },
  };
}

export { SLOTS };
