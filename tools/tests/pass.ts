import { createGame, stepGame, SIM_DT, NO_INPUT, type PlayerInput, type GameEvent } from '../../packages/shared/src/index.ts';
let fails = 0; const ok = (c: boolean, m: string) => { console.log(c ? '  ✓' : '  ✗', m); if (!c) fails++; };
const run = (g: any, secs: number, input: (id: number, tick: number) => PlayerInput) => {
  const evs: GameEvent[] = [];
  for (let k = 0; k < secs / SIM_DT; k++) evs.push(...stepGame(g, (id) => input(id, k), SIM_DT, Math.random));
  return evs;
};
const humanId = (g: any) => g.players.find((p: any) => p.control === 'human' && p.team === 0).id;

console.log('1) Compañeros se adelantan al que bota');
{ const g = createGame(); run(g, 2.5, (id) => id === humanId(g) ? { mx: 0.6, mz: 0, shoot: false } : NO_INPUT);
  const me = g.players[0]!; const [w, p] = [g.players[1]!, g.players[2]!];
  console.log(`   yo x=${me.x.toFixed(1)} · ala (${w.x.toFixed(1)},${w.z.toFixed(1)}) · poste (${p.x.toFixed(1)},${p.z.toFixed(1)})`);
  ok(w.x > me.x + 2 && p.x > me.x + 2, 'ambos por delante (hacia la canasta rival)'); }

console.log('2) Pase al compañero al que miro + cambio de control');
{ const g = createGame(); run(g, 2.5, (id) => id === humanId(g) ? { mx: 0.6, mz: 0, shoot: false } : NO_INPUT);
  // mirar hacia el ala (id 1)
  const me = g.players[0]!, wing = g.players[1]!;
  me.facing = Math.atan2(wing.x - me.x, wing.z - me.z);
  const evs = run(g, 1.5, (id, k) => id === 0 && k === 0 ? { mx: 0, mz: 0, shoot: false, pass: true } : NO_INPUT);
  const pass = evs.find((e) => e.type === 'pass') as any; const c = evs.find((e) => e.type === 'catch') as any;
  ok(pass?.to === 1, `pase dirigido al ala (to=${pass?.to})`);
  ok(c?.playerId === 1 && g.ball.holder === 1, 'el ala lo atrapa');
  ok(g.players[1]!.control === 'human' && g.players[0]!.control === 'ai', 'ahora controlo al ala; el base pasa a la IA'); }

console.log('3) Mirando al poste elige al poste');
{ const g = createGame(); run(g, 2.5, (id) => id === humanId(g) ? { mx: 0.6, mz: 0, shoot: false } : NO_INPUT);
  const me = g.players[0]!, post = g.players[2]!;
  me.facing = Math.atan2(post.x - me.x, post.z - me.z);
  const evs = run(g, 0.1, (id, k) => id === 0 && k === 0 ? { mx: 0, mz: 0, shoot: false, pass: true } : NO_INPUT);
  ok((evs.find((e) => e.type === 'pass') as any)?.to === 2, 'pase al poste'); }

console.log('4) Rival humano corta el pase si está cerca de la línea');
for (const [label, offset, expect] of [['cerca (0,6 m de la línea)', 0.6, true], ['lejos (3 m)', 3, false]] as const) {
  const g = createGame(['human', 'ai', 'ai', 'human', 'ai', 'ai']);
  const me = g.players[0]!, mate = g.players[1]!, thief = g.players[3]!;
  Object.assign(me, { x: 0, z: 0, facing: Math.PI / 2 }); Object.assign(mate, { x: 8, z: 0, control: 'idle' });
  Object.assign(thief, { x: 4, z: offset });
  Object.assign(g.ball, { holder: 0, x: 0.2, z: 0 });
  const evs = run(g, 1.2, (id, k) => id === 0 && k === 0 ? { mx: 0, mz: 0, shoot: false, pass: true } : id === 3 && k === 10 ? { mx: 0, mz: 0, shoot: false, pass: true } : NO_INPUT);
  const cut = evs.find((e) => e.type === 'intercept') as any;
  ok(expect ? cut?.playerId === 3 && g.ball.holder === 3 && g.possession === 1 : !cut && g.ball.holder === 1, `${label}: ${expect ? 'intercepta' : 'no intercepta'}`);
}

console.log('5) Sin pulsar el botón, el rival no corta aunque esté en la línea');
{ const g = createGame(['human', 'ai', 'ai', 'human', 'ai', 'ai']);
  const me = g.players[0]!, mate = g.players[1]!, thief = g.players[3]!;
  Object.assign(me, { x: 0, z: 0, facing: Math.PI / 2 }); Object.assign(mate, { x: 8, z: 0, control: 'idle' }); Object.assign(thief, { x: 4, z: 0.5, control: 'idle' });
  Object.assign(g.ball, { holder: 0, x: 0.2, z: 0 });
  const evs = run(g, 1.2, (id, k) => id === 0 && k === 0 ? { mx: 0, mz: 0, shoot: false, pass: true } : NO_INPUT);
  ok(!evs.some((e) => e.type === 'intercept') && g.ball.holder === 1, 'llega al compañero'); }
console.log(fails ? `\n${fails} FALLOS` : '\nOK: todo correcto');
