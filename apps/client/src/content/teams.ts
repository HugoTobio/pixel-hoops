/**
 * Equipaciones por paleta: el mismo modelo con colores distintos.
 * Más adelante vendrán de la base de datos (Neon) según lo desbloqueado por cada jugador.
 */
export interface PlayerPalette {
  jersey: number;
  trim: number; // ribetes, dorsal y pantalón
  shorts: number;
  skin: number;
  hair: number;
  shoes: number;
}

export interface PlayerLook {
  palette: PlayerPalette;
  number: number;
  /** Multiplicador de anchura (1 = complexión media). */
  build: number;
}

export const SKIN_TONES = [0xf1c7a0, 0xd9a27c, 0xb98463, 0x8a5a3c, 0x6b4430];
export const HAIR_COLORS = [0x2b2118, 0x5a3a22, 0xe0b84c, 0x1d1a2b, 0xb04a2a];

export const TEAMS = {
  home: { name: 'LOCAL', jersey: 0x2f6fe0, trim: 0xf2c94c, shorts: 0x2f6fe0, shoes: 0xf4efe1, court: 0x2f6fe0 },
  away: { name: 'VISITANTE', jersey: 0xe0503f, trim: 0xf7f3ea, shorts: 0xe0503f, shoes: 0x2b2b38, court: 0xe0503f },
} as const;

/** Por posición en el equipo: base, alero, pívot. La altura vive en la simulación compartida. */
const ROSTER = [
  { number: 7, build: 0.94 },
  { number: 23, build: 1.0 },
  { number: 34, build: 1.12 },
];

export function lookFor(team: 'home' | 'away', index: number): PlayerLook {
  const t = TEAMS[team];
  const r = ROSTER[index % ROSTER.length]!;
  return {
    number: team === 'home' ? r.number : r.number + 3,
    build: r.build,
    palette: {
      jersey: t.jersey,
      trim: t.trim,
      shorts: t.shorts,
      shoes: t.shoes,
      skin: SKIN_TONES[(index * 2 + (team === 'away' ? 1 : 0)) % SKIN_TONES.length]!,
      hair: HAIR_COLORS[(index * 3 + (team === 'away' ? 2 : 0)) % HAIR_COLORS.length]!,
    },
  };
}

export const RING = {
  self: 0x5ee3ff,
  home: 0x2f6fe0,
  away: 0xe0503f,
} as const;
