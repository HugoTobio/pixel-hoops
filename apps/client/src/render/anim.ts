import * as THREE from 'three';
import data from '../content/anims/clips.json';

/**
 * Reproductor de clips horneados desde mocap (ver tools/mocap/bake.ts).
 * Cada frame: rootY, 9 cuaterniones locales (orden SLOTS) y la altura del balón (−1 = en la mano).
 */
export const SLOTS = ['upper', 'hipL', 'kneeL', 'hipR', 'kneeR', 'shL', 'elL', 'shR', 'elR'] as const;
export type Slot = (typeof SLOTS)[number];
export const LOWER: readonly number[] = [1, 2, 3, 4];
export const UPPER: readonly number[] = [0, 5, 6, 7, 8];

export class PoseBuf {
  rootY = 0;
  ballY = -1;
  readonly q = SLOTS.map(() => new THREE.Quaternion());

  copy(o: PoseBuf, slots: readonly number[] = ALL, withRoot = true): this {
    if (withRoot) {
      this.rootY = o.rootY;
      this.ballY = o.ballY;
    }
    for (const i of slots) this.q[i]!.copy(o.q[i]!);
    return this;
  }

  /** this = mezcla(this, o, w) en los slots indicados. */
  blend(o: PoseBuf, w: number, slots: readonly number[] = ALL, withRoot = true): this {
    if (w <= 0) return this;
    if (w >= 1) return this.copy(o, slots, withRoot);
    if (withRoot) this.rootY += (o.rootY - this.rootY) * w;
    for (const i of slots) this.q[i]!.slerp(o.q[i]!, w);
    return this;
  }
}
const ALL: readonly number[] = SLOTS.map((_, i) => i);

interface ClipJson {
  fps: number;
  loop: boolean;
  duration: number;
  speed?: number;
  releaseTime?: number;
  frames: number[][];
}

export class Clip {
  readonly fps: number;
  readonly loop: boolean;
  readonly duration: number;
  readonly speed: number;
  readonly releaseTime: number;
  private readonly frames: number[][];
  private readonly qa = new THREE.Quaternion();
  private readonly qb = new THREE.Quaternion();

  constructor(j: ClipJson) {
    this.fps = j.fps;
    this.loop = j.loop;
    this.duration = j.duration;
    this.speed = j.speed ?? 0;
    this.releaseTime = j.releaseTime ?? 0;
    this.frames = j.frames;
  }

  sample(t: number, out: PoseBuf): PoseBuf {
    const n = this.frames.length;
    let f = t * this.fps;
    if (this.loop) f = ((f % n) + n) % n;
    else f = Math.max(0, Math.min(n - 1, f));
    const i0 = Math.floor(f);
    const i1 = this.loop ? (i0 + 1) % n : Math.min(n - 1, i0 + 1);
    const a = this.frames[i0]!;
    const b = this.frames[i1]!;
    const u = f - i0;
    out.rootY = a[0]! + (b[0]! - a[0]!) * u;
    for (let s = 0; s < SLOTS.length; s++) {
      const k = 1 + s * 4;
      this.qa.set(a[k]!, a[k + 1]!, a[k + 2]!, a[k + 3]!);
      this.qb.set(b[k]!, b[k + 1]!, b[k + 2]!, b[k + 3]!);
      out.q[s]!.slerpQuaternions(this.qa, this.qb, u);
    }
    // El balón: sin interpolar entre "en mano" (−1) y "en el aire".
    const ba = a[37]!;
    const bb = b[37]!;
    out.ballY = ba < 0 || bb < 0 ? (u < 0.5 ? ba : bb) : ba + (bb - ba) * u;
    return out;
  }
}

const clips = (data as unknown as { clips: Record<string, ClipJson> }).clips;
export const CLIPS = {
  dribble: new Clip(clips.dribble!),
  run: new Clip(clips.run!),
  shoot: new Clip(clips.shoot!),
};

/** Pose de reposo (sin mocap): rodillas algo flexionadas y brazos relajados. */
export function idlePose(out: PoseBuf, breath: number): PoseBuf {
  const e = new THREE.Euler();
  out.rootY = -0.03 + breath * 0.006;
  out.ballY = -1;
  out.q[0]!.setFromEuler(e.set(0.05, 0, 0));
  out.q[1]!.setFromEuler(e.set(-0.12, 0, -0.04));
  out.q[2]!.setFromEuler(e.set(0.22, 0, 0));
  out.q[3]!.setFromEuler(e.set(-0.12, 0, 0.04));
  out.q[4]!.setFromEuler(e.set(0.22, 0, 0));
  out.q[5]!.setFromEuler(e.set(0.05, 0, 0.12 + breath * 0.02));
  out.q[6]!.setFromEuler(e.set(-0.3, 0, 0));
  out.q[7]!.setFromEuler(e.set(0.05, 0, -0.12 - breath * 0.02));
  out.q[8]!.setFromEuler(e.set(-0.3, 0, 0));
  return out;
}
