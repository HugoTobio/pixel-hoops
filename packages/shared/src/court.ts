/**
 * Pista FIBA en metros. Origen en el centro de la pista, eje X a lo largo (canastas en ±X),
 * eje Z a lo ancho, Y hacia arriba.
 */
export const COURT = {
  halfL: 14,
  halfW: 7.5,
  rimHeight: 3.05,
  rimRadius: 0.225,
  rimTube: 0.018,
  rimFromBaseline: 1.575,
  boardFromBaseline: 1.2,
  boardHalfWidth: 0.9,
  boardBottom: 2.9,
  boardTop: 3.95,
  boardThickness: 0.05,
  threeRadius: 6.75,
  threeCornerZ: 6.6,
  keyHalfWidth: 2.45,
  keyLength: 5.8,
  ftCircleRadius: 1.8,
  centerCircleRadius: 1.8,
  restrictedRadius: 1.25,
  /** Hasta dónde pueden salir los jugadores fuera de las líneas. */
  playBoundX: 15.2,
  playBoundZ: 8.6,
  /** Paredes invisibles que frenan el balón (gradas). */
  wallX: 16.5,
  wallZ: 10,
} as const;

/** +1 = canasta derecha (x positiva), −1 = canasta izquierda. */
export type Side = 1 | -1;
export const SIDES: readonly Side[] = [1, -1];

export const hoopX = (side: Side) => side * (COURT.halfL - COURT.rimFromBaseline);
export const boardX = (side: Side) => side * (COURT.halfL - COURT.boardFromBaseline);

/** ¿Un tiro desde (x, z) hacia la canasta `side` vale 3? Incluye la regla de las esquinas. */
export function isThree(x: number, z: number, side: Side): boolean {
  const hx = hoopX(side);
  const dx = hx - x;
  const cornerDepth = Math.sqrt(COURT.threeRadius ** 2 - COURT.threeCornerZ ** 2);
  // En la zona de esquina la línea es recta, paralela a la banda.
  if (side * dx < cornerDepth) return Math.abs(z) > COURT.threeCornerZ;
  return Math.hypot(dx, z) > COURT.threeRadius;
}
