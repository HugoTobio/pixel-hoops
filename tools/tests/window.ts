import { createGame, stepGame, SIM_DT, NO_INPUT, SHOT, hoopX, perfectWindowFor, type GameEvent } from '../../packages/shared/src/index.ts';
let fails = 0; const ok = (c: boolean, m: string) => { console.log(c ? '  ✓' : '  ✗', m); if (!c) fails++; };
console.log('Zona verde (±) según distancia al defensor:', [0.8, 1.4, 2, 2.7, 3.4, 4, 6].map((d) => `${d} m→${perfectWindowFor(d).toFixed(3)}`).join('  '));
function trial(defDist: number, meterErr: number, n = 300) {
  let made = 0; const q: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const g = createGame(['human', 'idle', 'idle', 'idle', 'idle', 'idle']);
    const me = g.players[0]!;
    g.players.forEach((p, k) => { if (k) Object.assign(p, { x: -12, z: k - 3 }); });
    Object.assign(me, { x: hoopX(1) - 6, z: 0 }); g.ball.holder = 0;
    // defensor entre yo y la canasta, a defDist
    Object.assign(g.players[3]!, { x: me.x + defDist, z: 0.3 });
    const hold = Math.round(((SHOT.sweet + meterErr) * SHOT.meterTime) / SIM_DT);
    let window = 0;
    for (let k = 0; k < 300; k++) {
      const ev: GameEvent[] = stepGame(g, (id) => (id === 0 ? { mx: 0, mz: 0, shoot: k < hold } : NO_INPUT), SIM_DT, Math.random);
      if (k === 2) window = me.shotWindow;
      for (const e of ev) { if (e.type === 'shot') q[e.quality] = (q[e.quality] ?? 0) + 1; if (e.type === 'score') made++; }
    }
    (globalThis as any).w = window;
  }
  return { pct: Math.round((made / n) * 100), q, w: (globalThis as any).w };
}
const guarded = trial(1.0, 0.12), open = trial(5, 0.12), guardedPerfect = trial(1.0, 0.0), openPerfect = trial(5, 0.0);
console.log(`Soltando 0,12 tarde → defensor a 1 m: zona ±${guarded.w.toFixed(2)} ${JSON.stringify(guarded.q)} acierto ${guarded.pct} %`);
console.log(`Soltando 0,12 tarde → solo (5 m):    zona ±${open.w.toFixed(2)} ${JSON.stringify(open.q)} acierto ${open.pct} %`);
console.log(`Soltando en el punto → defensor a 1 m: ${guardedPerfect.pct} % · solo: ${openPerfect.pct} %`);
ok(Math.abs(guarded.w - SHOT.perfectWindow) < 1e-9, 'con el defensor encima la zona verde es la de siempre');
ok(open.w > 0.15, 'solo, la zona verde es ~3 veces mayor');
ok((guarded.q.perfect ?? 0) === 0 && (open.q.perfect ?? 0) === 300, 'el mismo timing es "perfecto" solo cuando estás libre');
ok(open.pct > guarded.pct + 25, 'y entra bastante más');
console.log(fails ? `\n${fails} FALLOS` : '\nOK: todo correcto');
