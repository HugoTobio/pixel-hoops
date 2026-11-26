import type { GameEvent, GameState, PlayerInput, Team } from './game';

/** Mensajes cliente → servidor. */
export type ClientMsg =
  | { t: 'create' }
  | { t: 'join'; code: string }
  /** Estado de los controles; `pass` es una pulsación (el servidor la retiene hasta usarla). */
  | { t: 'input'; input: PlayerInput };

/** Mensajes servidor → cliente. */
export type ServerMsg =
  | { t: 'created'; code: string; team: Team }
  | { t: 'joined'; code: string; team: Team }
  | { t: 'error'; message: string }
  | { t: 'opponent_joined' }
  /** Cuenta atrás en segundos antes de empezar. */
  | { t: 'countdown'; seconds: number }
  | { t: 'start' }
  /** Estado completo de la partida + eventos ocurridos desde el anterior. */
  | { t: 'state'; s: GameState; ev: GameEvent[] }
  | { t: 'opponent_left' };

export const NET = {
  port: 2567,
  /** Estados por segundo que envía el servidor. */
  snapshotHz: 30,
  countdownSeconds: 5,
} as const;

/** Código de partida: 4 letras fáciles de dictar (sin I, O ni similares). */
export function makeRoomCode(rng: () => number = Math.random): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  return Array.from({ length: 4 }, () => A[Math.floor(rng() * A.length)]).join('');
}
