/**
 * Detecta el balón de baloncesto en un fotograma: manchas de color naranja, redondas y del tamaño que
 * debería tener un balón según la escala del jugador.
 *
 * Lo que más confunde: la piel (cara, brazos) y unas zapatillas naranjas. Por eso:
 *  - se valora la saturación (el balón es un naranja más "puro" que la piel);
 *  - junto a la cabeza solo vale si también hay una mano al lado (balón por encima de la cabeza, tiro);
 *  - junto a los pies solo vale si es continuación de donde iba el balón (bote);
 *  - no se aceptan teletransportes: lejos del balón anterior solo vale si aparece en una mano y además
 *    llevaba un rato sin verse (tapado por el cuerpo).
 */

type Pt = { x: number; y: number };

export interface BallHint {
  /** Radio esperado del balón en píxeles de la imagen de trabajo. */
  radius: number;
  /** Último balón detectado y hace cuántos fotogramas (null si hace mucho o nunca). */
  last: (Pt & { age: number }) | null;
  hands: Pt[];
  head: Pt | null;
  feet: Pt[];
}

export interface BallHit extends Pt {
  r: number;
  score: number;
}

interface Blob extends Pt {
  r: number;
  ratio: number;
  aspect: number;
  fill: number;
  sat: number;
}

/** Saturación si es naranja de balón (tono 5–32°, saturado, no muy oscuro); −1 si no. */
function orangeSat(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max < 60 || r !== max) return -1;
  const d = max - min;
  const s = d / max;
  if (s < 0.42) return -1;
  const h = ((g - b) / d) * 60; // r es el máximo
  return h >= 5 && h <= 32 ? s : -1;
}

let mask = new Uint8Array(0);
let sats = new Float32Array(0);
let stack = new Int32Array(0);

function findBlobs(img: ImageData, radius: number): Blob[] {
  const { width: W, height: H, data } = img;
  if (mask.length < W * H) {
    mask = new Uint8Array(W * H);
    sats = new Float32Array(W * H);
    stack = new Int32Array(W * H);
  } else mask.fill(0, 0, W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const s = orangeSat(data[p]!, data[p + 1]!, data[p + 2]!);
    if (s >= 0) {
      mask[i] = 1;
      sats[i] = s;
    }
  }
  const expectedArea = Math.PI * radius * radius;
  const blobs: Blob[] = [];
  for (let start = 0; start < W * H; start++) {
    if (mask[start] !== 1) continue;
    let n = 0;
    let sx = 0;
    let sy = 0;
    let ss = 0;
    let x0 = W;
    let x1 = 0;
    let y0 = H;
    let y1 = 0;
    let top = 0;
    stack[top++] = start;
    mask[start] = 2;
    while (top > 0) {
      const i = stack[--top]!;
      const x = i % W;
      const y = (i / W) | 0;
      n++;
      sx += x;
      sy += y;
      ss += sats[i]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && mask[i - 1] === 1) (mask[i - 1] = 2), (stack[top++] = i - 1);
      if (x < W - 1 && mask[i + 1] === 1) (mask[i + 1] = 2), (stack[top++] = i + 1);
      if (y > 0 && mask[i - W] === 1) (mask[i - W] = 2), (stack[top++] = i - W);
      if (y < H - 1 && mask[i + W] === 1) (mask[i + W] = 2), (stack[top++] = i + W);
    }
    // Tamaño: entre 0,2× y 2,5× el área esperada (desenfoque de movimiento, la mano tapando parte).
    const ratio = n / expectedArea;
    if (ratio < 0.2 || ratio > 2.5 || n < 6) continue;
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    const aspect = Math.min(bw, bh) / Math.max(bw, bh);
    const fill = n / (bw * bh); // círculo ≈ 0,785
    if (aspect < 0.4 || fill < 0.35) continue;
    blobs.push({ x: sx / n, y: sy / n, r: Math.sqrt(n / Math.PI), ratio, aspect, fill, sat: ss / n });
  }
  return blobs;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

export function detectBall(img: ImageData, hint: BallHint): BallHit | null {
  const R = hint.radius;
  let best: BallHit | null = null;
  for (const b of findBlobs(img, R)) {
    const shape = (1 - b.aspect) * 2 + Math.abs(Math.log(b.ratio)) + Math.abs(b.fill - 0.78) * 2;
    const color = Math.max(0, 0.68 - b.sat) * 10;
    const toHand = Math.min(Infinity, ...hint.hands.map((h) => dist(h, b) / R));
    const toLast = hint.last ? dist(hint.last, b) / R : Infinity;
    // Lo que puede recorrer el balón desde la última vez (≈ 2,5 radios por fotograma a 60 fps).
    const reach = hint.last ? 3 + hint.last.age * 2.5 : 0;
    const continues = toLast <= reach;
    const nearHead = hint.head ? dist(hint.head, b) / R < 3 : false;
    const nearFoot = hint.feet.some((f) => dist(f, b) / R < 1.8);
    if (nearHead && (toHand > 2.2 || (hint.last && !continues))) continue;
    if (nearFoot && !continues) continue;
    if (hint.last && !continues && (toHand > 2.5 || hint.last.age < 6)) continue;
    const proximity = hint.last ? Math.min(toLast, toHand) : Math.min(toHand, 8);
    const score = shape + color + proximity * 0.4;
    if (!best || score < best.score) best = { x: b.x, y: b.y, r: b.r, score };
  }
  return best;
}
