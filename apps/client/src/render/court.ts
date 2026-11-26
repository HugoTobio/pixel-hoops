import * as THREE from 'three';
import { boardX, COURT, hoopX, type Side } from '@brawl/shared';
import { TEAMS } from '../content/teams';
import { outlineMaterial, toonInstancedMaterial, toonMaterial } from './toon';

/** Píxeles de textura por metro: 1 línea = 1 píxel, como un sprite. */
const PX = 16;
const AREA_HALF_X = 16;
const AREA_HALF_Z = 9.5;

function drawCourtTexture(): THREE.CanvasTexture {
  const w = AREA_HALF_X * 2 * PX;
  const h = AREA_HALF_Z * 2 * PX;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const U = (x: number) => Math.round((x + AREA_HALF_X) * PX);
  const V = (z: number) => Math.round((z + AREA_HALF_Z) * PX);
  const rect = (x0: number, z0: number, x1: number, z1: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(U(Math.min(x0, x1)), V(Math.min(z0, z1)), U(Math.max(x0, x1)) - U(Math.min(x0, x1)), V(Math.max(z0, z1)) - V(Math.min(z0, z1)));
  };
  const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

  // Exterior
  ctx.fillStyle = '#2c3a56';
  ctx.fillRect(0, 0, w, h);

  // Parqué: tablas a lo largo con variación de tono.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const plankH = PX / 2;
  for (let v = V(-COURT.halfW); v < V(COURT.halfW); v += plankH) {
    let u = U(-COURT.halfL);
    while (u < U(COURT.halfL)) {
      const len = Math.round(PX * (2 + rnd() * 3));
      const tone = 0.93 + rnd() * 0.1;
      ctx.fillStyle = `rgb(${Math.round(222 * tone)},${Math.round(165 * tone)},${Math.round(96 * tone)})`;
      ctx.fillRect(u, v, Math.min(len, U(COURT.halfL) - u), plankH);
      ctx.fillStyle = 'rgba(120,70,30,0.35)';
      ctx.fillRect(u, v, 1, plankH);
      u += len;
    }
  }

  // Zonas pintadas (cada equipo defiende su lado: local a la izquierda).
  for (const side of [1, -1] as Side[]) {
    const color = hex(side === 1 ? TEAMS.away.court : TEAMS.home.court);
    const base = side * COURT.halfL;
    rect(base, -COURT.keyHalfWidth, base - side * COURT.keyLength, COURT.keyHalfWidth, color);
  }
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = '#f2c94c';
  ctx.beginPath();
  ctx.arc(U(0), V(0), COURT.centerCircleRadius * PX, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Líneas: dibujadas píxel a píxel para que no haya antialias.
  ctx.fillStyle = '#f7f3ea';
  const dot = (x: number, z: number) => ctx.fillRect(U(x), V(z), 1, 1);
  const hLine = (x0: number, x1: number, z: number) => ctx.fillRect(U(Math.min(x0, x1)), V(z), Math.abs(U(x1) - U(x0)) + 1, 1);
  const vLine = (x: number, z0: number, z1: number) => ctx.fillRect(U(x), V(Math.min(z0, z1)), 1, Math.abs(V(z1) - V(z0)) + 1);
  const arc = (cx: number, cz: number, r: number, keep: (x: number, z: number) => boolean = () => true) => {
    const steps = Math.ceil(r * PX * 8);
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      if (keep(x, z)) dot(x, z);
    }
  };

  hLine(-COURT.halfL, COURT.halfL, -COURT.halfW);
  hLine(-COURT.halfL, COURT.halfL, COURT.halfW);
  vLine(-COURT.halfL, -COURT.halfW, COURT.halfW);
  vLine(COURT.halfL, -COURT.halfW, COURT.halfW);
  vLine(0, -COURT.halfW, COURT.halfW);
  arc(0, 0, COURT.centerCircleRadius);

  const cornerDepth = Math.sqrt(COURT.threeRadius ** 2 - COURT.threeCornerZ ** 2);
  for (const side of [1, -1] as Side[]) {
    const hx = hoopX(side);
    const base = side * COURT.halfL;
    const ftX = base - side * COURT.keyLength;
    // Zona
    hLine(base, ftX, -COURT.keyHalfWidth);
    hLine(base, ftX, COURT.keyHalfWidth);
    vLine(ftX, -COURT.keyHalfWidth, COURT.keyHalfWidth);
    arc(ftX, 0, COURT.ftCircleRadius);
    // Triple: rectas en las esquinas + arco
    hLine(base, hx - side * cornerDepth, -COURT.threeCornerZ);
    hLine(base, hx - side * cornerDepth, COURT.threeCornerZ);
    arc(hx, 0, COURT.threeRadius, (x, z) => Math.abs(z) <= COURT.threeCornerZ && side * (hx - x) >= cornerDepth - 0.01);
    // Semicírculo de no carga
    arc(hx, 0, COURT.restrictedRadius, (x) => side * (hx - x) >= 0);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function addBox(parent: THREE.Object3D, size: [number, number, number], pos: [number, number, number], color: number, outline = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), toonMaterial(color));
  mesh.position.set(...pos);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  if (outline) mesh.add(new THREE.Mesh(new THREE.BoxGeometry(size[0] + outline, size[1] + outline, size[2] + outline), outlineMaterial));
  parent.add(mesh);
  return mesh;
}

function buildHoop(side: Side): THREE.Group {
  const g = new THREE.Group();
  const hx = hoopX(side);
  const bx = boardX(side);
  const boardH = COURT.boardTop - COURT.boardBottom;
  const boardCenterX = bx + side * (COURT.boardThickness / 2);
  const padColor = side === 1 ? TEAMS.away.court : TEAMS.home.court;

  // Soporte detrás de la línea de fondo
  const poleX = side * (COURT.halfL + 1.1);
  addBox(g, [0.5, 1.2, 1.1], [poleX, 0.6, 0], padColor, 0.06);
  addBox(g, [0.22, 3.6, 0.22], [poleX, 2.4, 0], 0x3a3a46, 0.05);
  const armLen = Math.abs(poleX - boardCenterX);
  addBox(g, [armLen, 0.16, 0.16], [(poleX + boardCenterX) / 2, COURT.boardTop - 0.15, 0], 0x3a3a46, 0.05);

  // Tablero con recuadro
  addBox(g, [COURT.boardThickness, boardH, COURT.boardHalfWidth * 2], [boardCenterX, COURT.boardBottom + boardH / 2, 0], 0xf7f3ea, 0.05);
  const face = bx - side * 0.004;
  addBox(g, [0.01, 0.45, 0.59], [face, COURT.rimHeight + 0.15 + 0.225, 0], 0xd94a3a);
  addBox(g, [0.012, 0.37, 0.51], [face - side * 0.002, COURT.rimHeight + 0.15 + 0.225, 0], 0xf7f3ea);

  // Aro
  const rim = new THREE.Mesh(new THREE.TorusGeometry(COURT.rimRadius, 0.025, 4, 16), toonMaterial(0xf26a1b));
  rim.rotation.x = Math.PI / 2;
  rim.position.set(hx, COURT.rimHeight, 0);
  rim.castShadow = true;
  g.add(rim);
  addBox(g, [Math.abs(hx - bx) - COURT.rimRadius + 0.02, 0.04, 0.12], [(hx + side * COURT.rimRadius + bx) / 2, COURT.rimHeight, 0], 0xf26a1b);

  // Red
  const net = new THREE.Mesh(
    new THREE.CylinderGeometry(COURT.rimRadius, COURT.rimRadius * 0.62, 0.42, 10, 3, true),
    new THREE.MeshBasicMaterial({ color: 0xf7f3ea, wireframe: true, transparent: true, opacity: 0.85 }),
  );
  net.position.set(hx, COURT.rimHeight - 0.21, 0);
  net.name = 'net';
  g.add(net);
  return g;
}

/** Gradas al fondo de la pista con público (cubos de colores). */
function buildStands(): THREE.Group {
  const g = new THREE.Group();
  const rows = 4;
  const zStart = -(COURT.halfW + 2.2);
  for (let r = 0; r < rows; r++) {
    addBox(g, [34, 0.5, 1], [0, 0.25 + r * 0.5, zStart - r], r % 2 ? 0x3a4660 : 0x334058);
  }
  const perRow = 52;
  const count = rows * perRow;
  const crowd = new THREE.InstancedMesh(new THREE.BoxGeometry(0.38, 0.6, 0.3), toonInstancedMaterial(), count);
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  const shirts = [0x2f6fe0, 0xe0503f, 0xf2c94c, 0xf7f3ea, 0x5aa04a, 0x8e5bd6, 0x2b2b38];
  let i = 0;
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < perRow; k++) {
      const x = -16.5 + (k + (r % 2) * 0.5) * (33 / perRow);
      m.makeTranslation(x, 0.5 + r * 0.5 + 0.3, zStart - r);
      crowd.setMatrixAt(i, m);
      crowd.setColorAt(i, c.setHex(shirts[(k * 7 + r * 3) % shirts.length]!));
      i++;
    }
  }
  crowd.name = 'crowd';
  g.add(crowd);
  return g;
}

export function buildCourt(): { group: THREE.Group; crowd: THREE.InstancedMesh; nets: THREE.Mesh[] } {
  const group = new THREE.Group();
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(AREA_HALF_X * 2, AREA_HALF_Z * 2),
    new THREE.MeshLambertMaterial({ map: drawCourtTexture() }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  group.add(floor);

  const outer = new THREE.Mesh(new THREE.PlaneGeometry(120, 80), new THREE.MeshBasicMaterial({ color: 0x1b2433 }));
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = -0.01;
  group.add(outer);

  const hoops = [buildHoop(1), buildHoop(-1)];
  const stands = buildStands();
  group.add(...hoops, stands);
  return {
    group,
    crowd: stands.getObjectByName('crowd') as THREE.InstancedMesh,
    nets: hoops.map((h) => h.getObjectByName('net') as THREE.Mesh),
  };
}
