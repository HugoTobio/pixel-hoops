/**
 * Retargeting por direcciones de hueso, compartido por los BVH de CMU (tools/mocap/bake.ts) y por la
 * captura desde vídeo (estudio de mocap, src/mocap/capture.ts). Sin dependencias de Node: va en el navegador.
 *
 * De cada fotograma se toman las direcciones reales de los huesos (muslo, espinilla, brazo, antebrazo,
 * tronco) en el espacio del cuerpo (sin rumbo ni traslación) y se convierten en rotaciones locales de
 * nuestro rig, cuyos huesos en reposo apuntan a −Y. Así da igual que las medidas o la pose de reposo
 * de la fuente sean distintas.
 */
import * as THREE from 'three';

/** Articulaciones que necesita el retargeting (posiciones en metros, Y arriba). */
export const SOURCE_JOINTS = [
  'Hips', 'Neck',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
  'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
  'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightArm', 'RightForeArm', 'RightHand',
] as const;
export type Pose = Record<(typeof SOURCE_JOINTS)[number], THREE.Vector3>;

import { RIG } from './rig';

/** Altura de cadera del rig de referencia (ver rig.ts). */
export const RIG_HIP_Y = RIG.hipY;

export const UP = new THREE.Vector3(0, 1, 0);
export const v = () => new THREE.Vector3();

/** Rumbo del cuerpo (yaw) a partir de caderas + hombros: adelante = arriba × derecha. */
export function heading(p: Pose): number {
  const right = v().subVectors(p.RightUpLeg, p.LeftUpLeg).add(v().subVectors(p.RightArm, p.LeftArm));
  right.y = 0;
  const fwd = v().crossVectors(UP, right).normalize();
  return Math.atan2(fwd.x, fwd.z);
}

/**
 * Pasa la pose a espacio del cuerpo: caderas en el origen XZ, mirando a +Z.
 * Devuelve también el rumbo suavizado y desenrollado de cada fotograma (radianes).
 */
export function toBodySpace<T extends Pose>(frames: T[], window = 5): { body: T[]; yaw: number[] } {
  const yaws = frames.map(heading);
  for (let i = 1; i < yaws.length; i++) {
    while (yaws[i]! - yaws[i - 1]! > Math.PI) yaws[i]! -= 2 * Math.PI;
    while (yaws[i]! - yaws[i - 1]! < -Math.PI) yaws[i]! += 2 * Math.PI;
  }
  const yaw: number[] = [];
  const body = frames.map((p, i) => {
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, i - window); k <= Math.min(frames.length - 1, i + window); k++, n++) sum += yaws[k]!;
    yaw.push(sum / n);
    const q = new THREE.Quaternion().setFromAxisAngle(UP, -sum / n);
    const origin = v().set(p.Hips.x, 0, p.Hips.z);
    const out = {} as T;
    for (const [k, pos] of Object.entries(p) as [keyof T, THREE.Vector3][]) (out[k] as THREE.Vector3) = pos.clone().sub(origin).applyQuaternion(q);
    return out;
  });
  return { body, yaw };
}

/** Base ortonormal de un hueso que en reposo apunta a −Y; `hint` define hacia dónde mira su +Z. */
export function boneBasis(dir: THREE.Vector3, hint: THREE.Vector3): THREE.Quaternion {
  const y = dir.clone().normalize().negate();
  let z = hint.clone().addScaledVector(y, -hint.dot(y));
  if (z.lengthSq() < 1e-6) z = v().set(0, 0, 1).addScaledVector(y, -y.z);
  z.normalize();
  const x = v().crossVectors(y, z).normalize();
  z.crossVectors(x, y).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/** Base del tronco: Y = caderas→cuello, X = hombro derecho→izquierdo (izquierda anatómica = +X). */
export function torsoBasis(p: Pose): THREE.Quaternion {
  const y = v().subVectors(p.Neck, p.Hips).normalize();
  const x = v().subVectors(p.LeftArm, p.RightArm);
  x.addScaledVector(y, -x.dot(y)).normalize();
  const z = v().crossVectors(x, y).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

export interface Frame {
  rootY: number;
  q: THREE.Quaternion[];
  /** Altura del balón (unidades del rig) o −1 si va pegado a la mano. */
  ballY: number;
  handY: number;
}

/**
 * @param standHipY altura de cadera de pie en las unidades de la fuente (para escalar al rig).
 * @param torsoRestInv inversa de la base del tronco en la pose de calibración (tronco recto).
 */
/** Flexión máxima del codo (grados): más allá es un error de profundidad de la captura. */
export const MAX_ELBOW_FLEX = 150;

/**
 * Hacia dónde se dobla cada antebrazo (perpendicular al brazo), en el espacio de la pose.
 * Si se pasa (ya suavizado en el tiempo), manda sobre el cálculo de un solo fotograma, que con el
 * brazo casi recto es inestable y hace que el codo "salte" de lado.
 */
export interface ArmHints {
  L?: THREE.Vector3;
  R?: THREE.Vector3;
}

export function retarget(p: Pose, standHipY: number, torsoRestInv: THREE.Quaternion, armHints?: ArmHints): Frame {
  const k = RIG_HIP_Y / standHipY;
  const upper = torsoBasis(p).multiply(torsoRestInv);
  const upperInv = upper.clone().invert();

  const leg = (hip: THREE.Vector3, knee: THREE.Vector3, ankle: THREE.Vector3, toe: THREE.Vector3) => {
    const toeDir = v().subVectors(toe, ankle);
    const qThigh = boneBasis(v().subVectors(knee, hip), toeDir);
    const qShin = boneBasis(v().subVectors(ankle, knee), toeDir);
    return [qThigh, qThigh.clone().invert().multiply(qShin)];
  };
  const arm = (sh: THREE.Vector3, el: THREE.Vector3, wr: THREE.Vector3, given?: THREE.Vector3) => {
    const upperDir = v().subVectors(el, sh).normalize();
    const foreDir = v().subVectors(wr, el).normalize();
    // El brazo "mira" hacia donde se dobla el antebrazo; si está recto, hacia delante del tronco.
    let hint = given?.clone() ?? foreDir.clone().addScaledVector(upperDir, -foreDir.dot(upperDir));
    hint.addScaledVector(upperDir, -hint.dot(upperDir));
    if (hint.lengthSq() < 1e-4) hint = v().set(0, 0, 1).applyQuaternion(upper);
    hint.normalize();
    // Límite anatómico: el antebrazo no puede doblarse más de MAX_ELBOW_FLEX sobre el brazo.
    const flex = upperDir.angleTo(foreDir);
    const max = THREE.MathUtils.degToRad(MAX_ELBOW_FLEX);
    if (flex > max) foreDir.copy(upperDir).multiplyScalar(Math.cos(max)).addScaledVector(hint, Math.sin(max)).normalize();
    const qArm = boneBasis(upperDir, hint);
    const qFore = boneBasis(foreDir, hint);
    return [upperInv.clone().multiply(qArm), qArm.clone().invert().multiply(qFore)];
  };

  const [hipL, kneeL] = leg(p.LeftUpLeg, p.LeftLeg, p.LeftFoot, p.LeftToeBase);
  const [hipR, kneeR] = leg(p.RightUpLeg, p.RightLeg, p.RightFoot, p.RightToeBase);
  const [shL, elL] = arm(p.LeftArm, p.LeftForeArm, p.LeftHand, armHints?.L);
  const [shR, elR] = arm(p.RightArm, p.RightForeArm, p.RightHand, armHints?.R);
  return {
    rootY: (p.Hips.y - standHipY) * k,
    q: [upper, hipL!, kneeL!, hipR!, kneeR!, shL!, elL!, shR!, elR!],
    ballY: -1,
    handY: p.RightHand.y * k,
  };
}
