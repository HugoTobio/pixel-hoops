/**
 * Hornea clips de mocap (BVH de CMU) al esqueleto low poly del juego.
 *
 * Retargeting por direcciones: de cada fotograma se toman las direcciones reales de los huesos
 * (muslo, espinilla, brazo, antebrazo, tronco) en el espacio del cuerpo (sin rumbo ni traslación)
 * y se convierten en rotaciones locales de nuestro rig, cuyos huesos en reposo apuntan a −Y.
 * Así da igual que las medidas o la pose de reposo del mocap sean distintas.
 *
 * Uso: npm run bake:mocap   (lee tools/mocap/bvh/*.bvh, escribe apps/client/src/content/anims/clips.json)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { sampleBvh, type Pose, type Sampled } from './sample';

const FPS = 30;
const BVH = (n: string) => new URL(`./bvh/${n}.bvh`, import.meta.url).pathname;
const OUT = new URL('../../apps/client/src/content/anims/clips.json', import.meta.url).pathname;

/** Altura de cadera del rig de referencia (jugador de 2,00 m), igual que en player-model.ts. */
const RIG_HIP_Y = 1.02;
/** Radio del balón visual en unidades del rig de referencia. */
const BALL_R = 0.2;

export const SLOTS = ['upper', 'hipL', 'kneeL', 'hipR', 'kneeR', 'shL', 'elL', 'shR', 'elR'] as const;

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

// ---------------------------------------------------------------------------
const UP = new THREE.Vector3(0, 1, 0);
const v = () => new THREE.Vector3();

/** Rumbo del cuerpo (yaw) a partir de caderas + hombros: adelante = arriba × derecha. */
function heading(p: Pose): number {
  const right = v().subVectors(p.RightUpLeg, p.LeftUpLeg).add(v().subVectors(p.RightArm, p.LeftArm));
  right.y = 0;
  const fwd = v().crossVectors(UP, right).normalize();
  return Math.atan2(fwd.x, fwd.z);
}

/** Pasa la pose a espacio del cuerpo: caderas en el origen XZ, mirando a +Z. */
function toBodySpace(frames: Pose[]): Pose[] {
  const yaws = frames.map(heading);
  // Rumbo suavizado (desenrollado) para conservar el balanceo de caderas.
  for (let i = 1; i < yaws.length; i++) {
    while (yaws[i]! - yaws[i - 1]! > Math.PI) yaws[i]! -= 2 * Math.PI;
    while (yaws[i]! - yaws[i - 1]! < -Math.PI) yaws[i]! += 2 * Math.PI;
  }
  const W = 5;
  return frames.map((p, i) => {
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, i - W); k <= Math.min(frames.length - 1, i + W); k++, n++) sum += yaws[k]!;
    const q = new THREE.Quaternion().setFromAxisAngle(UP, -sum / n);
    const origin = v().set(p.Hips.x, 0, p.Hips.z);
    const out = {} as Pose;
    for (const [k, pos] of Object.entries(p)) out[k as keyof Pose] = pos.clone().sub(origin).applyQuaternion(q);
    return out;
  });
}

/** Base ortonormal de un hueso que en reposo apunta a −Y; `hint` define hacia dónde mira su +Z. */
function boneBasis(dir: THREE.Vector3, hint: THREE.Vector3): THREE.Quaternion {
  const y = dir.clone().normalize().negate();
  let z = hint.clone().addScaledVector(y, -hint.dot(y));
  if (z.lengthSq() < 1e-6) z = v().set(0, 0, 1).addScaledVector(y, -y.z);
  z.normalize();
  const x = v().crossVectors(y, z).normalize();
  z.crossVectors(x, y).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/** Base del tronco: Y = caderas→cuello, X = hombro derecho→izquierdo (izquierda anatómica = +X). */
function torsoBasis(p: Pose): THREE.Quaternion {
  const y = v().subVectors(p.Neck, p.Hips).normalize();
  const x = v().subVectors(p.LeftArm, p.RightArm);
  x.addScaledVector(y, -x.dot(y)).normalize();
  const z = v().crossVectors(x, y).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/** Corrección del tronco: en la pose de calibración (T-pose del 06_15) el tronco debe quedar recto. */
let torsoRestInv: THREE.Quaternion;

interface Frame {
  rootY: number;
  q: THREE.Quaternion[];
  /** Altura del balón (unidades del rig) o −1 si va pegado a la mano. */
  ballY: number;
  handY: number;
}

function retarget(p: Pose, standHipY: number): Frame {
  const k = RIG_HIP_Y / standHipY;
  const upper = torsoBasis(p).multiply(torsoRestInv);
  const upperInv = upper.clone().invert();

  const leg = (hip: THREE.Vector3, knee: THREE.Vector3, ankle: THREE.Vector3, toe: THREE.Vector3) => {
    const toeDir = v().subVectors(toe, ankle);
    const qThigh = boneBasis(v().subVectors(knee, hip), toeDir);
    const qShin = boneBasis(v().subVectors(ankle, knee), toeDir);
    return [qThigh, qThigh.clone().invert().multiply(qShin)];
  };
  const arm = (sh: THREE.Vector3, el: THREE.Vector3, wr: THREE.Vector3) => {
    const upperDir = v().subVectors(el, sh);
    const foreDir = v().subVectors(wr, el);
    // El brazo "mira" hacia donde se dobla el antebrazo; si está recto, hacia delante del tronco.
    const hint = foreDir.clone().addScaledVector(upperDir.clone().normalize(), -foreDir.dot(upperDir.clone().normalize()));
    if (hint.lengthSq() < 1e-4) hint.set(0, 0, 1).applyQuaternion(upper);
    const qArm = boneBasis(upperDir, hint);
    const qFore = boneBasis(foreDir, hint);
    return [upperInv.clone().multiply(qArm), qArm.clone().invert().multiply(qFore)];
  };

  const [hipL, kneeL] = leg(p.LeftUpLeg, p.LeftLeg, p.LeftFoot, p.LeftToeBase);
  const [hipR, kneeR] = leg(p.RightUpLeg, p.RightLeg, p.RightFoot, p.RightToeBase);
  const [shL, elL] = arm(p.LeftArm, p.LeftForeArm, p.LeftHand);
  const [shR, elR] = arm(p.RightArm, p.RightForeArm, p.RightHand);
  return {
    rootY: (p.Hips.y - standHipY) * k,
    q: [upper, hipL!, kneeL!, hipR!, kneeR!, shL!, elL!, shR!, elR!],
    ballY: -1,
    handY: p.RightHand.y * k,
  };
}

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
  const calib = toBodySpace([load('06_15').frames[0]!])[0]!;
  torsoRestInv = torsoBasis(calib).invert();
}

const out: Record<string, unknown> = {};
for (const spec of SPECS) {
  console.log(`· ${spec.name} ← ${spec.file} [${spec.from}–${spec.to} s]`);
  const s = load(spec.file);
  const stand = standingHipY(s);
  const body = toBodySpace(s.frames);
  const a = Math.round(spec.from * FPS);
  const b = Math.min(body.length - 1, Math.round(spec.to * FPS));
  let frames = body.slice(a, b + 1).map((p) => retarget(p, stand));

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

mkdirSync(new URL('.', `file://${OUT}`).pathname, { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify({
    source: 'CMU Graphics Lab Motion Capture Database (mocap.cs.cmu.edu), sujetos 06 y 09. Retargeting propio.',
    slots: SLOTS,
    clips: out,
  }),
);
console.log(`→ ${OUT}`);
