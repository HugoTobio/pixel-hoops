/**
 * Maniquí del estudio: un muñeco neutro con los huesos del rig de referencia (@brawl/mocap, rig.ts).
 * No tiene nada del juego: sirve para ver la animación tal cual se va a aplicar a cualquier personaje.
 * Una "nariz" en la cabeza y una franja en el pecho marcan hacia dónde mira.
 */
import * as THREE from 'three';
import { RIG, solveTwoBone, type PoseBuf } from '@brawl/mocap';

export interface MannequinExtra {
  /** Desplazamiento sobre el suelo (metros; x y z). */
  offset?: THREE.Vector3;
  /** Pies clavados: dónde (mundo) y cuánto (0–1). */
  footL?: THREE.Vector3;
  footR?: THREE.Vector3;
  footWL?: number;
  footWR?: number;
}

export interface Mannequin {
  root: THREE.Group;
  /** Altura en metros. */
  height: number;
  /** Pone una pose: rumbo (rad), salto (m) y, opcional, desplazamiento y pies clavados. */
  applyPose(src: PoseBuf, facing: number, lift?: number, extra?: MannequinExtra): void;
  /** Posición (mundo) de las palmas. */
  palms(outL: THREE.Vector3, outR: THREE.Vector3): void;
}

const SKIN = 0xd9cbb4;
const JOINT = 0x7d8aa3;
const ACCENT = 0x3f7fe0;

const mat = (color: number) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05, flatShading: true });

/** Segmento (cápsula) colgando hacia −Y desde el origen del hueso. */
function segment(parent: THREE.Object3D, length: number, rTop: number, rBot: number, color = SKIN) {
  const geo = new THREE.CylinderGeometry(rTop, rBot, length, 8);
  const m = new THREE.Mesh(geo, mat(color));
  m.position.y = -length / 2;
  m.castShadow = true;
  parent.add(m);
  return m;
}
function joint(parent: THREE.Object3D, r: number, y = 0) {
  const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), mat(JOINT));
  m.position.y = y;
  m.castShadow = true;
  parent.add(m);
  return m;
}

export function createMannequin(heightM = RIG.height): Mannequin {
  const root = new THREE.Group();
  const body = new THREE.Group(); // escala a la altura + desplazamiento + salto
  const scale = heightM / RIG.height;
  body.scale.setScalar(scale);
  root.add(body);
  const pivot = new THREE.Group(); // rumbo
  body.add(pivot);

  // Marca en el suelo bajo el personaje (con flecha hacia delante).
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.36, 0.42, 32), new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.55 }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.004;
  root.add(ring);
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.16, 3), new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.7 }));
  arrow.rotation.x = Math.PI / 2;
  arrow.position.set(0, 0.005, 0.5);
  pivot.add(arrow);

  // Piernas
  const makeLeg = (side: number) => {
    const hip = new THREE.Group();
    hip.position.set(side * RIG.hipX, RIG.hipY, 0);
    joint(hip, 0.075);
    segment(hip, RIG.thigh, 0.075, 0.06);
    const knee = new THREE.Group();
    knee.position.y = -RIG.thigh;
    hip.add(knee);
    joint(knee, 0.058);
    segment(knee, RIG.shin - 0.06, 0.055, 0.045);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.24), mat(JOINT));
    foot.position.set(0, -RIG.shin + 0.03, 0.05);
    foot.castShadow = true;
    knee.add(foot);
    const sole = new THREE.Object3D();
    sole.position.y = -RIG.shin;
    knee.add(sole);
    pivot.add(hip);
    return { hip, knee, sole };
  };
  const legL = makeLeg(1); // izquierda anatómica = +X (mira a +Z)
  const legR = makeLeg(-1);

  // Tronco (cuelga de la cadera)
  const upper = new THREE.Group();
  upper.position.y = RIG.hipY;
  pivot.add(upper);
  const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.16, 0.2), mat(SKIN));
  pelvis.castShadow = true;
  upper.add(pelvis);
  const chest = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.15, RIG.shoulderY - 0.08, 8), mat(SKIN));
  chest.scale.z = 0.62;
  chest.position.y = (RIG.shoulderY - 0.08) / 2 + 0.06;
  chest.castShadow = true;
  upper.add(chest);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.06, RIG.shoulderY - 0.2, 0.02), mat(ACCENT));
  stripe.position.set(0, chest.position.y + 0.02, 0.125);
  upper.add(stripe);
  const shoulders = new THREE.Mesh(new THREE.BoxGeometry(RIG.shoulderX * 2, 0.07, 0.14), mat(SKIN));
  shoulders.position.y = RIG.shoulderY;
  shoulders.castShadow = true;
  upper.add(shoulders);
  joint(upper, 0.045, RIG.shoulderY + 0.07); // cuello
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.11, 1), mat(SKIN));
  head.scale.set(0.9, 1.1, 0.95);
  head.position.y = RIG.headY;
  head.castShadow = true;
  upper.add(head);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.07, 4), mat(ACCENT));
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, RIG.headY, 0.12);
  upper.add(nose);

  // Brazos
  const makeArm = (side: number) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * RIG.shoulderX, RIG.shoulderY, 0);
    joint(shoulder, 0.055);
    segment(shoulder, RIG.upperArm, 0.05, 0.042);
    const elbow = new THREE.Group();
    elbow.position.y = -RIG.upperArm;
    shoulder.add(elbow);
    joint(elbow, 0.042);
    segment(elbow, RIG.foreArm - 0.07, 0.04, 0.032);
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.07), mat(JOINT));
    hand.position.y = -RIG.foreArm + 0.04;
    hand.castShadow = true;
    elbow.add(hand);
    const palm = new THREE.Object3D();
    palm.position.set(0, -RIG.foreArm, 0.02);
    elbow.add(palm);
    upper.add(shoulder);
    return { shoulder, elbow, palm };
  };
  const armL = makeArm(1);
  const armR = makeArm(-1);

  // Orden = SLOTS (pose.ts)
  const joints = [upper, legL.hip, legL.knee, legR.hip, legR.knee, armL.shoulder, armL.elbow, armR.shoulder, armR.elbow];
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const pole = new THREE.Vector3();

  return {
    root,
    height: heightM,
    applyPose(src, facing, lift = 0, extra) {
      joints.forEach((j, i) => j.quaternion.copy(src.q[i]!));
      body.position.set(extra?.offset?.x ?? 0, src.rootY * scale, extra?.offset?.z ?? 0);
      ring.position.set(body.position.x, ring.position.y, body.position.z);
      pivot.rotation.y = facing;
      body.updateMatrixWorld(true);
      // Pies al suelo: el más bajo toca el suelo; luego el salto.
      const footY = Math.min(legL.sole.getWorldPosition(v1).y, legR.sole.getWorldPosition(v2).y) - root.position.y;
      body.position.y += lift - footY;
      ring.scale.setScalar(1 - Math.min(0.4, Math.max(0, lift)));
      pole.set(Math.sin(facing), 0, Math.cos(facing));
      for (const [leg, target, w] of [
        [legL, extra?.footL, extra?.footWL ?? 0],
        [legR, extra?.footR, extra?.footWR ?? 0],
      ] as const) {
        if (!target || w <= 0.001) continue;
        body.updateMatrixWorld(true);
        solveTwoBone(leg.hip, leg.knee, leg.sole, target, w, pole);
      }
    },
    palms(outL, outR) {
      body.updateMatrixWorld(true);
      armL.palm.getWorldPosition(outL);
      armR.palm.getWorldPosition(outR);
    },
  };
}
