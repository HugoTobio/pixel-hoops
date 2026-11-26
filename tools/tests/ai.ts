import { createGame, stepGame, SIM_DT, hoopX, AI, NO_INPUT } from '../../packages/shared/src/index.ts';
const g = createGame();
const me = g.players[0]!;
if (process.argv[2] === 'compas') { Object.assign(g.players[1]!, { x: 7, z: -5.5 }); Object.assign(g.players[2]!, { x: 10, z: 5 }); }
const d = (a: any, b: any) => Math.hypot(a.x - b.x, a.z - b.z);
const H = { x: hoopX(1), z: 0 };
let fails = 0;
const check = (cond: boolean, msg: string) => { if (!cond) { fails++; console.log('  ✗', msg); } };
// Recorrido: avanzar hacia la canasta en diagonal, luego hacia la esquina
const path = [[1, 0.15, 2.4], [1, -0.4, 1.0], [0.3, 1, 0.9], [0, 0, 1.0]];
let t = 0;
for (const [mx, mz, secs] of path) {
  for (let k = 0; k < secs / SIM_DT; k++, t += SIM_DT) {
    stepGame(g, (id) => (id === 0 ? { mx, mz, shoot: false } : NO_INPUT), SIM_DT, Math.random);
  }
  const [d0, d1, d2] = [3, 4, 5].map((i) => g.players[i]!);
  console.log(`t=${t.toFixed(1)}s yo=(${me.x.toFixed(1)},${me.z.toFixed(1)}) balón=${g.ball.holder}`);
  for (const p of [d0, d1, d2]) {
    const man = g.players[p.id - 3]!;
    console.log(`   def${p.id - 3}: (${p.x.toFixed(1)},${p.z.toFixed(1)}) a su par ${d(p, man).toFixed(2)} m · al aro ${d(p, H).toFixed(1)} m · par al aro ${d(man, H).toFixed(1)} m`);
  }
  if (me.x <= 0) {
    for (const p of [d0, d1, d2]) check(d(p, H) <= AI.waitFromHoop + 0.3, `antes de medio campo def${p.id - 3} debería esperar a ≤7,5 m del aro`);
  } else {
    check(d(d0, me) < 1.8 && d(d0, H) < d(me, H), 'def0 debería estar encima de mí (1 vs 1) y entre yo y el aro');
    for (const p of [d1, d2]) {
      const man = g.players[p.id - 3]!;
      const dm = d(man, H); const k = Math.min(dm, AI.sagFromHoop) / dm;
      const anchor = { x: H.x + (man.x - H.x) * k, z: H.z + (man.z - H.z) * k };
      check(d(p, anchor) <= AI.helpMaxFromMan + 0.3, `ayuda def${p.id - 3} no debe alejarse >3,2 m de su par (hundido)`);
      check(d(p, H) < d(man, H), `ayuda def${p.id - 3} debe estar por el lado de la canasta`);
    }
  }
}
console.log(fails ? `${fails} fallos` : 'OK: todas las reglas se cumplen');
