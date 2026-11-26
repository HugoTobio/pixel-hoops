import * as THREE from 'three';
import type { PlayerLook } from '../content/teams';
import { CLIPS, idlePose, LOWER, PoseBuf, UPPER } from './anim';
import { faceted, outlineMaterial, toonMaterial } from './toon';

/** Grosor del contorno en metros (de referencia, antes de escalar por altura). */
const OUTLINE = 0.02;
/** Todas las medidas de abajo son para un jugador de 2,00 m; luego se escala a su altura real. */
const REF_HEIGHT = 2.0;

/** Malla + contorno por casco invertido. La geometría debe estar centrada en el origen. */
function part(parent: THREE.Object3D, source: THREE.BufferGeometry, color: number, x: number, y: number, z: number, outline = true) {
  const geo = faceted(source);
  const mesh = new THREE.Mesh(geo, toonMaterial(color));
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  if (outline) {
    geo.computeBoundingBox();
    const size = geo.boundingBox!.getSize(new THREE.Vector3());
    const hull = new THREE.Mesh(geo, outlineMaterial);
    hull.scale.set((size.x + OUTLINE * 2) / size.x, (size.y + OUTLINE * 2) / size.y, (size.z + OUTLINE * 2) / size.z);
    mesh.add(hull);
  }
  parent.add(mesh);
  return mesh;
}

/** Cilindro low poly; con thetaStart = π/segs una cara queda mirando al frente (+z). */
const cyl = (rTop: number, rBot: number, h: number, segs = 6) => new THREE.CylinderGeometry(rTop, rBot, h, segs, 1, false, Math.PI / segs);

/** Fuente de píxeles 3×5 para los dorsales. */
const DIGITS: Record<string, string> = {
  '0': '111101101101111',
  '1': '010110010010111',
  '2': '111001111100111',
  '3': '111001111001111',
  '4': '101101111001001',
  '5': '111100111001111',
  '6': '111100111101111',
  '7': '111001010010010',
  '8': '111101111101111',
  '9': '111101111001111',
};

const numberTextures = new Map<string, THREE.CanvasTexture>();
function numberTexture(n: number, color: number): THREE.CanvasTexture {
  const key = `${n}-${color}`;
  const cached = numberTextures.get(key);
  if (cached) return cached;
  const text = String(n);
  const w = text.length * 4 + 1;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = 7;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  [...text].forEach((ch, i) => {
    const bits = DIGITS[ch]!;
    for (let k = 0; k < 15; k++) if (bits[k] === '1') ctx.fillRect(1 + i * 4 + (k % 3), 1 + Math.floor(k / 3), 1, 1);
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  numberTextures.set(key, tex);
  return tex;
}

export interface AnimState {
  speed: number;
  /** radianes (0 = +z) */
  facing: number;
  hasBall: boolean;
  charging: boolean;
  /** 0..1: progreso de la recogida hasta el punto ideal de soltar. */
  chargeProgress: number;
  /** Gesto de jugada: pedir el balón cortando, saltar bajo el aro, o bloqueo. */
  action: 'none' | 'callBall' | 'jumpCall' | 'screen' | 'layup' | 'dunk';
  /** Altura extra del cuerpo (salto del corte), en metros. */
  lift: number;
}

const qe = (x: number, y: number, z: number) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z));
/** Poses fijas de los gestos (slots de anim.ts: 1 caderaI 2 rodillaI 3 caderaD 4 rodillaD 5 hombroI 6 codoI 7 hombroD 8 codoD). */
const GESTURE = {
  ident: new THREE.Quaternion(),
  callArm: qe(-2.75, 0, 0.18),
  callElbow: qe(-0.25, 0, 0),
  upL: qe(-2.9, 0, 0.22),
  upR: qe(-2.9, 0, -0.22),
  straightElbow: qe(-0.15, 0, 0),
  tuckHip: qe(-0.3, 0, 0),
  tuckKnee: qe(0.5, 0, 0),
  // Brazos en jarras: brazo hacia fuera y antebrazo de vuelta a la cintura (codos abiertos).
  akimboL: qe(0.1, 0, 0.75),
  akimboR: qe(0.1, 0, -0.75),
  akimboElbowL: qe(0, 0, -2.1),
  akimboElbowR: qe(0, 0, 2.1),
  wideHipL: qe(-0.08, 0, 0.17),
  wideHipR: qe(-0.08, 0, -0.17),
  bentKnee: qe(0.3, 0, 0),
  // Bandeja (mano derecha): brazo derecho estirado hacia el aro, rodilla izquierda arriba.
  layArm: qe(-2.6, 0, -0.1),
  layOtherArm: qe(-1.2, 0, 0.3),
  layKneeUpHip: qe(-1.3, 0, 0),
  layKneeUp: qe(1.5, 0, 0),
  layTrailHip: qe(0.25, 0, 0),
  // Mate: los dos brazos arriba y algo adelantados.
  dunkL: qe(-2.7, 0, 0.12),
  dunkR: qe(-2.7, 0, -0.12),
};

export interface PlayerModel {
  root: THREE.Group;
  /** Altura real del jugador en metros. */
  height: number;
  update(dt: number, s: AnimState): void;
  /**
   * Pone una pose concreta (p. ej. un clip de mocap reproducido desde fuera), sin las capas de update().
   * Apoya el pie más bajo en el suelo y luego suma `lift` (salto, en metros).
   */
  applyPose(src: PoseBuf, facing: number, lift?: number): void;
  /** Posición (mundo) de las palmas izquierda y derecha. */
  palms(outL: THREE.Vector3, outR: THREE.Vector3): void;
  /** Posición del balón cuando este jugador lo tiene (mundo). */
  ballAnchor(out: THREE.Vector3): void;
  /** Cambia el color del aro bajo los pies (p. ej. al pasar a controlar a este jugador). */
  setRing(color: number): void;
}

/** Radio visual del balón (en main.ts se dibuja 1,6× el real). */
const BALL_VISUAL_R = 0.19;

export function createPlayerModel(look: PlayerLook, heightM: number, ringColor: number): PlayerModel {
  const { palette: p, build: b } = look;
  const root = new THREE.Group();

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.42, 0.54, 20),
    new THREE.MeshBasicMaterial({ color: ringColor, transparent: true, opacity: 0.9, depthWrite: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.015;
  root.add(ring);

  const body = new THREE.Group(); // escala a la altura real + salto
  body.scale.setScalar(heightM / REF_HEIGHT);
  root.add(body);
  const pivot = new THREE.Group(); // orientación
  body.add(pivot);

  // ---- Piernas (cadera → rodilla → pie) ----
  const HIP_Y = 1.02;
  const makeLeg = (side: number) => {
    const hip = new THREE.Group();
    hip.position.set(side * 0.1 * b, HIP_Y, 0);
    part(hip, cyl(0.13 * b, 0.125 * b, 0.4, 6), p.shorts, 0, -0.17, 0); // pernera holgada hasta la rodilla
    part(hip, cyl(0.08 * b, 0.066 * b, 0.46, 5), p.skin, 0, -0.23, 0, false); // muslo
    const knee = new THREE.Group();
    knee.position.y = -0.46;
    hip.add(knee);
    part(knee, cyl(0.066 * b, 0.05 * b, 0.44, 5), p.skin, 0, -0.22, 0);
    part(knee, cyl(0.05 * b, 0.048 * b, 0.12, 5), 0xf7f3ea, 0, -0.38, 0, false); // calcetín
    part(knee, new THREE.BoxGeometry(0.12 * b, 0.09, 0.27), p.shoes, 0, -0.5, 0.04);
    const sole = new THREE.Object3D();
    sole.position.set(0, -0.545, 0);
    knee.add(sole);
    pivot.add(hip);
    return { hip, knee, sole };
  };
  // Izquierda anatómica = +X (el modelo mira a +Z), igual que en el mocap.
  const legL = makeLeg(1);
  const legR = makeLeg(-1);

  // ---- Tronco: todo lo de arriba cuelga de la cadera para poder inclinarse ----
  const upper = new THREE.Group();
  upper.position.y = HIP_Y;
  pivot.add(upper);

  const pelvis = part(upper, cyl(0.23 * b, 0.25 * b, 0.2, 6), p.shorts, 0, 0.02, 0);
  pelvis.scale.z = 0.7;
  part(upper, cyl(0.235 * b, 0.235 * b, 0.035, 6), p.trim, 0, 0.115, 0, false).scale.z = 0.72; // cinturilla

  // Camiseta de tirantes: el rasgo principal.
  // Camiseta holgada: empieza por debajo de la cinturilla y se ensancha en los hombros.
  const TORSO_BASE = 0.06;
  const TORSO_H = 0.62;
  const TORSO_Y = TORSO_BASE + TORSO_H / 2;
  const rTop = 0.3 * b;
  const rBot = 0.25 * b;
  const DEPTH = 0.6;
  const torso = part(upper, cyl(rTop, rBot, TORSO_H, 6), p.jersey, 0, TORSO_Y, 0);
  torso.scale.z = DEPTH;
  part(upper, cyl(0.14 * b, 0.17 * b, 0.045, 6), p.trim, 0, TORSO_BASE + TORSO_H, 0, false).scale.z = DEPTH; // cuello
  part(upper, cyl(rBot + 0.006, rBot + 0.006, 0.04, 6), p.trim, 0, TORSO_BASE + 0.02, 0, false).scale.z = DEPTH + 0.02; // bajo
  // Franjas laterales
  const taper = Math.atan((rTop - rBot) / TORSO_H);
  for (const side of [-1, 1]) {
    const stripe = part(upper, new THREE.BoxGeometry(0.03, TORSO_H * 0.9, 0.08), p.trim, side * ((rTop + rBot) / 2 + 0.004), TORSO_Y, 0, false);
    stripe.rotation.z = -side * taper;
  }
  // Dorsal delante (pequeño) y detrás (grande), como una camiseta real.
  const faceZ = ((rTop + rBot) / 2) * Math.cos(Math.PI / 6) * DEPTH + 0.006;
  const lean = Math.atan(((rTop - rBot) * Math.cos(Math.PI / 6) * DEPTH) / TORSO_H);
  const numTex = numberTexture(look.number, p.trim);
  const numAspect = numTex.image.width / numTex.image.height;
  const numMat = new THREE.MeshBasicMaterial({ map: numTex, transparent: true, alphaTest: 0.5 });
  const front = new THREE.Mesh(new THREE.PlaneGeometry(0.25 * numAspect * 0.55, 0.25), numMat);
  front.position.set(0, TORSO_Y + 0.04, faceZ);
  front.rotation.x = lean;
  upper.add(front);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(0.3 * numAspect * 0.55, 0.3), numMat);
  back.position.set(0, TORSO_Y + 0.02, -faceZ);
  back.rotation.set(-lean, Math.PI, 0);
  upper.add(back);

  // Cuello y cabeza (≈ 1/7 de la altura)
  part(upper, cyl(0.055, 0.06, 0.1, 5), p.skin, 0, TORSO_BASE + TORSO_H + 0.05, 0, false);
  const HEAD_Y = TORSO_BASE + TORSO_H + 0.19;
  const head = part(upper, new THREE.IcosahedronGeometry(0.115, 0), p.skin, 0, HEAD_Y, 0.005);
  head.scale.set(0.9, 1.12, 1);
  const hair = part(upper, new THREE.IcosahedronGeometry(0.118, 0), p.hair, 0, HEAD_Y + 0.055, -0.012, false);
  hair.scale.set(0.95, 0.6, 1.02);

  // ---- Brazos (hombro → codo → mano) ----
  const SHOULDER_Y = TORSO_BASE + TORSO_H - 0.07;
  const makeArm = (side: number) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * (rTop + 0.03), SHOULDER_Y, 0);
    part(shoulder, cyl(0.066 * b, 0.054 * b, 0.32, 5), p.skin, 0, -0.16, 0);
    const elbow = new THREE.Group();
    elbow.position.y = -0.32;
    shoulder.add(elbow);
    part(elbow, cyl(0.052 * b, 0.042 * b, 0.27, 5), p.skin, 0, -0.135, 0);
    part(elbow, new THREE.BoxGeometry(0.06, 0.09, 0.05), p.skin, 0, -0.31, 0, false);
    const palm = new THREE.Object3D();
    palm.position.set(0, -0.36, 0.02);
    elbow.add(palm);
    upper.add(shoulder);
    return { shoulder, elbow, palm };
  };
  const armL = makeArm(1);
  const armR = makeArm(-1);

  // Orden de aplicación = SLOTS de anim.ts
  const joints = [upper, legL.hip, legL.knee, legR.hip, legR.knee, armL.shoulder, armL.elbow, armR.shoulder, armR.elbow];
  const scale = heightM / REF_HEIGHT;
  const pose = new PoseBuf();
  const runSample = new PoseBuf();
  const tmp = new PoseBuf();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();

  let t = Math.random() * 10;
  let runT = Math.random();
  let dribbleT = 0;
  let runW = 0;
  let ballW = 0;
  let shootT: number | null = null;
  let shootW = 0;
  let lastShootT = 0;
  let callW = 0;
  let jumpW = 0;
  let screenW = 0;
  let layW = 0;
  let dunkW = 0;
  let action: AnimState['action'] = 'none';
  let ballY = -1;

  return {
    root,
    height: heightM,
    update(dt, s) {
      t += dt;
      runW += (THREE.MathUtils.smoothstep(s.speed, 0.4, 3.2) - runW) * Math.min(1, dt * 8);
      ballW += ((s.hasBall ? 1 : 0) - ballW) * Math.min(1, dt * 10);
      runT += dt * THREE.MathUtils.clamp(s.speed / CLIPS.run.speed, 0.6, 1.5);
      dribbleT += dt * THREE.MathUtils.lerp(1.15, 1.7, runW); // el bote se acelera al correr

      // Tiro: la recogida se sincroniza con la barra; tras soltar, el clip sigue a su ritmo.
      const shoot = CLIPS.shoot;
      if (s.charging) shootT = shoot.releaseTime * THREE.MathUtils.clamp(s.chargeProgress, 0, 1);
      else if (shootT !== null) {
        shootT += dt;
        if (shootT >= shoot.duration) shootT = null;
      }
      if (shootT !== null) lastShootT = shootT;
      const shootTarget = shootT === null ? 0 : Math.min(1, (shoot.duration - shootT) / 0.25);
      shootW += (shootTarget - shootW) * Math.min(1, dt * 16);

      // Piernas: reposo ↔ carrera. Tronco/brazos: reposo ↔ carrera ↔ bote (capas).
      idlePose(pose, Math.sin(t * 2.5));
      CLIPS.run.sample(runT, runSample);
      pose.blend(runSample, runW, LOWER, true);
      pose.blend(runSample, runW, UPPER, false);
      if (ballW > 0.01) {
        CLIPS.dribble.sample(dribbleT, tmp);
        pose.blend(tmp, ballW, UPPER, false);
      }
      ballY = ballW > 0.5 ? tmp.ballY : -1;
      if (shootW > 0.01) pose.blend(shoot.sample(lastShootT, tmp), shootW, undefined, true);

      // Gestos de jugada encima de todo lo anterior.
      const k = Math.min(1, dt * 12);
      callW += ((s.action === 'callBall' ? 1 : 0) - callW) * k;
      jumpW += ((s.action === 'jumpCall' ? 1 : 0) - jumpW) * k;
      screenW += ((s.action === 'screen' ? 1 : 0) - screenW) * k;
      const kf = Math.min(1, dt * 18); // las finalizaciones son rápidas
      layW += ((s.action === 'layup' ? 1 : 0) - layW) * kf;
      dunkW += ((s.action === 'dunk' ? 1 : 0) - dunkW) * kf;
      action = s.action;
      const q = pose.q;
      if (callW > 0.01) {
        q[5]!.slerp(GESTURE.callArm, callW);
        q[6]!.slerp(GESTURE.callElbow, callW);
      }
      if (jumpW > 0.01) {
        q[5]!.slerp(GESTURE.upL, jumpW);
        q[7]!.slerp(GESTURE.upR, jumpW);
        q[6]!.slerp(GESTURE.straightElbow, jumpW);
        q[8]!.slerp(GESTURE.straightElbow, jumpW);
        q[1]!.slerp(GESTURE.tuckHip, jumpW);
        q[3]!.slerp(GESTURE.tuckHip, jumpW);
        q[2]!.slerp(GESTURE.tuckKnee, jumpW);
        q[4]!.slerp(GESTURE.tuckKnee, jumpW);
      }
      if (screenW > 0.01) {
        q[0]!.slerp(GESTURE.ident, screenW * 0.6); // tronco erguido
        q[5]!.slerp(GESTURE.akimboL, screenW);
        q[7]!.slerp(GESTURE.akimboR, screenW);
        q[6]!.slerp(GESTURE.akimboElbowL, screenW);
        q[8]!.slerp(GESTURE.akimboElbowR, screenW);
        q[1]!.slerp(GESTURE.wideHipL, screenW);
        q[3]!.slerp(GESTURE.wideHipR, screenW);
        q[2]!.slerp(GESTURE.bentKnee, screenW);
        q[4]!.slerp(GESTURE.bentKnee, screenW);
        pose.rootY += (-0.05 - pose.rootY) * screenW;
      }
      if (layW > 0.01) {
        q[7]!.slerp(GESTURE.layArm, layW);
        q[8]!.slerp(GESTURE.straightElbow, layW);
        q[5]!.slerp(GESTURE.layOtherArm, layW);
        q[1]!.slerp(GESTURE.layKneeUpHip, layW);
        q[2]!.slerp(GESTURE.layKneeUp, layW);
        q[3]!.slerp(GESTURE.layTrailHip, layW);
        q[4]!.slerp(GESTURE.tuckKnee, layW * 0.5);
      }
      if (dunkW > 0.01) {
        q[5]!.slerp(GESTURE.dunkL, dunkW);
        q[7]!.slerp(GESTURE.dunkR, dunkW);
        q[6]!.slerp(GESTURE.straightElbow, dunkW);
        q[8]!.slerp(GESTURE.straightElbow, dunkW);
        q[1]!.slerp(GESTURE.tuckHip, dunkW);
        q[3]!.slerp(GESTURE.tuckHip, dunkW);
        q[2]!.slerp(GESTURE.tuckKnee, dunkW);
        q[4]!.slerp(GESTURE.tuckKnee, dunkW);
      }

      joints.forEach((j, i) => j.quaternion.copy(pose.q[i]!));
      body.position.y = pose.rootY * scale;

      // Pies al suelo: sin IK, se corrige la altura del cuerpo con el pie más bajo.
      body.updateMatrixWorld(true);
      const footY = Math.min(legL.sole.getWorldPosition(v1).y, legR.sole.getWorldPosition(v2).y) - root.position.y;
      if (shootW < 0.5 || footY < 0) body.position.y -= footY; // en el salto del tiro se respeta el vuelo
      body.position.y += s.lift;

      let diff = s.facing - pivot.rotation.y;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      pivot.rotation.y += diff * Math.min(1, dt * 14);
      ring.scale.setScalar(1 - Math.min(0.4, Math.max(0, body.position.y)));
    },
    applyPose(src, facing, lift = 0) {
      joints.forEach((j, i) => j.quaternion.copy(src.q[i]!));
      body.position.y = src.rootY * scale;
      pivot.rotation.y = facing;
      body.updateMatrixWorld(true);
      const footY = Math.min(legL.sole.getWorldPosition(v1).y, legR.sole.getWorldPosition(v2).y) - root.position.y;
      body.position.y += lift - footY;
      ring.scale.setScalar(1 - Math.min(0.4, Math.max(0, lift)));
    },
    palms(outL, outR) {
      armL.palm.getWorldPosition(outL);
      armR.palm.getWorldPosition(outR);
    },
    setRing(color) {
      (ring.material as THREE.MeshBasicMaterial).color.setHex(color);
    },
    ballAnchor(out) {
      // Bandeja: en la mano derecha. Mate: entre las dos manos, por encima de la cabeza.
      if (action === 'layup') {
        armR.palm.getWorldPosition(out);
        out.y += BALL_VISUAL_R * 0.6;
        return;
      }
      if (action === 'dunk') {
        armL.palm.getWorldPosition(v1);
        armR.palm.getWorldPosition(v2);
        out.addVectors(v1, v2).multiplyScalar(0.5);
        out.y += BALL_VISUAL_R * 0.6;
        return;
      }
      // Preparando el tiro: entre las dos manos, un poco por delante.
      if (shootT !== null && shootT <= CLIPS.shoot.releaseTime + 0.02) {
        armL.palm.getWorldPosition(v1);
        armR.palm.getWorldPosition(v2);
        out.addVectors(v1, v2).multiplyScalar(0.5);
        out.x += Math.sin(pivot.rotation.y) * 0.12 * scale;
        out.z += Math.cos(pivot.rotation.y) * 0.12 * scale;
        return;
      }
      // Botando: bajo la palma derecha, o en el aire según la curva horneada del mocap.
      armR.palm.getWorldPosition(out);
      if (ballY >= 0) out.y = Math.max(BALL_VISUAL_R, ballY * scale);
      else out.y -= BALL_VISUAL_R;
    },
  };
}
