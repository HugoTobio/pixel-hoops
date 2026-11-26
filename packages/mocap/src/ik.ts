/**
 * Cinemática inversa de dos huesos (cadera → rodilla → pie, o hombro → codo → mano) sobre objetos de
 * three.js cuyos huesos en reposo apuntan a −Y. La usan el maniquí del estudio y los jugadores del juego
 * para clavar los pies en el suelo.
 */
import * as THREE from 'three';

const v = Array.from({ length: 8 }, () => new THREE.Vector3());
const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();

/** Gira `bone` (en el mundo) lo justo para que la dirección `from` pase a ser `to`. */
function turnBone(bone: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3) {
  qa.setFromUnitVectors(from.normalize(), to.normalize());
  bone.getWorldQuaternion(qb);
  qb.premultiply(qa);
  bone.parent!.getWorldQuaternion(qa);
  bone.quaternion.copy(qa.invert().multiply(qb));
  bone.updateMatrixWorld(true);
}

/**
 * Lleva `end` hacia `target` (mundo) con peso w, conservando hacia dónde dobla la articulación del medio.
 * `pole` se usa solo si la cadena está totalmente recta (dirección de doblez indefinida).
 * Las matrices del mundo deben estar al día antes de llamarla.
 */
export function solveTwoBone(
  upper: THREE.Object3D,
  middle: THREE.Object3D,
  end: THREE.Object3D,
  target: THREE.Vector3,
  w: number,
  pole: THREE.Vector3,
): void {
  if (w <= 0.001) return;
  const [H, K, S, T, dir, p, nk, tmp] = v as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
  upper.getWorldPosition(H);
  middle.getWorldPosition(K);
  end.getWorldPosition(S);
  const l1 = H.distanceTo(K);
  const l2 = K.distanceTo(S);
  T.copy(S).lerp(target, Math.min(1, w));
  dir.subVectors(T, H);
  const d = THREE.MathUtils.clamp(dir.length(), Math.abs(l1 - l2) + 1e-3, (l1 + l2) * 0.999);
  dir.normalize();
  p.subVectors(K, H).addScaledVector(dir, -tmp.subVectors(K, H).dot(dir));
  if (p.lengthSq() < 1e-8) p.copy(pole);
  p.normalize();
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  nk.copy(H).addScaledVector(dir, a).addScaledVector(p, h);
  turnBone(upper, tmp.subVectors(K, H), nk.sub(H));
  middle.getWorldPosition(K);
  end.getWorldPosition(S);
  turnBone(middle, tmp.subVectors(S, K), T.sub(K));
}
