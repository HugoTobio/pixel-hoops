/**
 * Lee un BVH de CMU y devuelve las posiciones de las articulaciones (mundo, en metros) muestreadas a `fps`.
 * Datos: CMU Graphics Lab Motion Capture Database (mocap.cs.cmu.edu). Permitido incluirlos en
 * productos comerciales; no se pueden revender los datos en sí, ni siquiera convertidos.
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';

export const JOINTS = [
  'Hips',
  'LeftUpLeg',
  'LeftLeg',
  'LeftFoot',
  'LeftToeBase',
  'RightUpLeg',
  'RightLeg',
  'RightFoot',
  'RightToeBase',
  'Spine1',
  'Neck',
  'Head',
  'LeftArm',
  'LeftForeArm',
  'LeftHand',
  'RightArm',
  'RightForeArm',
  'RightHand',
] as const;
export type Joint = (typeof JOINTS)[number];
export type Pose = Record<Joint, THREE.Vector3>;

/** Unidades de CMU: 1 unidad ≈ 1/0.45 pulgadas → metros. */
const CMU_TO_M = (1 / 0.45) * 0.0254;

export interface Sampled {
  name: string;
  fps: number;
  frames: Pose[];
}

export function sampleBvh(path: string, fps = 30): Sampled {
  const text = readFileSync(path, 'utf8');
  const { skeleton, clip } = new BVHLoader().parse(text);
  const holder = new THREE.Object3D();
  holder.add(skeleton.bones[0]!);
  const mixer = new THREE.AnimationMixer(holder);
  mixer.clipAction(clip).play();
  const byName = new Map(skeleton.bones.map((b) => [b.name, b]));
  const frames: Pose[] = [];
  const n = Math.floor(clip.duration * fps);
  for (let i = 0; i <= n; i++) {
    mixer.setTime(i / fps);
    holder.updateMatrixWorld(true);
    const pose = {} as Pose;
    for (const j of JOINTS) {
      const bone = byName.get(j);
      if (!bone) throw new Error(`Falta la articulación ${j} en ${path}`);
      pose[j] = bone.getWorldPosition(new THREE.Vector3()).multiplyScalar(CMU_TO_M);
    }
    frames.push(pose);
  }
  return { name: path.split('/').pop()!.replace('.bvh', ''), fps, frames };
}
