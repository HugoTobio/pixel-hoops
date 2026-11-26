/**
 * Captura desde vídeo → landmarks limpios → clip del juego. Funciona en el navegador (estudio) y en Node.
 *
 * Una captura guarda, por fotograma, lo que vio MediaPipe Pose (puntos en metros centrados en la cadera y
 * puntos de imagen 0–1), dónde se detectó el balón y las correcciones a mano (keyframes del balón).
 *
 *  1. Ejes de MediaPipe (x derecha, y abajo, z alejándose de la cámara) → los del juego (y arriba, z hacia
 *     la cámara). Es un giro de 180° sobre X, así que no espeja.
 *  2. Limpieza: fuera puntos con visibilidad < 0,5 y saltos sueltos (mediana de 7), huecos interpolados,
 *     suavizado gaussiano sin desfase (el vídeo está grabado: se puede mirar hacia delante).
 *  3. Suelo bajo el pie más bajo. El salto no sale en los puntos de MediaPipe (van centrados en la cadera):
 *     se mide en la imagen, por cuánto suben los tobillos respecto a lo normal.
 *  4. Pies fijos: se detecta cuándo cada pie está apoyado; mientras lo está, el pie no se mueve y es el cuerpo
 *     el que se desplaza (de ahí sale el desplazamiento de la raíz, "root motion").
 *  5. Balón: detección corregida con los keyframes → metros con la escala del cuerpo; profundidad la de la
 *     mano más cercana. A menos de ~25 cm de una muñeca "va en la mano" (en el juego se pega a la palma).
 *  6. Retargeting (retarget.ts) + rumbo (yaw) aparte, porque en un pivote el giro ES el movimiento.
 */
import * as THREE from 'three';
import { retarget, RIG_HIP_Y, toBodySpace, torsoBasis, type ArmHints, type Pose } from './retarget';

export interface CaptureFrame {
  /** Segundos desde el inicio del tramo analizado. */
  t: number;
  /** 33 puntos de MediaPipe en metros: [x, y, z, visibilidad]. */
  w: number[][] | null;
  /** 33 puntos de imagen (0–1): [x, y]. */
  n: number[][] | null;
  /** Balón detectado en la imagen: [x, y, radio], en fracción del ancho/alto (radio: del ancho). */
  ball: [number, number, number] | null;
}

/** Mano forzada en un keyframe del balón. */
export type HandOverride = 'auto' | 'L' | 'R' | 'free';
/**
 * Corrección manual del balón en un fotograma.
 * `p` es la posición 3D en metros: x/z respecto al centro de la cadera (ejes del mundo, sin girar con el
 * jugador) e y = altura sobre el suelo. `x`/`y` es dónde cae en la imagen (0–1), solo como referencia; si
 * falta `p` (keyframes antiguos) se calcula desde la imagen con la profundidad de la mano más cercana.
 */
export interface BallKey {
  /** Fotograma, contado desde el inicio de lo analizado (no del recorte). */
  f: number;
  x: number;
  y: number;
  p?: [number, number, number];
  hand: HandOverride;
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
  /** Correcciones a mano del balón, ordenadas por fotograma. */
  ballKeys?: BallKey[];
  /** Pies fijos en el suelo mientras están apoyados (por defecto sí). */
  feetLock?: boolean;
  /** Recorte (segundos del vídeo) dentro de lo analizado: lo de fuera no entra en el clip. */
  trim?: [number, number];
}

/** Fotogramas (de lo analizado) que entran en el clip según el recorte: [primero, último]. */
export function trimFrames(cap: Capture): [number, number] {
  const n = cap.frames.length;
  const [a, b] = cap.trim ?? cap.range;
  const f0 = Math.max(0, Math.min(n - 2, Math.round((a - cap.range[0]) * cap.fps)));
  const f1 = Math.max(f0 + 1, Math.min(n - 1, Math.round((b - cap.range[0]) * cap.fps)));
  return [f0, f1];
}

/** Clip horneado: lo que lee el juego (src/mocap/clip.ts). Distancias en unidades del rig de 2,00 m. */
export interface MocapClipJson {
  source: string;
  fps: number;
  loop: false;
  duration: number;
  /** Por frame: rootY, 9 cuaterniones (x,y,z,w) en el orden de SLOTS, −1 (hueco del balón de los clips CMU). */
  frames: number[][];
  /** Rumbo del cuerpo (rad) respecto a la cámara del vídeo: 0 = de frente. */
  yaw: number[];
  /** Altura del salto. */
  lift: number[];
  /** Desplazamiento de la raíz en el suelo [x, z] (0 si los pies no van fijos). */
  root: number[][];
  /** Pies: [peso apoyo izq., x, z, peso apoyo der., x, z]; x/z = dónde debe quedar clavado el pie. */
  feet: number[][];
  /** Balón: [x, y, z (con raíz y salto incluidos), peso mano izq., peso mano der.]. */
  ball: number[][];
  /** Exageración elegida en el estudio. */
  exaggerate: Exaggerate;
}

/** Nombres oficiales de los 33 puntos de MediaPipe Pose, en su orden. */
export const MP_NAMES = [
  'nose', 'left_eye_inner', 'left_eye', 'left_eye_outer', 'right_eye_inner', 'right_eye', 'right_eye_outer',
  'left_ear', 'right_ear', 'mouth_left', 'mouth_right', 'left_shoulder', 'right_shoulder', 'left_elbow',
  'right_elbow', 'left_wrist', 'right_wrist', 'left_pinky', 'right_pinky', 'left_index', 'right_index',
  'left_thumb', 'right_thumb', 'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
  'left_heel', 'right_heel', 'left_foot_index', 'right_foot_index',
] as const;

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
/** Parámetros de limpieza (también se escriben en el JSON de landmarks). */
export const CLEANING = { minVisibility: 0.5, medianFrames: 7, gaussSigmaFrames: 2.2 };

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

// --- Keyframes del balón ----------------------------------------------------
export interface Ball2D {
  x: number;
  y: number;
  /** det = detectado · key = keyframe · interp = entre dos keyframes · fix = detección corregida cerca de un keyframe */
  source: 'det' | 'key' | 'interp' | 'fix';
}

/** Cómo influyen los keyframes en el fotograma i. */
function keyInfluence<K extends { f: number }>(keys: K[], i: number, span: number, fade: number): { mode: 'none' | 'replace' | 'fade'; ks: { k: K; w: number }[] } {
  let prev: K | null = null;
  let next: K | null = null;
  for (const k of keys) {
    if (k.f <= i) prev = k;
    if (k.f >= i) {
      next = k;
      break;
    }
  }
  if (prev && prev.f === i) return { mode: 'replace', ks: [{ k: prev, w: 1 }] };
  if (prev && next && next.f - prev.f <= span) {
    const u = (i - prev.f) / (next.f - prev.f);
    return { mode: 'replace', ks: [{ k: prev, w: 1 - u }, { k: next, w: u }] };
  }
  const ks: { k: K; w: number }[] = [];
  for (const k of [prev, next]) {
    if (!k) continue;
    const d = Math.abs(i - k.f);
    if (d < fade) ks.push({ k, w: 1 - THREE.MathUtils.smoothstep(d, 0, fade) });
  }
  return { mode: ks.length ? 'fade' : 'none', ks };
}

// --- Horneado ---------------------------------------------------------------
export interface Baked {
  clip: MocapClipJson;
  /** Los 33 puntos limpios por frame, en metros, ejes del juego, suelo en y = 0 (con pies fijos si toca). */
  world: THREE.Vector3[][];
  /** Visibilidad original de MediaPipe por frame y punto (0 si no se detectó). */
  visibility: number[][];
  /** Esqueleto de comprobación (SKELETON_POINTS × xyz) por frame. */
  skeleton: number[][];
  /** Balón en metros (mismo espacio que world) o null si no se vio ni se corrigió. */
  ballMeters: (number[] | null)[];
  /** Balón en la imagen ya corregido (lo que se dibuja sobre el vídeo). */
  ball2d: (Ball2D | null)[];
  /** Apoyo de cada pie por frame (0–1). */
  contact: { l: number[]; r: number[] };
  stats: { legLen: number; maxJump: number; ballSeen: number; travel: number };
  /** Primer fotograma (de lo analizado) que entra en el clip; los arrays de aquí empiezan en él. */
  f0: number;
  /** Tramo del vídeo que cubre el clip (segundos). */
  range: [number, number];
  /** Metros → unidades del rig. */
  scale: number;
  /** Balón "local" de un fotograma del clip ([x, y, z]: x/z respecto a la cadera, y sobre el suelo) ↔ imagen y mundo. */
  imageToLocal(i: number, u: number, v: number, depth?: number): [number, number, number] | null;
  localToImage(i: number, p: readonly number[]): { x: number; y: number } | null;
  localToWorld(i: number, p: readonly number[]): [number, number, number];
  worldToLocal(i: number, w: readonly number[]): [number, number, number];
  /** Balón final en coordenadas locales (con keyframes aplicados), o null. */
  ballLocal: ([number, number, number] | null)[];
}

export function bakeCapture(full: Capture, clean = true): Baked {
  // Recorte: solo los fotogramas elegidos; los keyframes se cuentan desde el nuevo inicio.
  const [f0, f1] = trimFrames(full);
  const cap: Capture = {
    ...full,
    frames: full.frames.slice(f0, f1 + 1),
    range: [full.range[0] + f0 / full.fps, full.range[0] + f1 / full.fps],
    ballKeys: (full.ballKeys ?? []).filter((k) => k.f >= f0 && k.f <= f1).map((k) => ({ ...k, f: k.f - f0 })),
  };
  const N = cap.frames.length;
  const W = cap.width;
  const H = cap.height;
  const feetLock = cap.feetLock ?? true;

  // --- 1–2. Pistas de los 33 puntos, limpias ---
  const tracks = Array.from({ length: 33 }, (_, j) => {
    const raw: Track = cap.frames.map((f) => {
      const p = f.w?.[j];
      if (!p || (clean && p[3]! < CLEANING.minVisibility)) return null;
      return new THREE.Vector3(p[0]!, -p[1]!, -p[2]!);
    });
    const filled = fillGaps(raw) as THREE.Vector3[];
    return clean ? gaussV(median(filled, (CLEANING.medianFrames - 1) / 2), CLEANING.gaussSigmaFrames) : filled;
  });
  const visibility = cap.frames.map((f) => Array.from({ length: 33 }, (_, j) => f.w?.[j]?.[3] ?? 0));
  if (clean) keepArmLengths(tracks, visibility);
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
    const [h, k, a, h2, k2, a2] = [MP.hipL, MP.knL, MP.anL, MP.hipR, MP.knR, MP.anR].map((j) => px(i, j));
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
  /** Punto en metros con el suelo en y = 0: el punto más bajo de los pies lo toca (sin desplazamiento de raíz). */
  const U = (j: number, i: number) => P(j, i).clone().setY(P(j, i).y - floor[i]! + jump[i]!);

  // --- 4. Pies fijos ---
  const sides = [
    { heel: MP.heelL, toe: MP.toeL, ankle: MP.anL },
    { heel: MP.heelR, toe: MP.toeR, ankle: MP.anR },
  ];
  const sole = (s: number, i: number) => mid(U(sides[s]!.heel, i), U(sides[s]!.toe, i));
  const contactRaw = sides.map((sd) => {
    const c: boolean[] = [];
    for (let i = 0; i < N; i++) {
      const low = Math.min(U(sd.heel, i).y, U(sd.toe, i).y);
      // Histéresis (respecto al pie más bajo): se apoya a menos de 1,5 cm y se levanta a más de 4 cm.
      c.push(jump[i]! < 0.02 && low < (c[i - 1] ? 0.04 : 0.015));
    }
    // Fuera los apoyos de menos de 3 fotogramas (ruido).
    for (let i = 0; i < N; ) {
      let e = i;
      while (e < N && c[e] === c[i]) e++;
      if (c[i] && e - i < 3) for (let k = i; k < e; k++) c[k] = false;
      i = e;
    }
    return feetLock ? c : c.map(() => false);
  });
  // Raíz: mientras un pie está apoyado, el cuerpo se mueve lo contrario de lo que ese pie se movería
  // respecto a la cadera. En el aire se mantiene la última velocidad (vuelo balístico).
  const rootX = [0];
  const rootZ = [0];
  let vx = 0;
  let vz = 0;
  for (let i = 1; i < N; i++) {
    let dx = 0;
    let dz = 0;
    let n = 0;
    for (let s = 0; s < 2; s++) {
      if (!contactRaw[s]![i] || !contactRaw[s]![i - 1]) continue;
      const a = sole(s, i - 1);
      const b = sole(s, i);
      dx += a.x - b.x;
      dz += a.z - b.z;
      n++;
    }
    if (n) {
      vx += (dx / n - vx) * 0.35;
      vz += (dz / n - vz) * 0.35;
    }
    rootX.push(rootX[i - 1]! + (n ? dx / n : vx));
    rootZ.push(rootZ[i - 1]! + (n ? dz / n : vz));
  }
  const rx = feetLock ? gauss(rootX, 1.5) : rootX.map(() => 0);
  const rz = feetLock ? gauss(rootZ, 1.5) : rootZ.map(() => 0);
  const contactW = contactRaw.map((c) => gauss(c.map((x) => (x ? 1 : 0)), 1.2));
  // Dónde queda clavado cada pie: la media de su posición durante el apoyo.
  const targets = contactRaw.map((c, s) => {
    const t: (THREE.Vector2 | null)[] = new Array(N).fill(null);
    for (let i = 0; i < N; ) {
      let e = i;
      while (e < N && c[e] === c[i]) e++;
      if (c[i]) {
        const m = new THREE.Vector2();
        for (let k = i; k < e; k++) {
          const p = sole(s, k);
          m.x += p.x + rx[k]!;
          m.y += p.z + rz[k]!;
        }
        m.multiplyScalar(1 / (e - i));
        // También unos fotogramas antes y después (para la transición suave del peso).
        for (let k = Math.max(0, i - 4); k < Math.min(N, e + 4); k++) if (c[k] || !t[k]) t[k] = m;
      }
      i = e;
    }
    return t;
  });

  // Puntos finales en el mundo: raíz + pies clavados.
  const world: THREE.Vector3[][] = Array.from({ length: N }, (_, i) => {
    const pts = Array.from({ length: 33 }, (_, j) => U(j, i).add(new THREE.Vector3(rx[i], 0, rz[i])));
    for (let s = 0; s < 2; s++) {
      const w = contactW[s]![i]!;
      const tg = targets[s]![i];
      if (w < 0.01 || !tg) continue;
      const sd = sides[s]!;
      const so = mid(pts[sd.heel]!, pts[sd.toe]!);
      const dx = (tg.x - so.x) * w;
      const dz = (tg.y - so.z) * w;
      const dy = -Math.min(pts[sd.heel]!.y, pts[sd.toe]!.y) * w;
      for (const j of [sd.heel, sd.toe, sd.ankle]) pts[j]!.add(new THREE.Vector3(dx, dy, dz));
    }
    return pts;
  });

  // --- 5. Balón (en 3D "local": x/z respecto a la cadera, y = altura sobre el suelo) ---
  const hipPx = (i: number) => {
    const hl = px(i, MP.hipL);
    const hr = px(i, MP.hipR);
    return hl && hr ? hl.add(hr).multiplyScalar(0.5) : null;
  };
  const wrists = (i: number) => [U(MP.wrL, i), U(MP.wrR, i)] as const;
  /** Profundidad automática: la de la muñeca más cercana en el plano de la imagen. */
  const autoDepth = (i: number, x: number, y: number) => {
    const [wl, wr] = wrists(i);
    return Math.hypot(wl.x - x, wl.y - y) < Math.hypot(wr.x - x, wr.y - y) ? wl.z : wr.z;
  };
  const imageToLocal = (i: number, u: number, v: number, depth?: number): [number, number, number] | null => {
    const hp = hipPx(i);
    if (!hp || !Number.isFinite(mpp[i]!)) return null;
    const x = (u * W - hp.x) * mpp[i]!;
    const y = -(v * H - hp.y) * mpp[i]! - floor[i]! + jump[i]!;
    return [x, y, depth ?? autoDepth(i, x, y)];
  };
  const localToImage = (i: number, p: readonly number[]) => {
    const hp = hipPx(i);
    if (!hp || !Number.isFinite(mpp[i]!)) return null;
    return { x: (p[0]! / mpp[i]! + hp.x) / W, y: (hp.y - (p[1]! + floor[i]! - jump[i]!) / mpp[i]!) / H };
  };
  const det: Track = cap.frames.map((f, i) => {
    const p = f.ball ? imageToLocal(i, f.ball[0], f.ball[1]) : null;
    return p ? new THREE.Vector3(...p) : null;
  });
  const ballSeen = det.filter(Boolean).length;
  const detFilled = fillGaps(det, Math.round(cap.fps * 0.2));
  // Mediana de 3 para quitar detecciones sueltas sin redondear los botes.
  const detM = detFilled.map((b, i) => {
    if (!b) return null;
    const near = [detFilled[i - 1], b, detFilled[i + 1]].filter(Boolean) as THREE.Vector3[];
    return near.length === 3 ? median(near, 1)[1]! : b;
  });
  // Keyframes en 3D: entre dos a menos de 0,75 s se interpola (sustituye a la detección); uno suelto
  // corrige la detección de alrededor y la corrección se desvanece en 0,15 s.
  const keys = [...(cap.ballKeys ?? [])]
    .sort((a, b) => a.f - b.f)
    .map((k) => ({ ...k, v: new THREE.Vector3(...(k.p ?? imageToLocal(k.f, k.x, k.y) ?? [0, 1, 0])) }));
  const span = Math.round(cap.fps * 0.75);
  const fade = Math.max(2, Math.round(cap.fps * 0.15));
  const ball2d: (Ball2D | null)[] = [];
  const handO: { l: number; r: number; w: number }[] = [];
  const ballM: (THREE.Vector3 | null)[] = detM.map((d, i) => {
    const inf = keyInfluence(keys, i, span, fade);
    let p: THREE.Vector3 | null = d ? d.clone() : null;
    let source: Ball2D['source'] = 'det';
    if (inf.mode === 'replace') {
      p = new THREE.Vector3();
      for (const { k, w } of inf.ks) p.addScaledVector(k.v, w);
      source = inf.ks.length === 1 ? 'key' : 'interp';
    } else if (inf.mode === 'fade') {
      source = 'fix';
      if (p) for (const { k, w } of inf.ks) p.addScaledVector(k.v.clone().sub(detM[k.f] ?? k.v), w);
      else {
        const best = inf.ks.reduce((a, b) => (b.w > a.w ? b : a));
        if (best.w > 0.3) p = best.k.v.clone();
      }
    }
    const im = p ? localToImage(i, [p.x, p.y, p.z]) : null;
    ball2d.push(p && im ? { ...im, source } : null);
    // Mano forzada: media de los keyframes con mano elegida, con su peso.
    let l = 0;
    let r = 0;
    let w = 0;
    for (const { k, w: kw } of inf.ks) {
      if (k.hand === 'auto') continue;
      l += (k.hand === 'L' ? 1 : 0) * kw;
      r += (k.hand === 'R' ? 1 : 0) * kw;
      w += kw;
    }
    handO.push(w > 0 ? { l: l / w, r: r / w, w: Math.min(1, w) } : { l: 0, r: 0, w: 0 });
    return p;
  });
  // Peso "en la mano": 1 a < 18 cm de la muñeca, 0 desde 32 cm. Si no se ve, la última mano que lo tuvo.
  let lastSide: 0 | 1 = 1;
  const holdL: number[] = [];
  const holdR: number[] = [];
  ballM.forEach((b, i) => {
    if (!b) {
      holdL.push(lastSide === 0 ? 1 : 0);
      holdR.push(lastSide === 1 ? 1 : 0);
      return;
    }
    const [wl, wr] = wrists(i);
    const dl = b.distanceTo(wl);
    const dr = b.distanceTo(wr);
    const hold = (d: number) => 1 - THREE.MathUtils.smoothstep(d, 0.18, 0.32);
    holdL.push(hold(dl));
    holdR.push(hold(dr));
    if (Math.min(dl, dr) < 0.32) lastSide = dl < dr ? 0 : 1;
  });
  // Mano forzada por los keyframes, encima.
  const wL = gauss(holdL, 1.5).map((v, i) => v + (handO[i]!.l - v) * handO[i]!.w);
  const wR = gauss(holdR, 1.5).map((v, i) => v + (handO[i]!.r - v) * handO[i]!.w);
  const localToWorld = (i: number, p: readonly number[]): [number, number, number] => [p[0]! + rx[i]!, p[1]!, p[2]! + rz[i]!];
  const worldToLocal = (i: number, w: readonly number[]): [number, number, number] => [w[0]! - rx[i]!, w[1]!, w[2]! - rz[i]!];
  const ballWorld = ballM.map((b, i) => {
    const q = b ?? (wL[i]! > wR[i]! ? wrists(i)[0] : wrists(i)[1]);
    const w = localToWorld(i, [q.x, q.y, q.z]);
    w[1] = Math.max(BALL_R, w[1]);
    return w;
  });

  // --- 6. Retargeting ---
  const poses: Pose[] = Array.from({ length: N }, (_, i) => {
    const g = (j: number) => U(j, i);
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
  const armHints = clean ? smoothArmHints(body, cap.fps) : [];
  // Con el tronco recto la base del tronco ya coincide con la del rig: sin corrección.
  const frames = body.map((p, i) => retarget(p, standHipY, new THREE.Quaternion(), armHints[i]));
  const k = RIG_HIP_Y / standHipY;

  const r = (x: number) => Math.round(x * 1000) / 1000;
  const clip: MocapClipJson = {
    source: `Vídeo → MediaPipe Pose (estudio de mocap): ${cap.name}`,
    fps: cap.fps,
    loop: false,
    duration: +(N / cap.fps).toFixed(3),
    frames: frames.map((f) => [r(f.rootY), ...f.q.flatMap((q) => [r(q.x), r(q.y), r(q.z), r(q.w)]), -1]),
    yaw: yaw.map(r),
    lift: jump.map((j) => r(j * k)),
    root: rx.map((x, i) => [r(x * k), r(rz[i]! * k)]),
    feet: Array.from({ length: N }, (_, i) =>
      [0, 1].flatMap((s) => {
        const w = contactW[s]![i]!;
        const tg = targets[s]![i];
        return w > 0.01 && tg ? [r(w), r(tg.x * k), r(tg.y * k)] : [0, 0, 0];
      }),
    ),
    ball: ballWorld.map((b, i) => [r(b[0]! * k), r(b[1]! * k), r(b[2]! * k), r(wL[i]!), r(wR[i]!)]),
    exaggerate: { ...cap.exaggerate },
  };
  const skeleton = world.map((pts) => SKELETON_POINTS.flatMap((j) => [r(pts[j]!.x), r(pts[j]!.y), r(pts[j]!.z)]));
  return {
    clip,
    world,
    visibility,
    skeleton,
    ballMeters: ballM.map((b, i) => (b ? ballWorld[i]! : null)),
    ball2d,
    ballLocal: ballM.map((b) => (b ? [b.x, b.y, b.z] : null)),
    f0,
    range: cap.range,
    scale: k,
    imageToLocal,
    localToImage,
    localToWorld,
    worldToLocal,
    contact: { l: contactW[0]!, r: contactW[1]! },
    stats: {
      legLen,
      maxJump: Math.max(0, ...jump),
      ballSeen,
      travel: Math.hypot(rx[N - 1]! - rx[0]!, rz[N - 1]! - rz[0]!),
    },
  };
}

/**
 * Longitud constante de brazo y antebrazo. Cuando el brazo queda tapado por el cuerpo, MediaPipe lo
 * "aplasta" (huesos de la mitad de largo) y su dirección se vuelve ruido: el codo da tirones.
 * La longitud real se mide donde el brazo se ve bien; en cada fotograma se conserva lo que se ve en la
 * imagen (x, y) y se recupera la profundidad (z) que falta, sin cambiar de golpe si va por delante o por
 * detrás. La mano (dedos) acompaña a la muñeca.
 */
function keepArmLengths(tracks: THREE.Vector3[][], vis: number[][]): void {
  const N = tracks[0]!.length;
  const chains = [
    { sh: MP.shL, el: MP.elL, wr: MP.wrL, hand: [17, 19, 21] },
    { sh: MP.shR, el: MP.elR, wr: MP.wrR, hand: [18, 20, 22] },
  ];
  const refLength = (a: number, b: number) => {
    const sure: number[] = [];
    const all: number[] = [];
    for (let i = 0; i < N; i++) {
      const d = tracks[a]![i]!.distanceTo(tracks[b]![i]!);
      all.push(d);
      if (vis[i]![a]! > 0.7 && vis[i]![b]! > 0.7) sure.push(d);
    }
    // La mediana de los fotogramas seguros (o de todos, si hay pocos); nunca la parte "aplastada".
    return sortedMedian(sure.length >= 10 ? sure : all);
  };
  /**
   * Acerca child a distancia L de parent; devuelve cuánto se ha movido. Gradual: nada si el hueso ya mide
   * lo que debe, del todo si está aplastado por debajo del 80 % (así no hay saltos al cruzar un umbral).
   * Delante/detrás: el de la captura si es claro (|z| > 5 cm); si no, el del fotograma anterior corregido.
   */
  const fit = (parent: THREE.Vector3, child: THREE.Vector3, L: number, sign: { z: number }) => {
    const d = child.clone().sub(parent);
    const len = d.length();
    if (Math.abs(d.z) > 0.05) sign.z = Math.sign(d.z);
    const w = 1 - THREE.MathUtils.smoothstep(len / L, 0.8, 1);
    if (w > 0) {
      const xy2 = d.x * d.x + d.y * d.y;
      const full = xy2 >= L * L ? d.clone().setLength(L) : new THREE.Vector3(d.x, d.y, sign.z * Math.sqrt(L * L - xy2));
      d.lerp(full, w);
    }
    if (Math.abs(d.z) > 0.01) sign.z = Math.sign(d.z);
    const moved = parent.clone().add(d).sub(child);
    child.add(moved);
    return moved;
  };
  for (const c of chains) {
    const L1 = refLength(c.sh, c.el);
    const L2 = refLength(c.el, c.wr);
    if (!Number.isFinite(L1) || !Number.isFinite(L2)) continue;
    const s1 = { z: -1 };
    const s2 = { z: -1 };
    for (let i = 0; i < N; i++) {
      const el = tracks[c.el]![i]!;
      const wr = tracks[c.wr]![i]!;
      const m1 = fit(tracks[c.sh]![i]!, el, L1, s1);
      wr.add(m1);
      for (const h of c.hand) tracks[h]![i]!.add(m1);
      const m2 = fit(el, wr, L2, s2);
      for (const h of c.hand) tracks[h]![i]!.add(m2);
    }
  }
}

/**
 * Hacia dónde se dobla cada antebrazo, suavizado en el tiempo y medido respecto al tronco.
 * Cada fotograma vota con un peso proporcional a lo doblado que está el codo: con el brazo casi recto
 * (dirección indefinida) mandan los fotogramas vecinos y el codo no salta de lado.
 */
function smoothArmHints(body: Pose[], fps: number): ArmHints[] {
  const sigma = Math.max(1, fps * 0.08);
  const sides = [
    ['LeftArm', 'LeftForeArm', 'LeftHand'],
    ['RightArm', 'RightForeArm', 'RightHand'],
  ] as const;
  const torso = body.map((p) => torsoBasis(p));
  const local = sides.map(([sh, el, wr]) =>
    body.map((p, i) => {
      const up = p[el].clone().sub(p[sh]).normalize();
      const fore = p[wr].clone().sub(p[el]).normalize();
      // Perpendicular al brazo, de longitud = seno del ángulo del codo (0 con el brazo recto).
      const bend = fore.addScaledVector(up, -fore.dot(up));
      return bend.multiplyScalar(bend.length()).applyQuaternion(torso[i]!.clone().invert());
    }),
  );
  const smooth = local.map((vs) => {
    const x = gauss(vs.map((q) => q.x), sigma);
    const y = gauss(vs.map((q) => q.y), sigma);
    const z = gauss(vs.map((q) => q.z), sigma);
    return vs.map((_, i) => new THREE.Vector3(x[i], y[i], z[i]));
  });
  // Continuidad: con poca confianza (codo casi recto o doblado del todo, que es error de profundidad)
  // se mantiene la dirección del fotograma anterior y solo se corrige en la medida de la confianza.
  // Confianza plena a partir de sen²(25°) ≈ 0,18.
  // Además, el codo no puede girar más rápido que ~540°/s (un tirón de la captura se reparte en varios fotogramas).
  const maxStep = THREE.MathUtils.degToRad(540) / fps;
  const rot = new THREE.Quaternion();
  const steady = smooth.map((vs) => {
    const firstSure = vs.find((q) => q.length() > 0.18);
    let prev = firstSure ? firstSure.clone().normalize() : new THREE.Vector3(0, 0, 1);
    return vs.map((q) => {
      const len = q.length();
      if (len > 1e-6) {
        const target = prev.clone().lerp(q.clone().normalize(), Math.min(1, len / 0.18)).normalize();
        const angle = prev.angleTo(target);
        if (angle > maxStep) {
          rot.setFromUnitVectors(prev, target);
          target.copy(prev).applyQuaternion(new THREE.Quaternion().slerp(rot, maxStep / angle));
        }
        prev = target;
      }
      return prev.clone();
    });
  });
  return body.map((_, i) => ({ L: steady[0]![i]!.clone().applyQuaternion(torso[i]!), R: steady[1]![i]!.clone().applyQuaternion(torso[i]!) }));
}

/** JSON de landmarks limpios (antes del retargeting), uno por clip. */
export function landmarksJson(cap: Capture, baked: Baked) {
  const r = (x: number) => Math.round(x * 10000) / 10000;
  return {
    format: 'pixel-hoops/mediapipe-landmarks',
    version: 1,
    name: cap.name,
    fps: cap.fps,
    frameCount: baked.world.length,
    duration: +(baked.world.length / cap.fps).toFixed(4),
    videoRange: baked.range,
    units: 'm',
    axes: 'y hacia arriba, x hacia la derecha de la cámara, z hacia la cámara (giro de 180° sobre X de los ejes de MediaPipe); suelo en y = 0 (lo toca el punto más bajo del pie apoyado); x/z = 0 en la cadera del primer fotograma',
    cleaning: {
      ...CLEANING,
      note: 'Puntos con visibilidad < minVisibility interpolados desde sus vecinos; luego mediana y suavizado gaussiano sin desfase. La visibilidad es la original de MediaPipe.',
      feetLocked: cap.feetLock ?? true,
    },
    points: MP_NAMES,
    // Por fotograma: un [x, y, z, visibility] por cada punto, en el orden de `points`.
    frames: baked.world.map((pts, i) => ({
      t: +(i / cap.fps).toFixed(4),
      p: pts.map((q, j) => [r(q.x), r(q.y), r(q.z), r(baked.visibility[i]![j]!)]),
    })),
    // Extra: centro del balón [x, y, z] en los mismos ejes (null si no se vio ni se corrigió a mano).
    ball: baked.ballMeters.map((b) => (b ? b.map(r) : null)),
  };
}

