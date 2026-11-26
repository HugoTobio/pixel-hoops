/**
 * Hornea la pose sacada de vídeo con MediaPipe (pose.py → pose.json) al rig del juego.
 *
 *   npx tsx tools/video-mocap/bake-pose.ts [pose.json] [salida.json]
 *   (por defecto: tools/video-mocap/data/pivot-pose.json → apps/client/src/content/anims/pivot.json)
 *
 * Pasos:
 *  1. Ejes de MediaPipe (x derecha, y abajo, z alejándose de la cámara) → los del juego (y arriba, z hacia
 *     la cámara). Es un giro de 180° sobre X, así que no espeja: la izquierda sigue siendo la izquierda.
 *  2. Limpieza: fuera los puntos con visibilidad < 0,5 y los saltos sueltos (mediana de 7 fotogramas);
 *     los huecos se rellenan interpolando.
 *  3. Suavizado gaussiano sin desfase (el vídeo está grabado, así que se puede mirar hacia delante).
 *  4. Altura: la de la cadera sobre el pie más bajo (agacharse). El salto no sale en las coordenadas de
 *     MediaPipe (van centradas en la cadera), así que se mide en la imagen: cuánto suben los tobillos
 *     respecto a lo normal, en proporción a la altura del cuerpo en pantalla.
 *  5. Retargeting con el mismo código que los BVH de CMU (tools/mocap/retarget.ts) + rumbo (yaw) aparte,
 *     porque en el pivote el giro ES el movimiento.
 *
 * Se guardan dos versiones, `pivot` (limpia) y `pivotRaw` (sin limpiar), para poder compararlas.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { retarget, RIG_HIP_Y, SLOTS, toBodySpace } from '../mocap/retarget';
import type { Pose } from '../mocap/sample';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const SRC = process.argv[2] ?? here('./data/pivot-pose.json');
const OUT = process.argv[3] ?? here('../../apps/client/src/content/anims/pivot.json');

interface MpFrame {
  i: number;
  w: number[][] | null;
  n?: number[][];
}
const src = JSON.parse(readFileSync(SRC, 'utf8')) as { fps: number; frames: MpFrame[] };
const FPS = src.fps;
const N = src.frames.length;

// Puntos de MediaPipe que usamos (impares = izquierda).
const MP = {
  nose: 0, shL: 11, shR: 12, elL: 13, elR: 14, wrL: 15, wrR: 16,
  hipL: 23, hipR: 24, knL: 25, knR: 26, anL: 27, anR: 28, heelL: 29, heelR: 30, toeL: 31, toeR: 32,
} as const;
const USED = Object.values(MP);
/** Huesos para el esqueleto de comprobación (índices en USED). */
const BONES: [keyof typeof MP, keyof typeof MP][] = [
  ['shL', 'shR'], ['hipL', 'hipR'], ['shL', 'hipL'], ['shR', 'hipR'],
  ['shL', 'elL'], ['elL', 'wrL'], ['shR', 'elR'], ['elR', 'wrR'],
  ['hipL', 'knL'], ['knL', 'anL'], ['anL', 'heelL'], ['heelL', 'toeL'], ['anL', 'toeL'],
  ['hipR', 'knR'], ['knR', 'anR'], ['anR', 'heelR'], ['heelR', 'toeR'], ['anR', 'toeR'],
];

type Track = (THREE.Vector3 | null)[]; // por fotograma
type Tracks = Track[]; // por punto (33)

function readTracks(minVis: number): Tracks {
  return Array.from({ length: 33 }, (_, j) =>
    src.frames.map((f) => {
      const p = f.w?.[j];
      if (!p || p[3]! < minVis) return null;
      return new THREE.Vector3(p[0]!, -p[1]!, -p[2]!);
    }),
  );
}

/** Rellena huecos interpolando entre los vecinos válidos (o copiando el más cercano en los bordes). */
function fillGaps(t: Track): THREE.Vector3[] {
  const out: THREE.Vector3[] = new Array(t.length);
  const valid = t.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
  if (valid.length === 0) return t.map(() => new THREE.Vector3());
  for (let i = 0; i < t.length; i++) {
    if (t[i]) {
      out[i] = t[i]!.clone();
      continue;
    }
    let a = -1;
    let b = -1;
    for (const k of valid) {
      if (k < i) a = k;
      else if (k > i) {
        b = k;
        break;
      }
    }
    if (a < 0) out[i] = t[b]!.clone();
    else if (b < 0) out[i] = t[a]!.clone();
    else out[i] = t[a]!.clone().lerp(t[b]!, (i - a) / (b - a));
  }
  return out;
}

/** Mediana por eje: quita picos de 1–3 fotogramas sin redondear los movimientos reales. */
function median(t: THREE.Vector3[], half: number): THREE.Vector3[] {
  const med = (xs: number[]) => xs.sort((x, y) => x - y)[xs.length >> 1]!;
  return t.map((_, i) => {
    const w = t.slice(Math.max(0, i - half), Math.min(t.length, i + half + 1));
    return new THREE.Vector3(med(w.map((p) => p.x)), med(w.map((p) => p.y)), med(w.map((p) => p.z)));
  });
}

/** Gaussiano sin desfase, sigma en fotogramas. */
function gauss(xs: number[], sigma: number): number[] {
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

/** Salto (metros) medido en la imagen: subida de los tobillos respecto a su altura habitual en pantalla. */
function jumpFromImage(legLen: number): number[] {
  const ank: number[] = [];
  const bodyH: number[] = [];
  for (const f of src.frames) {
    if (!f.n) {
      ank.push(NaN);
      bodyH.push(NaN);
      continue;
    }
    const low = Math.max(f.n[MP.anL]![1]!, f.n[MP.anR]![1]!); // y de imagen hacia abajo: el tobillo más bajo
    const hip = (f.n[MP.hipL]![1]! + f.n[MP.hipR]![1]!) / 2;
    ank.push(low);
    bodyH.push(low - hip);
  }
  const ok = ank.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  const base = ok[Math.floor(ok.length * 0.6)]!; // altura habitual de los tobillos en pantalla
  const hs = bodyH.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  const h = hs[hs.length >> 1]!; // cadera→tobillo en pantalla
  const raw = ank.map((a) => (Number.isNaN(a) ? 0 : Math.max(0, ((base - a) / h) * legLen)));
  // Solo cuenta como salto si supera 6 cm (el resto es ruido o la cámara moviéndose).
  return gauss(raw, 2).map((j) => (j > 0.06 ? j - 0.06 : 0));
}

function bake(clean: boolean) {
  const tracks = readTracks(clean ? 0.5 : 0).map((t) => {
    const filled = fillGaps(t);
    return clean ? gaussV(median(filled, 3), 2.2) : filled;
  });
  const P = (j: number, i: number) => tracks[j]![i]!;

  // Longitud de pierna (cadera→tobillo, mediana) para escalar al rig.
  const legs = Array.from({ length: N }, (_, i) =>
    P(MP.hipL, i).distanceTo(P(MP.knL, i)) + P(MP.knL, i).distanceTo(P(MP.anL, i)),
  ).sort((a, b) => a - b);
  const legLen = legs[legs.length >> 1]!;
  const standHipY = legLen + 0.08;

  // Suelo bajo el pie más bajo de cada fotograma (talones y punteras), suavizado.
  const floor = gauss(
    Array.from({ length: N }, (_, i) => Math.min(...[MP.heelL, MP.heelR, MP.toeL, MP.toeR, MP.anL, MP.anR].map((j) => P(j, i).y))),
    clean ? 3 : 0.5,
  );

  const poses: Pose[] = Array.from({ length: N }, (_, i) => {
    const lift = new THREE.Vector3(0, -floor[i]! + 0.03, 0); // 3 cm: del talón a la suela
    const g = (j: number) => P(j, i).clone().add(lift);
    const p = {
      Hips: mid(g(MP.hipL), g(MP.hipR)),
      Neck: mid(g(MP.shL), g(MP.shR)),
      LeftUpLeg: g(MP.hipL), LeftLeg: g(MP.knL), LeftFoot: g(MP.anL), LeftToeBase: g(MP.toeL),
      RightUpLeg: g(MP.hipR), RightLeg: g(MP.knR), RightFoot: g(MP.anR), RightToeBase: g(MP.toeR),
      LeftArm: g(MP.shL), LeftForeArm: g(MP.elL), LeftHand: g(MP.wrL),
      RightArm: g(MP.shR), RightForeArm: g(MP.elR), RightHand: g(MP.wrR),
    };
    return p as unknown as Pose;
  });

  const { body, yaw } = toBodySpace(poses, clean ? 3 : 0);
  // Con el tronco recto la base del tronco ya coincide con la del rig: sin corrección.
  const frames = body.map((p) => retarget(p, standHipY, new THREE.Quaternion()));
  const k = RIG_HIP_Y / standHipY;
  const jump = jumpFromImage(legLen).map((j) => j * k);

  const r = (x: number) => Math.round(x * 1000) / 1000;
  const clip = {
    fps: FPS,
    loop: false,
    duration: +(N / FPS).toFixed(3),
    // Por frame: rootY, 9 cuaterniones (x,y,z,w) en el orden de SLOTS, ballY (−1: el balón no se capta).
    frames: frames.map((f) => [r(f.rootY), ...f.q.flatMap((q) => [r(q.x), r(q.y), r(q.z), r(q.w)]), -1]),
    /** Rumbo del cuerpo (rad) respecto a la cámara del vídeo: 0 = de frente a la cámara. */
    yaw: yaw.map(r),
    /** Altura del salto en unidades del rig. */
    lift: jump.map(r),
  };
  // Esqueleto de MediaPipe tal cual (ya en ejes del juego y con el suelo en y = 0) para comparar.
  const skeleton = Array.from({ length: N }, (_, i) =>
    USED.flatMap((j) => {
      const q = P(j, i);
      return [r(q.x), r(q.y - floor[i]! + 0.03 + (jump[i]! / k)), r(q.z)];
    }),
  );
  const maxJump = Math.max(...jump) / k;
  console.log(`· ${clean ? 'pivot' : 'pivotRaw'}: ${N} frames a ${FPS.toFixed(1)} fps · pierna ${legLen.toFixed(2)} m · salto máx ${(maxJump * 100).toFixed(0)} cm`);
  return { clip, skeleton };
}

const clean = bake(true);
const raw = bake(false);
writeFileSync(
  OUT,
  JSON.stringify({
    source: 'Vídeo → MediaPipe Pose (tools/video-mocap). Solo para pruebas: grabar el gesto propio antes de publicar.',
    slots: SLOTS,
    clips: { pivot: clean.clip, pivotRaw: raw.clip },
    skeleton: {
      points: Object.keys(MP),
      bones: BONES.map(([a, b]) => [Object.keys(MP).indexOf(a), Object.keys(MP).indexOf(b)]),
      pivot: clean.skeleton,
      pivotRaw: raw.skeleton,
    },
  }),
);
console.log(`→ ${OUT}`);
