import { createGame, stepGame, SHOT, SIM_DT, hoopX, type PlayerInput } from '../../packages/shared/src/index.ts';
function pct(x: number, z: number, meter: number, n = 400) {
  let made = 0, three = 0;
  for (let i = 0; i < n; i++) {
    const g = createGame();
    const p = g.players[0]!;
    // mover el resto lejos
    g.players.forEach((q, k) => { if (k) { q.x = -10; q.z = 8; } });
    p.x = x; p.z = z; g.ball.holder = 0;
    const holdTicks = Math.round((meter * SHOT.meterTime) / SIM_DT);
    let tick = 0, scored = false;
    const inp = (): PlayerInput => ({ mx: 0, mz: 0, shoot: tick < holdTicks });
    for (; tick < 60 * 5; tick++) {
      for (const e of stepGame(g, (id) => (id === 0 ? inp() : { mx: 0, mz: 0, shoot: false }), SIM_DT, Math.random))
        if (e.type === 'score') { scored = true; if (e.points === 3) three++; }
      if (scored) break;
    }
    if (scored) made++;
  }
  return `${Math.round((made / n) * 100)}%${three ? ' (triples ' + three + ')' : ''}`;
}
const hx = hoopX(1);
const spots: [string, number, number][] = [['bandeja 1m', hx - 1, 0.3], ['media 4m', hx - 4, 1], ['tiro libre', hx - 4.225, 0], ['triple frontal 7m', hx - 7.2, 0], ['triple esquina', hx - 0.5, 6.9]];
const meters: [string, number][] = [['perfecto', 0.88], ['bien(+0.1)', 0.98], ['pronto(-0.2)', 0.68], ['tarde(+0.25)', 1.13]];
for (const [name, x, z] of spots) console.log(name.padEnd(18), meters.map(([m, v]) => `${m}: ${pct(x, z, v)}`).join(' | '));
