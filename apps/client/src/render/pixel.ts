import type * as THREE from 'three';

/** Lado corto interno objetivo en píxeles "gordos". Menos = más pixelado. */
const TARGET_SHORT_SIDE = 200;

export interface PixelView {
  scale: number;
  width: number;
  height: number;
}

/** Escala automática según el lado corto de la pantalla (mínimo 2 para que siempre se vea pixelado). */
export function autoScale(): number {
  const shortSide = Math.min(window.innerWidth, window.innerHeight);
  return Math.max(2, Math.round(shortSide / TARGET_SHORT_SIDE));
}

/**
 * El búfer del canvas se crea a 1/scale de la resolución CSS y el navegador
 * lo amplía con `image-rendering: pixelated`. Barato en GPU y da el look pixel.
 */
export function applyPixelSize(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, scale: number): PixelView {
  const width = Math.max(1, Math.ceil(window.innerWidth / scale));
  const height = Math.max(1, Math.ceil(window.innerHeight / scale));
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  return { scale, width, height };
}
