/**
 * Hornea clips de mocap (BVH de CMU) al esqueleto low poly del juego.
 *
 * El retargeting (direcciones de hueso → rotaciones del rig) está en retarget.ts.
 *
 * Uso: npm run bake:mocap   (lee tools/mocap/bvh/*.bvh, escribe apps/client/src/content/anims/clips.json)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { retarget as retargetPose, RIG_HIP_Y, SLOTS, toBodySpace, torsoBasis, type Frame } from './retarget';
import { sampleBvh, type Sampled } from './sample';

const FPS = 30;
const BVH = (n: string) => fileURLToPath(new URL(`./bvh/${n}.bvh`, import.meta.url));
const OUT = fileURLToPath(new URL('../../apps/client/src/content/anims/clips.json', import.meta.url));

/** Radio del balón visual en unidades del rig de referencia. */
const BALL_R = 0.2;

interface ClipSpec {
  name: string;
  file: string;
  from: number;
  to: number;
  loop: 'dribble' | 'stride' | false;
  shoot?: boolean;
}

const SPECS: ClipSpec[] = [
  // En CMU 06 el bote "de verdad" está en los tramos en movimiento; se usa solo para tronco y brazos.
  { name: 'dribble', file: '06_02', from: 2.5, to: 5.25, loop: 'dribble' },
  { name: 'run', file: '09_01', from: 0.0, to: 1.2, loop: 'stride' },
  { name: 'shoot', file: '06_15', from: 2.15, to: 3.6, loop: false, shoot: true },
];

/** Corrección del tronco: en la pose de calibración (T-pose del 06_15) el tronco debe quedar recto. */
let torsoRestInv: THREE.Quaternion;

/** Altura de cadera de pie ≈ muslo + espinilla + tobillo. */
function standingHipY(s: Sampled): number {
  const p = s.frames[0]!;
  return p.LeftUpLeg.distanceTo(p.LeftLeg) + p.LeftLeg.distanceTo(p.LeftFoot) + 0.08;
}

function poseDistance(a: Frame, b: Frame): number {
  let d = (a.rootY - b.rootY) ** 2 * 4;
  a.q.forEach((q, i) => (d += 1 - Math.abs(q.dot(b.q[i]!))));
  return d;
}

/** Mínimos locales de la altura de la mano derecha (momento en que suelta el balón hacia el suelo). */
function handMinima(frames: Frame[]): number[] {
  const out: number[] = [];
  for (let i = 2; i < frames.length - 2; i++) {
    const y = frames[i]!.handY;
    if (y < frames[i - 1]!.handY && y <= frames[i + 1]!.handY && y < frames[i - 2]!.handY && y <= frames[i + 2]!.handY) out.push(i);
  }
  return out;
}

function findLoop(frames: Frame[], kind: 'dribble' | 'stride'): [number, number] {
  let best: [number, number] = [0, frames.length - 1];
  let bestCost = Infinity;
  if (kind === 'dribble') {
    const mins = handMinima(frames);
    for (let a = 0; a < mins.length; a++) {
      for (let b = a + 2; b < Math.min(mins.length, a + 3); b++) {
        const cost = poseDistance(frames[mins[a]!]!, frames[mins[b]!]!);
        if (cost < bestCost) [bestCost, best] = [cost, [mins[a]!, mins[b]!]];
      }
    }
  } else {
    const minP = Math.round(0.45 * FPS);
    const maxP = Math.round(0.9 * FPS);
    for (let s = 0; s + minP < frames.length; s++) {
      for (let e = s + minP; e <= Math.min(frames.length - 1, s + maxP); e++) {
        const cost = poseDistance(frames[s]!, frames[e]!) + poseDistance(frames[Math.min(s + 1, e)]!, frames[Math.min(e + 1, frames.length - 1)]!);
        if (cost < bestCost) [bestCost, best] = [cost, [s, e]];
      }
    }
  }
  console.log(`  bucle ${kind}: frames ${best[0]}→${best[1]} (${((best[1] - best[0]) / FPS).toFixed(2)} s, coste ${bestCost.toFixed(4)})`);
  return best;
}

/** Reparte la diferencia entre el último y el primer frame para que el bucle no "salte". */
function closeLoop(frames: Frame[], endFrame: Frame): void {
  const n = frames.length;
  const first = frames[0]!;
  const dRoot = first.rootY - endFrame.rootY;
  const dq = first.q.map((q, i) => q.clone().multiply(endFrame.q[i]!.clone().invert()));
  frames.forEach((f, i) => {
    const t = i / n;
    f.rootY += dRoot * t;
    f.q.forEach((q, j) => q.premultiply(new THREE.Quaternion().slerp(dq[j]!, t)));
  });
}

/** Trayectoria del balón entre soltarlo (mínimo de la mano) y recogerlo (máximo siguiente). */
function addDribbleBall(frames: Frame[]): void {
  const n = frames.length;
  const mins = handMinima([...frames, ...frames, ...frames]).filter((i) => i >= n && i < 2 * n).map((i) => i - n);
  for (const f of frames) f.ballY = -1;
  for (const m of mins) {
    // siguiente máximo (recogida), con vuelta al principio del bucle
    let c = m + 1;
    while (frames[(c + 1) % n]!.handY > frames[c % n]!.handY && c - m < n) c++;
    const len = c - m;
    if (len < 3) continue;
    const y0 = frames[m % n]!.handY - BALL_R;
    const y1 = frames[c % n]!.handY - BALL_R;
    const uf = 0.42; // fracción del tiempo hasta tocar el suelo
    for (let i = 1; i < len; i++) {
      const u = i / len;
      frames[(m + i) % n]!.ballY =
        u < uf ? y0 + (BALL_R - y0) * (u / uf) : BALL_R + (y1 - BALL_R) * Math.sin(((u - uf) / (1 - uf)) * (Math.PI / 2));
    }
  }
}

// ---------------------------------------------------------------------------
const cache = new Map<string, Sampled>();
const load = (file: string) => {
  if (!cache.has(file)) cache.set(file, sampleBvh(BVH(file), FPS));
  return cache.get(file)!;
};

{
  const calib = toBodySpace([load('06_15').frames[0]!]).body[0]!;
  torsoRestInv = torsoBasis(calib).invert();
}

const out: Record<string, unknown> = {};
for (const spec of SPECS) {
  console.log(`· ${spec.name} ← ${spec.file} [${spec.from}–${spec.to} s]`);
  const s = load(spec.file);
  const stand = standingHipY(s);
  const { body } = toBodySpace(s.frames);
  const a = Math.round(spec.from * FPS);
  const b = Math.min(body.length - 1, Math.round(spec.to * FPS));
  let frames = body.slice(a, b + 1).map((p) => retargetPose(p, stand, torsoRestInv));

  // Velocidad media real del clip (m/s, escalada al rig) para sincronizar la reproducción.
  const k = RIG_HIP_Y / stand;
  const raw = s.frames.slice(a, b + 1);

  let extra: Record<string, number> = {};
  if (spec.loop) {
    const [ls, le] = findLoop(frames, spec.loop);
    const end = frames[le]!;
    frames = frames.slice(ls, le);
    closeLoop(frames, end);
    if (spec.loop === 'dribble') addDribbleBall(frames);
    const dist = Math.hypot(raw[le]!.Hips.x - raw[ls]!.Hips.x, raw[le]!.Hips.z - raw[ls]!.Hips.z) * k;
    extra.speed = +(dist / ((le - ls) / FPS)).toFixed(3);
  }
  if (spec.shoot) {
    let rel = 0;
    frames.forEach((f, i) => {
      const p = body[a + i]!;
      const hy = p.LeftHand.y + p.RightHand.y;
      const best = body[a + rel]!;
      if (hy > best.LeftHand.y + best.RightHand.y) rel = i;
    });
    extra = { releaseTime: +(rel / FPS).toFixed(3) };
    // El rig no tiene la pose "de pie" del inicio: el primer frame es la recogida.
  }
  const r = (x: number) => Math.round(x * 1000) / 1000;
  out[spec.name] = {
    fps: FPS,
    loop: !!spec.loop,
    duration: +(frames.length / FPS).toFixed(3),
    ...extra,
    // Por frame: rootY, 9 cuaterniones (x,y,z,w) en el orden de SLOTS, ballY.
    frames: frames.map((f) => [r(f.rootY), ...f.q.flatMap((q) => [r(q.x), r(q.y), r(q.z), r(q.w)]), r(f.ballY)]),
  };
  console.log(`  ${frames.length} frames`, extra);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify({
    source: 'CMU Graphics Lab Motion Capture Database (mocap.cs.cmu.edu), sujetos 06 y 09. Retargeting propio.',
    slots: SLOTS,
    clips: out,
  }),
);
console.log(`→ ${OUT}`);
