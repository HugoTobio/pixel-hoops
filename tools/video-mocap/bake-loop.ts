/**
 * Convierte una captura del estudio en un BUCLE para el juego (como `run`, pero con lo que traiga la
 * captura: p. ej. bote en carrera, con la trayectoria del balón).
 *
 *   npx tsx tools/video-mocap/bake-loop.ts <captura> <clip> [--speed m/s]
 *   p. ej.: npx tsx tools/video-mocap/bake-loop.ts bote-en-carrera dribble-run
 *   → apps/client/src/content/anims/<clip>.json
 *
 * Usa el recorte, los keyframes del balón y los pies fijos de la captura (lo que se ve en el estudio).
 *  1. Sin desplazamiento ni giro: el juego mueve y orienta al jugador. Las poses ya van en el espacio del
 *     cuerpo (mirando a +Z) y el balón se pasa a ese mismo espacio.
 *  2. Cierre del bucle: el par inicio/fin con la postura y el balón más parecidos (mínimo 0,45 s), y la
 *     diferencia que queda se reparte a lo largo del bucle para que no "salte".
 *  3. Velocidad: la del cuerpo mientras hay un pie apoyado (para reproducirlo al ritmo del jugador).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { bakeCapture, type Capture } from '../../packages/mocap/src/index';

const [name, out, ...rest] = process.argv.slice(2);
if (!name || !out) {
  console.error('Uso: npx tsx tools/video-mocap/bake-loop.ts <captura> <clip> [--speed m/s]');
  process.exit(1);
}
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const cap = JSON.parse(readFileSync(here(`./data/${name}/capture.json`), 'utf8')) as Capture;
const b = bakeCapture(cap, true);
const fps = cap.fps;
const n = b.clip.frames.length;
const k = b.scale; // metros → unidades del rig
const r3 = (x: number) => Math.round(x * 1000) / 1000;

// --- 1. Balón en el espacio del cuerpo (x/z respecto a la cadera, girado con el jugador; y = altura) ---
const ball = b.clip.ball.map((bb, i) => {
  const local = new THREE.Vector3(bb[0]! - b.clip.root[i]![0]!, bb[1]!, bb[2]! - b.clip.root[i]![1]!);
  local.applyAxisAngle(new THREE.Vector3(0, 1, 0), -b.clip.yaw[i]!);
  return [local.x, local.y, local.z, bb[3]!, bb[4]!];
});
const quat = (f: number[], s: number) => new THREE.Quaternion(f[1 + s * 4], f[2 + s * 4], f[3 + s * 4], f[4 + s * 4]);

// --- 2. Mejor cierre ---
const poseDist = (a: number, c: number) => {
  const A = b.clip.frames[a]!;
  const C = b.clip.frames[c]!;
  let d = (A[0]! - C[0]!) ** 2 * 4;
  for (let s = 0; s < 9; s++) d += 1 - Math.abs(quat(A, s).dot(quat(C, s)));
  const ba = ball[a]!;
  const bc = ball[c]!;
  d += Math.hypot(ba[0]! - bc[0]!, ba[1]! - bc[1]!, ba[2]! - bc[2]!) * 0.5 + (Math.abs(ba[3]! - bc[3]!) + Math.abs(ba[4]! - bc[4]!)) * 0.2;
  return d;
};
const minLen = Math.round(fps * 0.45);
if (n < minLen + 2) {
  console.error(`La captura es demasiado corta para un bucle (${n} fotogramas; hacen falta ${minLen + 2}).`);
  process.exit(1);
}
let best = { s: 0, e: n - 1, cost: Infinity };
for (let s = 0; s + minLen < n; s++) {
  for (let e = s + minLen; e < n; e++) {
    // Se prefieren bucles largos: a igual parecido, el que cubre más de la captura.
    const cost = poseDist(s, e) + 0.02 * (1 - (e - s) / n);
    if (cost < best.cost) best = { s, e, cost };
  }
}
const { s, e } = best;
console.log(`· bucle: fotogramas ${b.f0 + s + 1}→${b.f0 + e + 1} de la captura (${((e - s) / fps).toFixed(2)} s, diferencia ${best.cost.toFixed(4)})`);

// Se reparte la diferencia entre el último fotograma y el primero (igual que en los clips CMU).
const frames = b.clip.frames.slice(s, e).map((f) => f.slice());
const balls = ball.slice(s, e).map((x) => x.slice());
const first = b.clip.frames[s]!;
const end = b.clip.frames[e]!;
const L = frames.length;
frames.forEach((f, i) => {
  const t = i / L;
  f[0] = f[0]! + (first[0]! - end[0]!) * t;
  for (let sl = 0; sl < 9; sl++) {
    const dq = quat(first, sl).multiply(quat(end, sl).invert());
    const q = quat(f, sl).premultiply(new THREE.Quaternion().slerp(dq, t));
    f.splice(1 + sl * 4, 4, q.x, q.y, q.z, q.w);
  }
  for (let c = 0; c < 5; c++) balls[i]![c] = balls[i]![c]! + (ball[s]![c]! - ball[e]![c]!) * t;
});

// --- 3. Velocidad (unidades del rig por segundo) ---
let speed = NaN;
const flag = rest.indexOf('--speed');
if (flag >= 0) speed = Number(rest[flag + 1]) * k;
else {
  const v: number[] = [];
  for (let i = 1; i < n; i++) {
    const on = (j: number) => b.contact.l[j]! > 0.5 || b.contact.r[j]! > 0.5;
    if (!on(i) || !on(i - 1)) continue;
    v.push(Math.hypot(b.clip.root[i]![0]! - b.clip.root[i - 1]![0]!, b.clip.root[i]![1]! - b.clip.root[i - 1]![1]!) * fps);
  }
  v.sort((x, y) => x - y);
  speed = v.length >= 4 ? v[v.length >> 1]! : NaN;
}
if (!Number.isFinite(speed)) {
  speed = 3.9; // la de `run` (CMU) si no se puede medir
  console.log('  (sin apoyos suficientes para medir la velocidad: se usa la de run; ajústala con --speed)');
}
console.log(`  velocidad: ${(speed / k).toFixed(2)} m/s de la captura → ${speed.toFixed(2)} unidades del rig/s`);
const held = balls.filter((x) => x[3]! + x[4]! > 0.5).length;
const low = Math.min(...balls.map((x) => x[1]!));
console.log(`  balón: en la mano ${Math.round((held / L) * 100)} % del bucle · altura mínima ${low.toFixed(2)} (rig)`);

const target = here(`../../apps/client/src/content/anims/${out}.json`);
writeFileSync(
  target,
  JSON.stringify({
    source: `Bucle de la captura "${name}" (estudio de mocap, MediaPipe Pose) · tools/video-mocap/bake-loop.ts`,
    fps: r3(fps),
    loop: true,
    duration: r3(L / fps),
    speed: r3(speed),
    // Por frame: rootY, 9 cuaterniones (x,y,z,w) en el orden de SLOTS, −1 (sin balón de los clips CMU).
    frames: frames.map((f) => [...f.slice(0, 37).map(r3), -1]),
    // Balón por frame en el espacio del cuerpo (rig): [x, y, z, peso mano izq., peso mano der.].
    ball: balls.map((x) => x.map(r3)),
  }),
);
console.log(`→ ${target}`);
