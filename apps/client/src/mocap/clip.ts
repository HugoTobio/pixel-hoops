/**
 * Reproduce un clip capturado desde vídeo (ver capture.ts) con exageración ajustable:
 *  - salto: multiplica la altura del vuelo (y el balón suelto sube con él);
 *  - pose: cada articulación se aparta más (o menos) de la postura de reposo del juego.
 */
import * as THREE from 'three';
import { Clip, idlePose, PoseBuf } from '../render/anim';
import type { Exaggerate, MocapClipJson } from './capture';

export interface MocapSample {
  pose: PoseBuf;
  /** Rumbo (rad), 0 = de frente a la cámara del vídeo. */
  yaw: number;
  /** Salto en unidades del rig (ya exagerado). */
  lift: number;
  /** Balón suelto en unidades del rig, relativo a la cadera en el suelo (ya exagerado). */
  ball: THREE.Vector3;
  /** Peso "en la mano" izquierda/derecha (0–1). */
  holdL: number;
  holdR: number;
}

const REST = idlePose(new PoseBuf(), 0);
const _d = new THREE.Quaternion();

/** q = base · (base⁻¹ · q)^f : f > 1 exagera el giro respecto a la base, f < 1 lo suaviza. */
export function amplify(q: THREE.Quaternion, base: THREE.Quaternion, f: number): void {
  if (f === 1) return;
  _d.copy(base).invert().multiply(q);
  if (_d.w < 0) _d.set(-_d.x, -_d.y, -_d.z, -_d.w);
  const w = Math.min(1, _d.w);
  const s = Math.sqrt(1 - w * w);
  if (s < 1e-5) return;
  const angle = Math.min(2 * Math.acos(w) * f, Math.PI * 0.95);
  const k = Math.sin(angle / 2) / s;
  _d.set(_d.x * k, _d.y * k, _d.z * k, Math.cos(angle / 2));
  q.copy(base).multiply(_d);
}

export class MocapClip {
  readonly duration: number;
  readonly fps: number;
  exaggerate: Exaggerate;
  private readonly clip: Clip;
  /** Para cada frame, el último en el que el balón iba en la mano (para que el balón suelto siga al salto). */
  private readonly lastHeld: number[];

  constructor(private readonly json: MocapClipJson) {
    this.clip = new Clip(json);
    this.duration = json.duration;
    this.fps = json.fps;
    this.exaggerate = { ...json.exaggerate };
    let last = 0;
    this.lastHeld = json.ball.map((b, i) => (b[3]! + b[4]! > 0.5 ? (last = i) : last));
  }

  private track(i: number, j: number, u: number, get: (k: number) => number) {
    return get(i) + (get(j) - get(i)) * u;
  }

  sample(t: number, out: MocapSample): MocapSample {
    const n = this.json.yaw.length;
    const f = Math.max(0, Math.min(n - 1, t * this.fps));
    const i = Math.floor(f);
    const j = Math.min(n - 1, i + 1);
    const u = f - i;
    const e = this.exaggerate;

    this.clip.sample(t, out.pose);
    for (let s = 0; s < out.pose.q.length; s++) amplify(out.pose.q[s]!, REST.q[s]!, e.pose);

    out.yaw = this.track(i, j, u, (k) => this.json.yaw[k]!);
    const lift = this.track(i, j, u, (k) => this.json.lift[k]!);
    out.lift = lift * e.jump;

    const b = (k: number, c: number) => this.json.ball[k]![c]!;
    out.ball.set(this.track(i, j, u, (k) => b(k, 0)), this.track(i, j, u, (k) => b(k, 1)), this.track(i, j, u, (k) => b(k, 2)));
    out.holdL = this.track(i, j, u, (k) => b(k, 3));
    out.holdR = this.track(i, j, u, (k) => b(k, 4));
    // El balón suelto sube lo mismo que subió el cuerpo de más cuando lo soltó.
    out.ball.y += this.json.lift[this.lastHeld[i]!]! * (e.jump - 1);
    return out;
  }

  static emptySample(): MocapSample {
    return { pose: new PoseBuf(), yaw: 0, lift: 0, ball: new THREE.Vector3(), holdL: 0, holdR: 0 };
  }
}
