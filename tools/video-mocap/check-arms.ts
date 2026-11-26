/**
 * Diagnóstico de los brazos del rig en una captura: cuántas veces "salta" hacia dónde apunta el codo
 * (lo que se ve como un codo que se va para donde no debe). Con el brazo casi recto el giro apenas se nota,
 * así que esos saltos se cuentan aparte de los visibles.
 *
 *   npx tsx tools/video-mocap/check-arms.ts [nombre-de-la-captura]   (por defecto: pivot)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { bakeCapture, type Capture } from '../../packages/mocap/src/index';

const name = process.argv[2] ?? 'pivot';
const cap = JSON.parse(readFileSync(fileURLToPath(new URL(`./data/${name}/capture.json`, import.meta.url)), 'utf8')) as Capture;
const b = bakeCapture(cap, true);
const q = (fr: number[], s: number) => new THREE.Quaternion(fr[1 + s * 4], fr[2 + s * 4], fr[3 + s * 4], fr[4 + s * 4]);
for (const [side, sh, el] of [['izquierdo', 5, 6], ['derecho', 7, 8]] as const) {
  let prev: THREE.Vector3 | null = null;
  let big = 0;
  let visible = 0;
  let flips = 0;
  let maxJump = 0;
  const where: string[] = [];
  b.clip.frames.forEach((fr, i) => {
    // El codo apunta al lado contrario de hacia donde se dobla el antebrazo (−Z del brazo).
    const elbow = new THREE.Vector3(0, 0, -1).applyQuaternion(q(fr, 0).multiply(q(fr, sh)));
    const flex = (2 * Math.acos(Math.min(1, Math.abs(q(fr, el).w))) * 180) / Math.PI;
    if (prev) {
      const a = (prev.angleTo(elbow) * 180) / Math.PI;
      maxJump = Math.max(maxJump, a);
      if (a > 30) {
        big++;
        // Con el brazo casi recto el giro apenas se ve (el brazo es un cilindro): se cuenta aparte.
        if (flex > 25) visible++;
        if (where.length < 10) where.push(`${b.f0 + i + 1}: ${a.toFixed(0)}° (codo doblado ${flex.toFixed(0)}°)`);
      }
      if (a > 90) flips++;
    }
    prev = elbow;
  });
  console.log(`Brazo ${side}: saltos del codo > 30°/fotograma: ${big} (visibles, con el codo doblado > 25°: ${visible}) · > 90°: ${flips} · máximo ${maxJump.toFixed(0)}°`);
  if (where.length) console.log(`   p. ej. fotograma ${where.join(' · ')}`);
}
