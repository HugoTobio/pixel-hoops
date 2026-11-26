import { createGame, stepGame, SIM_DT, NO_INPUT, hoopX, type PlayerInput, type GameEvent, type GameState } from '../../packages/shared/src/index.ts';
let fails = 0; const ok = (c: boolean, m: string) => { console.log(c ? '  ✓' : '  ✗', m); if (!c) fails++; };
const H = hoopX(1);
function scenario(slot: number, x: number, z: number, vx: number, n = 1) {
  let made = 0, kind = '', charging = false;
  for (let i = 0; i < n; i++) {
    const g = createGame(); const me = g.players[slot]!;
    for (const q of g.players) { if (q !== me) { q.x = -12; q.z = q.id - 3; q.control = 'idle'; } }
    me.control = 'human'; Object.assign(me, { x, z, vx, vz: 0, facing: Math.PI / 2 }); Object.assign(g.ball, { holder: slot }); g.possession = 0;
    let evs: GameEvent[] = [];
    for (let k = 0; k < 150; k++) {
      evs.push(...stepGame(g, (id) => (id === slot ? { mx: vx > 0 ? 1 : 0, mz: 0, shoot: k < 2 } : NO_INPUT), SIM_DT, Math.random));
      if (k === 1) charging = me.charging;
    }
    const f = evs.find((e) => e.type === 'finish') as any; kind = f?.kind ?? (charging ? 'tiro' : 'nada');
    if (evs.some((e) => e.type === 'score')) made++;
  }
  return { kind, pct: Math.round((made / n) * 100) };
}
console.log('1) Qué intenta según posición, altura y velocidad');
let r = scenario(0, H - 1.2, 0.3, 0); ok(r.kind === 'layup', `base (1,85) bajo el aro parado → ${r.kind}`);
r = scenario(2, H - 1.2, 0.3, 0); ok(r.kind === 'dunk', `pívot (2,13) bajo el aro → ${r.kind}`);
r = scenario(1, H - 3, 0.5, 0); ok(r.kind === 'tiro', `alero a 3 m parado → ${r.kind} (tiro en suspensión)`);
r = scenario(1, H - 3, 0.5, 4.5); ok(r.kind === 'dunk', `alero a 3 m lanzado hacia el aro → ${r.kind}`);
r = scenario(0, H - 3, 0.5, 4.5); ok(r.kind === 'layup', `base a 3 m lanzado hacia el aro → ${r.kind}`);
r = scenario(0, H - 5, 0.5, 4.5); ok(r.kind === 'tiro', `base a 5 m lanzado → ${r.kind} (demasiado lejos)`);
console.log('2) Acierto (400 intentos)');
r = scenario(0, H - 1.2, 0.3, 0, 400); ok(r.pct >= 80 && r.pct <= 95, `bandeja: ${r.pct} %`);
r = scenario(2, H - 1.2, 0.3, 0, 400); ok(r.pct >= 90, `mate: ${r.pct} %`);

console.log('3) Bloqueo: obstáculo el doble de ancho durante 1 s');
for (const lateral of [0.9, 1.1, 1.3]) {
  const res: string[] = [];
  for (const screen of [false, true]) {
    const g = createGame(['ai', 'human', 'idle', 'idle', 'human', 'idle']);
    const scr = g.players[0]!, def = g.players[4]!;
    for (const i of [2, 3, 5]) Object.assign(g.players[i]!, { x: -12, z: i });
    Object.assign(g.players[1]!, { x: -10, z: 0 }); g.ball.holder = 1; g.possession = 0;
    // El bloqueador se planta de cara a un defensor que viene de frente (−x); luego el defensor
    // corre en +x desviado `lateral` m: con anchura normal (0,76 m) pasaría rozando.
    Object.assign(scr, { x: 5, z: 0, facing: 0, control: screen ? 'ai' : 'idle',
      play: screen ? { kind: 'screen', phase: 'set', t: 0, defender: 4, carrier: 1, x: 5, z: 0, face: -Math.PI / 2 } : null });
    Object.assign(def, { x: 3.6, z: lateral, vx: 0, vz: 0 });
    let hit = false;
    for (let k = 0; k < 36; k++) { const ev = stepGame(g, (id) => (id === 4 ? { mx: 1, mz: 0, shoot: false } : NO_INPUT), SIM_DT, Math.random); if (ev.some((e) => e.type === 'screened')) hit = true; }
    res.push(`${screen ? 'bloqueando' : 'normal'}: ${hit ? 'CHOCA' : 'pasa'} (avanza ${(def.x - 3.6).toFixed(2)} m)`);
    if (screen) (globalThis as any)['hit' + lateral] = hit;

  }
  console.log(`   defensor a ${lateral} m del centro → ${res.join(' · ')}`);
}
ok((globalThis as any)['hit0.9'] === true, 'a 0,9 m choca con la cápsula ancha (con anchura normal habría pasado: 0,76 m)');
ok((globalThis as any)['hit1.1'] === true, 'a 1,1 m también choca (anchura doble 1,52 m → choca si pasa a < 1,14 m)');
ok((globalThis as any)['hit1.3'] === false, 'a 1,3 m ya pasa');
// (a 1,7 m ya no debería chocar)
console.log(fails ? `\n${fails} FALLOS` : '\nOK: todo correcto');
