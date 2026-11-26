import * as THREE from 'three';

/** Rampa de 3 tonos con filtrado nearest: sombreado en bandas tipo cartoon. */
const gradientMap = (() => {
  const tex = new THREE.DataTexture(new Uint8Array([90, 175, 255]), 3, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
})();

const cache = new Map<number, THREE.MeshToonMaterial>();

export function toonMaterial(color: number): THREE.MeshToonMaterial {
  let m = cache.get(color);
  if (!m) {
    m = new THREE.MeshToonMaterial({ color, gradientMap });
    cache.set(color, m);
  }
  return m;
}

/** Material blanco para InstancedMesh: el color va por instancia. */
export function toonInstancedMaterial(): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap });
}

/** Contorno por "casco invertido": una copia algo mayor renderizada por dentro. */
export const outlineMaterial = new THREE.MeshBasicMaterial({ color: 0x14101c, side: THREE.BackSide });

/** Normales por cara (look low poly facetado): cada triángulo con su propia normal. */
export function faceted<T extends THREE.BufferGeometry>(geo: T): THREE.BufferGeometry {
  const flat = geo.index ? geo.toNonIndexed() : geo;
  flat.computeVertexNormals();
  return flat;
}

export function shade(color: number, k: number): number {
  return new THREE.Color(color).multiplyScalar(k).getHex();
}
