import { hoopX, type Side } from './court';
import { attackSide, slotOf, type GameState, type PlayerInput, type PlayerState } from './game';
import { playInput } from './plays';
import { finishKind } from './finish';
import { dist, steer, toward, type P2 } from './steer';

/**
 * IA para jugadores con control 'ai'. Es determinista y vive en la simulación
 * compartida: el servidor la ejecutará igual para los jugadores que no maneje ningún humano.
 *
 * ATAQUE (su equipo tiene la posesión): los que no llevan el balón se adelantan al que bota hacia
 *   la canasta rival para ofrecer línea de pase: uno abierto al ala contraria (fuera del triple) y
 *   otro al poste bajo. Si un pase va hacia él, se para y mira al balón.
 *
 * DEFENSA:
 * - Cada defensor marca al atacante de su mismo puesto (base–base, alero–alero, pívot–pívot).
 * - Hasta que el balón cruza el medio campo, esperan entre su par y su canasta, a ~7,5 m del aro.
 * - Después: el par del que lleva el balón le defiende 1 vs 1, entre él y la canasta.
 *   Los otros dos flotan hacia la línea canasta–balón sin alejarse demasiado de su par.
 */
export const AI = {
  /** Distancia al atacante con balón en el 1 vs 1 (hacia la canasta). */
  onBallGap: 1.25,
  /** Distancia máxima de la ayuda a su par. */
  helpMaxFromMan: 3.2,
  /** Punto de ayuda: fracción del camino canasta → balón. */
  helpPointOnLine: 0.5,
  /** Cuánto se acerca la ayuda desde su par hacia ese punto (0 = pegado a su par, 1 = en el punto). */
  helpPull: 0.55,
  /** Siempre algo por el lado de la canasta respecto a su par. */
  helpHoopSide: 0.8,
  /** Distancia al aro de la posición de espera (antes de medio campo). */
  waitFromHoop: 7.5,
  /** Si su par está más lejos del aro que esto, se le defiende "hundido" a esta distancia. */
  sagFromHoop: 8,
  /** Radio de frenado al llegar al punto objetivo. */
  /** Ataque: cuánto se adelantan al que bota (ala, poste) y su límite respecto al aro. */
  wingAhead: 4.5,
  postAhead: 6.5,
  wingMinFromHoop: 6.4,
  postMinFromHoop: 2.0,
  wingZ: 4.8,
  postZ: 1.9,
  /** Ataque con balón (bot): espera antes de sacar, rango y espacio para tirar, presión para pasar. */
  inboundWait: 0.8,
  shootRange: 7.2,
  shootSpace: 1.8,
  pressured: 1.3,
  passAfter: 1.6,
  forceShotAfter: 7,
  /** Cuántos jugadores de cada equipo van a por un balón suelto. */
  reboundersPerTeam: 2,
} as const;

/** Canasta que defiende un equipo = la que ataca el rival. */
export const defendSide = (team: 0 | 1): Side => (attackSide(team) === 1 ? -1 : 1);

/** Distancia al rival más cercano: cuánto espacio tiene un jugador. */
function openness(g: GameState, q: PlayerState): number {
  let m = Infinity;
  for (const o of g.players) if (o.team !== q.team) m = Math.min(m, dist(o, q));
  return m;
}

/** Orienta hacia `q` y pasa en cuanto está mirándole (choosePassTarget usa la orientación). */
function aimPass(p: PlayerState, q: P2): PlayerInput {
  const want = Math.atan2(q.x - p.x, q.z - p.z);
  const diff = Math.abs(Math.atan2(Math.sin(want - p.facing), Math.cos(want - p.facing)));
  return { mx: 0, mz: 0, shoot: false, pass: diff < 0.3, look: q };
}

/** IA con balón: sacar de fondo, finalizar cerca del aro, tirar con espacio, pasar si le presionan o penetrar. */
function carrierInput(g: GameState, p: PlayerState): PlayerInput {
  const dir = attackSide(p.team);
  const hoop: P2 = { x: hoopX(dir), z: 0 };
  if (p.charging) return { mx: 0, mz: 0, shoot: p.charge < p.aiReleaseAt, look: hoop };
  const mates = g.players.filter((q) => q.team === p.team && q.id !== p.id);
  const mostOpen = mates.reduce((a, q) => (openness(g, q) > openness(g, a) ? q : a), mates[0]!);

  if (p.inbound) {
    if (p.holdT < AI.inboundWait) return { mx: 0, mz: 0, shoot: false, look: mostOpen };
    return aimPass(p, mostOpen);
  }
  if (finishKind(p)) return { mx: 0, mz: 0, shoot: true, look: hoop };
  const d = dist(p, hoop);
  const space = openness(g, p);
  if ((d < AI.shootRange && space > AI.shootSpace && p.holdT > 0.4) || (p.holdT > AI.forceShotAfter && d < 9)) {
    return { mx: 0, mz: 0, shoot: true, look: hoop };
  }
  if (p.holdT > AI.passAfter && space < AI.pressured && openness(g, mostOpen) > AI.shootSpace) return aimPass(p, mostOpen);
  // Penetrar hacia el aro.
  const target = { x: hoop.x - dir * 1.0, z: p.z * 0.3 };
  return steer(p, target, target);
}

/** Ataque sin balón: adelantarse al que bota para ofrecer pase. */
function offenseInput(g: GameState, p: PlayerState, ballPos: P2, carrierId: number): PlayerInput {
  const dir = attackSide(p.team);
  const hx = hoopX(dir);
  // Los dos compañeros sin balón, por puesto: el primero al ala, el segundo al poste.
  // (Sin nadie botando, el humano cuenta como "el del balón" para repartir los roles.)
  const mates = g.players
    .filter((q) => q.team === p.team && q.id !== carrierId && !(carrierId < 0 && q.control === 'human'))
    .sort((a, b) => slotOf(a) - slotOf(b));
  const role = mates.indexOf(p) === 0 ? 'wing' : 'post';
  const away = ballPos.z >= 0 ? -1 : 1; // lado contrario al balón
  let x: number;
  let z: number;
  if (role === 'wing') {
    x = ballPos.x + dir * AI.wingAhead;
    if (x * dir > hx * dir - AI.wingMinFromHoop) x = hx - dir * AI.wingMinFromHoop;
    z = away * AI.wingZ;
  } else {
    x = ballPos.x + dir * AI.postAhead;
    if (x * dir > hx * dir - AI.postMinFromHoop) x = hx - dir * AI.postMinFromHoop;
    z = -away * AI.postZ;
  }
  return steer(p, { x, z }, ballPos);
}

export function aiInput(g: GameState, p: PlayerState): PlayerInput {
  const b = g.ball;
  const carrier = b.holder >= 0 ? g.players[b.holder]! : null;
  const ballPos: P2 = carrier ?? b;

  // Con balón: decide (sacar, finalizar, tirar, pasar o penetrar).
  if (b.holder === p.id) return carrierInput(g, p);

  // Balón suelto (rebote, pase perdido): los dos más cercanos de cada equipo van a por él.
  if (b.holder < 0 && b.passTarget < 0 && !g.pendingInbound) {
    const landing = { x: b.x + b.vx * 0.35, z: b.z + b.vz * 0.35 };
    const closer = g.players.filter((q) => q.team === p.team && q.id !== p.id && dist(q, landing) < dist(p, landing)).length;
    if (closer < AI.reboundersPerTeam) return steer(p, landing, b);
  }

  // Pase en vuelo hacia él: pararse y esperar el balón.
  if (b.passTarget === p.id) return { mx: 0, mz: 0, shoot: false, look: ballPos };
  // Jugada en curso tras pasar (corte o bloqueo).
  const play = playInput(g, p);
  if (play) return play;
  // Su equipo tiene la posesión: atacar sin balón.
  if (g.possession === p.team) return offenseInput(g, p, ballPos, carrier?.id ?? b.passTarget);

  const side = defendSide(p.team);
  const hoop: P2 = { x: hoopX(side), z: 0 };
  const man = g.players.find((q) => q.team !== p.team && slotOf(q) === slotOf(p))!;
  const defenseOn = ballPos.x * side > 0; // el balón ya está en nuestro campo

  let target: P2;
  if (!defenseOn) {
    // Esperar: entre su par y la canasta, sin salir más allá de ~7,5 m del aro.
    target = toward(hoop, man, Math.min(dist(hoop, man), AI.waitFromHoop));
  } else if (carrier && carrier.id === man.id) {
    // 1 vs 1: entre el atacante y la canasta.
    target = toward(carrier, hoop, Math.min(AI.onBallGap, dist(carrier, hoop) * 0.6));
  } else {
    // Ayuda: hacia la línea canasta–balón, por el lado de la canasta, sin perder a su par.
    // Un par muy lejos del aro no es amenaza: se le defiende hundido (sin abandonar la zona).
    const anchor = toward(hoop, man, Math.min(dist(hoop, man), AI.sagFromHoop));
    const helpPoint = toward(hoop, ballPos, dist(hoop, ballPos) * AI.helpPointOnLine);
    let t: P2 = {
      x: anchor.x + (helpPoint.x - anchor.x) * AI.helpPull,
      z: anchor.z + (helpPoint.z - anchor.z) * AI.helpPull,
    };
    t = toward(t, hoop, Math.min(AI.helpHoopSide, dist(t, hoop)));
    if (dist(t, anchor) > AI.helpMaxFromMan) t = toward(anchor, t, AI.helpMaxFromMan);
    target = t;
  }

  return steer(p, target, ballPos);
}
