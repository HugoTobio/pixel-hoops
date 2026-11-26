import { createGame, stepGame, SIM_DT, NO_INPUT, hoopX, type PlayerInput, type GameEvent, type GameState } from '../../packages/shared/src/index.ts';
let fails = 0; const ok = (c: boolean, m: string) => { console.log(c ? '  ✓' : '  ✗', m); if (!c) fails++; };
const d = (a: any, b: any) => Math.hypot(a.x - b.x, a.z - b.z);
const human = (g: GameState) => g.players.find((p) => p.control === 'human' && p.team === 0)!.id;
function run(g: GameState, secs: number, input: (id: number, k: number) => PlayerInput, rng = Math.random, each?: (k: number) => void) {
  const evs: GameEvent[] = [];
  for (let k = 0; k < secs / SIM_DT; k++) { evs.push(...stepGame(g, (id) => input(id, k), SIM_DT, rng)); each?.(k); }
  return evs;
}
/** Partida en la que yo (base) estoy en campo rival y paso al ala, forzando la jugada con el rng. */
function setup(forceCut: boolean) {
  const g = createGame();
  run(g, 2.6, (id) => (id === human(g) ? { mx: 0.6, mz: 0, shoot: false } : NO_INPUT));
  const me = g.players[0]!, wing = g.players[1]!;
  me.facing = Math.atan2(wing.x - me.x, wing.z - me.z);
  const rng = () => (forceCut ? 0.1 : 0.9);
  const evs = run(g, 0.05, (id, k) => (id === 0 && k === 0 ? { mx: 0, mz: 0, shoot: false, pass: true } : NO_INPUT), rng);
  return { g, evs, rng };
}
const H = { x: hoopX(1), z: 0 };

console.log('1) Corte: va al aro con el brazo en alto, salta y sale a la línea de 3');
{ const { g, evs, rng } = setup(true); const base = g.players[0]!;
  ok((evs.find((e) => e.type === 'play') as any)?.kind === 'cut', 'el pasador inicia un corte');
  const d0 = d(base, H);
  let jumped = false, minRim = 99, endDist = -1, wasOut = false;
  run(g, 6, () => NO_INPUT, rng, () => {
    minRim = Math.min(minRim, d(base, H));
    if (base.play?.kind === 'cut' && base.play.phase === 'jump') jumped = true;
    if (base.play?.kind === 'cut' && base.play.phase === 'out') wasOut = true;
    else if (wasOut && endDist < 0) endDist = d(base, H);
  });
  ok(minRim < 1.6, `llega bajo el aro (mín. ${minRim.toFixed(2)} m; partía a ${d0.toFixed(1)} m)`);
  ok(jumped, 'salta con los brazos arriba');
  ok(endDist > 6.3 && endDist < 7.7, `sale a la línea de 3 (termina a ${endDist.toFixed(2)} m del aro)`); }

console.log('2) Corte + volver a pulsar pase → el balón vuelve al cortador y lo controlo');
{ const { g, rng } = setup(true);
  run(g, 0.9, () => NO_INPUT, rng); // el ala recibe; el base corta
  const now = human(g); ok(now === 1, `controlo al ala tras recibir (id ${now})`);
  const evs = run(g, 1.5, (id, k) => (id === 1 && k === 0 ? { mx: 0, mz: 0, shoot: false, pass: true } : NO_INPUT), rng);
  const pass = evs.find((e) => e.type === 'pass') as any;
  ok(pass?.to === 0, `el pase va al cortador aunque no le mire (to=${pass?.to})`);
  ok(g.ball.holder === 0 && human(g) === 0, 'el cortador lo recibe y vuelvo a controlarle'); }

console.log('3) Bloqueo: va al defensor del nuevo poseedor y se planta');
{ const { g, evs, rng } = setup(false); const base = g.players[0]!;
  ok((evs.find((e) => e.type === 'play') as any)?.kind === 'screen', 'el pasador inicia un bloqueo');
  let set = false; let gap = 0;
  run(g, 2.5, () => NO_INPUT, rng, () => { if (base.play?.kind === 'screen' && base.play.phase === 'set' && !set) { set = true; gap = d(base, g.players[4]!); } });
  ok(set && gap < 1.2, `se planta junto al defensor del ala (a ${gap.toFixed(2)} m)`); }

console.log('4) El bloqueo frena al defensor (mismo recorrido con y sin bloqueador)');
for (const withScreen of [false, true]) {
  const g = createGame(['ai', 'human', 'ai', 'ai', 'ai', 'ai']);
  const carrier = g.players[1]!, defender = g.players[4]!, screener = g.players[0]!;
  Object.assign(g.ball, { holder: 1 }); g.possession = 0;
  Object.assign(carrier, { x: 6, z: -4 }); Object.assign(defender, { x: 7.2, z: -3.6 });
  Object.assign(g.players[2]!, { x: -10, z: 6, control: 'idle' }); Object.assign(g.players[3]!, { x: -10, z: -6, control: 'idle' }); Object.assign(g.players[5]!, { x: -12, z: 6, control: 'idle' });
  if (withScreen) { Object.assign(screener, { x: 7.0, z: -2.8, control: 'ai', play: { kind: 'screen', phase: 'set', t: 0, defender: 4, carrier: 1, x: 7.0, z: -2.8, face: Math.atan2(0.2, -0.8) } }); }
  else Object.assign(screener, { x: -12, z: -6, control: 'idle' });
  let sep = 0;
  // Rodea el bloqueo pegado a su hombro (lado contrario al defensor) y después ataca el aro.
  run(g, 1.6, (id, k) => (id === 1 ? (k < 33 ? { mx: 0.05, mz: 1, shoot: false } : { mx: 1, mz: 0.25, shoot: false }) : NO_INPUT), Math.random, () => { sep = Math.max(sep, d(carrier, defender)); });
  console.log(`   ${withScreen ? 'con bloqueo' : 'sin bloqueo'}: ventaja máx. atacante–defensor ${sep.toFixed(2)} m · bloqueador se movió ${withScreen ? d(screener, { x: 7.0, z: -2.8 }).toFixed(2) : '-'} m`);
  (globalThis as any)['sep' + withScreen] = sep;
}
ok((globalThis as any).septrue > (globalThis as any).sepfalse + 0.8, 'con bloqueo el atacante se escapa claramente más');
console.log(fails ? `\n${fails} FALLOS` : '\nOK: todo correcto');
