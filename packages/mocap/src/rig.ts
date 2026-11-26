/**
 * El rig de referencia: 9 articulaciones (SLOTS de pose.ts) y sus medidas para una persona de 2,00 m.
 * Las animaciones se hornean contra estas medidas, así que cualquier personaje que las use (el maniquí
 * del estudio, los jugadores del juego) debe tener los huesos en estas posiciones; después se escala
 * entero a su altura real.
 *
 * Ejes: el personaje mira a +Z, Y arriba, izquierda anatómica = +X. Cada hueso en reposo apunta a −Y.
 *
 *   root (suelo)
 *   └─ pivot (rumbo)
 *      ├─ hipL / hipR  (cadera)  → kneeL / kneeR (rodilla) → suela
 *      └─ upper (tronco, en la cadera)
 *         └─ shL / shR (hombro) → elL / elR (codo) → palma
 */
export const RIG = {
  /** Altura de referencia del rig (m). */
  height: 2.0,
  /** Altura de la cadera sobre el suelo, de pie. */
  hipY: 1.02,
  /** Separación de cada cadera respecto al centro (×complexión). */
  hipX: 0.1,
  /** Cadera → rodilla. */
  thigh: 0.46,
  /** Rodilla → suela del pie. */
  shin: 0.545,
  /** Altura de los hombros sobre la cadera. */
  shoulderY: 0.61,
  /** Separación de cada hombro respecto al centro (×complexión en el juego: 0,3·b + 0,03). */
  shoulderX: 0.33,
  /** Hombro → codo. */
  upperArm: 0.32,
  /** Codo → palma. */
  foreArm: 0.36,
  /** Centro de la cabeza sobre la cadera. */
  headY: 0.87,
} as const;
