import { createGame, stepGame, SIM_DT, NO_INPUT, COURT, type GameEvent } from '../../packages/shared/src/index.ts';
let fails = 0; const ok = (c: boolean, m: string) => { console.log(c ? '  ✓' : '  ✗', m); if (!c) fails++; };
const g = createGame(['ai', 'ai', 'ai', 'ai', 'ai', 'ai']);
const counts: Record<string, number> = {};
let inboundsOk = 0, inboundsBad = 0, maxHold = 0, maxLoose = 0, loose = 0, nan = false;
let lastScore: any = null;
const SECS = 180;
for (let k = 0; k < SECS / SIM_DT; k++) {
  const evs: GameEvent[] = stepGame(g, () => NO_INPUT, SIM_DT, Math.random);
  for (const e of evs) {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    if (e.type === 'score') lastScore = e;
  }
  // ¿Se acaba de preparar un saque? (holder en inbound recién puesto)
  const h = g.ball.holder >= 0 ? g.players[g.ball.holder]! : null;
  if (h?.inbound && h.holdT < SIM_DT * 1.5 && lastScore) {
    const right = h.team === (lastScore.side === 1 ? 1 : 0) && Math.sign(h.x) === lastScore.side && Math.abs(h.x) > COURT.halfL;
    right ? inboundsOk++ : inboundsBad++;
    lastScore = null;
  }
  if (h) maxHold = Math.max(maxHold, h.holdT);
  loose = h || g.pendingInbound ? 0 : loose + SIM_DT; maxLoose = Math.max(maxLoose, loose);
  if ([...g.players.flatMap((p) => [p.x, p.z]), g.ball.x, g.ball.y, g.ball.z].some((v) => !Number.isFinite(v))) nan = true;
}
console.log(`Partido bot vs bot de ${SECS} s → marcador ${g.score[0]}–${g.score[1]}`);
console.log('   eventos:', JSON.stringify(counts));
ok(g.score[0] > 0 && g.score[1] > 0, 'anotan los dos equipos');
ok(inboundsOk > 0 && inboundsBad === 0, `tras cada canasta saca el rival desde ese fondo (${inboundsOk} saques correctos, ${inboundsBad} mal)`);
ok(maxHold < 12, `nadie se queda atascado con el balón (máx. ${maxHold.toFixed(1)} s)`);
ok(maxLoose < 15, `el balón suelto no se queda abandonado (máx. ${maxLoose.toFixed(1)} s)`);
ok(!nan, 'sin valores NaN');
console.log(fails ? `\n${fails} FALLOS` : '\nOK: todo correcto');
