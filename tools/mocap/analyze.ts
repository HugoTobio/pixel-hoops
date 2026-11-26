/** Uso: npx tsx tools/mocap/analyze.ts tools/mocap/bvh/06_15.bvh — imprime una línea cada 0,2 s. */
import { sampleBvh } from './sample';

for (const path of process.argv.slice(2)) {
  const s = sampleBvh(path, 30);
  console.log(`\n== ${s.name} (${(s.frames.length / s.fps).toFixed(1)} s)  t | hipsY | vel xz m/s | manoIzqY manoDerY | cabezaY`);
  for (let i = 0; i < s.frames.length; i += 6) {
    const f = s.frames[i]!;
    const p = s.frames[Math.max(0, i - 3)]!;
    const q = s.frames[Math.min(s.frames.length - 1, i + 3)]!;
    const dt = (Math.min(s.frames.length - 1, i + 3) - Math.max(0, i - 3)) / s.fps;
    const v = Math.hypot(q.Hips.x - p.Hips.x, q.Hips.z - p.Hips.z) / dt;
    console.log(
      `${(i / s.fps).toFixed(1).padStart(4)} | ${f.Hips.y.toFixed(2)} | ${v.toFixed(2)} | ${f.LeftHand.y.toFixed(2)} ${f.RightHand.y.toFixed(2)} | ${f.Head.y.toFixed(2)}`,
    );
  }
}
